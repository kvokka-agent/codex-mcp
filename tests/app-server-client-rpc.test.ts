/**
 * JSON-RPC layer of AppServerClient: message framing, request/response
 * correlation, timeouts, server-initiated requests, write backpressure and
 * teardown.
 *
 * The child process is a stand-in driven by hand, so every asserted value is
 * one the client itself produced on its stdin or handed back to a caller.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { EventEmitter } from "node:events";
import type { AppServerSpawnOptions } from "../src/app-server/lifecycle.js";
import { Methods } from "../src/app-server/protocol.js";
import { advanceAsync } from "./helpers/clock.js";
import { mockModule } from "./helpers/mock.js";

const spawnMock = jest.fn();

const realModule1 = { ...(await import("node:child_process")) };
mockModule("child_process", realModule1, () => {
  const actual = realModule1;
  return { ...actual, spawn: spawnMock };
});

class MockStdin extends EventEmitter {
  writable = true;
  writes: string[] = [];
  writeReturn = true;
  throwOnWrite: Error | null = null;
  end = jest.fn();

  write(chunk: unknown): boolean {
    if (this.throwOnWrite) throw this.throwOnWrite;
    this.writes.push(String(chunk));
    return this.writeReturn;
  }
}

class MockProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = new MockStdin();
  killed = false;
  exitCode: number | null = null;
  pid = 4242;
  kill = jest.fn((): boolean => {
    this.killed = true;
    return true;
  });
}

interface RpcLine {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

describe("AppServerClient JSON-RPC", () => {
  let proc: MockProc;
  let killSpy: ReturnType<typeof jest.spyOn>;
  let errorLog: ReturnType<typeof jest.spyOn>;
  let AppServerClient: typeof import("../src/app-server/client.js").AppServerClient;

  beforeEach(async () => {
    proc = new MockProc();
    spawnMock.mockReset();
    spawnMock.mockReturnValue(proc);
    killSpy = jest.spyOn(process, "kill").mockImplementation(() => true);
    errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
    ({ AppServerClient } = await import("../src/app-server/client.js"));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    spawnMock.mockReset();
  });

  /** Lines the client wrote to the child's stdin, newest last. */
  function written(): RpcLine[] {
    return proc.stdin.writes
      .join("")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as RpcLine);
  }

  function lastWritten(): RpcLine {
    const lines = written();
    expect(lines.length, "nothing was written to stdin").toBeGreaterThan(0);
    return lines[lines.length - 1];
  }

  function emit(raw: string): void {
    proc.stdout.emit("data", Buffer.from(raw, "utf8"));
  }

  function reply(id: number, result: unknown): void {
    emit(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  async function startClient(): Promise<InstanceType<typeof AppServerClient>> {
    const client = new AppServerClient();
    const started = client.start({} as AppServerSpawnOptions);
    const init = lastWritten();
    expect(init.method).toBe(Methods.INITIALIZE);
    reply(init.id!, { userAgent: "mock-app-server" });
    await started;
    return client;
  }

  it("completes the initialize handshake and reports the child pid", async () => {
    const client = new AppServerClient();
    const started = client.start({} as AppServerSpawnOptions);

    const init = lastWritten();
    expect(init.method).toBe(Methods.INITIALIZE);
    expect((init.params as { clientInfo: { name: string } }).clientInfo.name).toBe("codex-mcp");

    reply(init.id!, { userAgent: "mock-app-server" });

    await expect(started).resolves.toEqual({ userAgent: "mock-app-server" });
    expect(client.childPid).toBe(4242);
    expect(client.destroyed).toBe(false);
    expect(client.supportsTurnOverrides).toBe(true);
  });

  it("opts into the experimental API in the initialize handshake", async () => {
    const client = new AppServerClient();
    const started = client.start({} as AppServerSpawnOptions);

    // Off (the schema default), codex sends neither item/tool/requestUserInput
    // nor item/plan/delta, and the session manager's handlers for both never run.
    const init = lastWritten();
    expect(init.method).toBe(Methods.INITIALIZE);
    expect((init.params as { capabilities?: { experimentalApi?: boolean } }).capabilities).toEqual({
      experimentalApi: true,
    });

    reply(init.id!, { userAgent: "mock-app-server" });
    await started;
  });

  it("reports the spawned pid before the initialize handshake is answered", async () => {
    const client = new AppServerClient();
    const spawns: Array<{ pid: number; spawnedAt: string }> = [];
    client.on("spawn", (pid: number, spawnedAt: string) => spawns.push({ pid, spawnedAt }));

    const started = client.start({} as AppServerSpawnOptions);
    // The handshake is still unanswered, so the reaper already has the pid of a
    // process whose startup outlives its identity window.
    expect(spawns.map((s) => s.pid)).toEqual([proc.pid]);
    expect(Number.isNaN(Date.parse(spawns[0]!.spawnedAt))).toBe(false);

    const init = lastWritten();
    reply(init.id!, { userAgent: "mock-app-server" });
    await started;
    expect(spawns).toHaveLength(1);
  });

  it("matches concurrent responses to their own requests", async () => {
    const client = await startClient();

    const fork = client.threadFork({ threadId: "thread_1" });
    const resume = client.threadResume({ threadId: "thread_1" });

    const [forkReq, resumeReq] = written().slice(-2);
    expect(forkReq.method).toBe(Methods.THREAD_FORK);
    expect(resumeReq.method).toBe(Methods.THREAD_RESUME);
    expect(forkReq.id).not.toBe(resumeReq.id);

    // Answer out of order: correlation must be by id, not by arrival.
    reply(resumeReq.id!, { thread: { id: "resumed" } });
    reply(forkReq.id!, { thread: { id: "forked" } });

    await expect(fork).resolves.toEqual({ thread: { id: "forked" } });
    await expect(resume).resolves.toEqual({ thread: { id: "resumed" } });
  });

  it("rejects with the error the server reported", async () => {
    const client = await startClient();

    const pending = client.turnInterrupt({ threadId: "t", turnId: "u" });
    const req = lastWritten();
    emit(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32000, message: "no such turn" },
      })}\n`
    );

    await expect(pending).rejects.toThrow("RPC error -32000: no such turn");
  });

  it("reassembles a response split across chunks", async () => {
    const client = await startClient();

    const pending = client.threadFork({ threadId: "thread_1" });
    const id = lastWritten().id!;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, result: { thread: { id: "spät€" } } });
    const bytes = Buffer.from(`${payload}\n`, "utf8");

    // Split inside the multi-byte euro sign to exercise the stream decoder.
    const cut = bytes.indexOf(Buffer.from("€", "utf8")) + 1;
    proc.stdout.emit("data", bytes.subarray(0, cut));
    proc.stdout.emit("data", bytes.subarray(cut));

    await expect(pending).resolves.toEqual({ thread: { id: "spät€" } });
  });

  it("handles a batch array and ignores non-JSON noise", async () => {
    const client = await startClient();
    const notifications: Array<{ method: string; params: unknown }> = [];
    client.onNotification((method, params) => notifications.push({ method, params }));

    const pending = client.threadFork({ threadId: "thread_1" });
    const id = lastWritten().id!;

    emit("codex is starting up...\n\n");
    emit(
      `${JSON.stringify([
        { jsonrpc: "2.0", method: "thread/started", params: { threadId: "thread_1" } },
        "not-an-object",
        { jsonrpc: "2.0", id, result: { thread: { id: "forked" } } },
      ])}\n`
    );

    await expect(pending).resolves.toEqual({ thread: { id: "forked" } });
    expect(notifications).toEqual([{ method: "thread/started", params: { threadId: "thread_1" } }]);
  });

  it("drops a response for an id nobody is waiting on", async () => {
    const client = await startClient();

    expect(() => reply(9999, { thread: { id: "ghost" } })).not.toThrow();
    expect(client.destroyed).toBe(false);
  });

  it("ignores a notification while no handler is registered", async () => {
    await startClient();

    expect(() =>
      emit(`${JSON.stringify({ jsonrpc: "2.0", method: "thread/started", params: {} })}\n`)
    ).not.toThrow();
  });

  it("times out a request that is never answered", async () => {
    const client = await startClient();

    await expect(client.threadStart({ cwd: "/work" }, 15)).rejects.toThrow(
      `Request ${Methods.THREAD_START} timed out after 15ms`
    );
  });

  it("forwards a server-initiated request and writes the answer back", async () => {
    const client = await startClient();
    const seen: Array<[number | string, string, unknown]> = [];
    client.onServerRequest((id, method, params) => seen.push([id, method, params]));

    emit(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 77,
        method: Methods.COMMAND_APPROVAL,
        params: { itemId: "item_1" },
      })}\n`
    );

    expect(seen).toEqual([[77, Methods.COMMAND_APPROVAL, { itemId: "item_1" }]]);

    client.respondToServer(77, { decision: "accept" });
    expect(lastWritten()).toEqual({ jsonrpc: "2.0", id: 77, result: { decision: "accept" } });

    client.respondErrorToServer(78, -32000, "nope");
    expect(lastWritten()).toEqual({
      jsonrpc: "2.0",
      id: 78,
      error: { code: -32000, message: "nope" },
    });
  });

  it("answers an unhandled server request with method-not-found", async () => {
    await startClient();

    emit(`${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "item/tool/unknown" })}\n`);

    expect(lastWritten()).toEqual({
      jsonrpc: "2.0",
      id: 5,
      error: { code: -32601, message: "Method not handled: item/tool/unknown" },
    });
  });

  it("throws when a response to a server request cannot be written", async () => {
    const client = await startClient();
    proc.stdin.writes.length = 0;
    proc.stdin.writable = false;

    expect(() => client.respondToServer(1, { decision: "accept" })).toThrow(
      /Failed to send JSON-RPC response for server request id=1: .*stdin not writable/
    );
    expect(() => client.respondErrorToServer(1, -1, "x")).toThrow(
      /Failed to send JSON-RPC error response for server request id=1/
    );
    expect(proc.stdin.writes).toEqual([]);
  });

  it("throws the queue-overflow failure out of a response the backpressured child dropped", async () => {
    const client = await startClient();
    // Backpressure: every further write is queued rather than handed to stdin.
    proc.stdin.writeReturn = false;
    client.respondToServer(1, { decision: "decline" });
    proc.stdin.writes.length = 0;

    // Fill the 5MB queue, then the response that no longer fits.
    const filler = { jsonrpc: "2.0", id: 2, result: { pad: "x".repeat(6 * 1024 * 1024) } };
    expect(() => client.respondToServer(2, filler.result)).toThrow(/WRITE_QUEUE_DROPPED/);
    expect(proc.stdin.writes).toEqual([]);
  });

  it("keeps reading stdout after a server-request handler throws", async () => {
    const client = await startClient();
    const seen: string[] = [];
    client.onNotification((method) => seen.push(method));
    client.onServerRequest(() => {
      throw new Error("handler exploded");
    });

    emit(
      JSON.stringify({ jsonrpc: "2.0", id: 9, method: Methods.COMMAND_APPROVAL, params: {} }) +
        "\n" +
        JSON.stringify({ jsonrpc: "2.0", method: Methods.TURN_STARTED, params: {} }) +
        "\n"
    );

    // The throwing handler is reported as a handler failure, not as a protocol
    // parse error, and the child stays alive to deliver the next line.
    const logged = errorLog.mock.calls.flat().join(" ");
    expect(logged).toContain("handler exploded");
    expect(logged).not.toContain("PROTOCOL_PARSE_ERROR");
    expect(seen).toEqual([Methods.TURN_STARTED]);
    expect(client.destroyed).toBe(false);
  });

  it("tears down the child after an unparsable protocol line", async () => {
    const client = await startClient();
    const pending = client.threadFork({ threadId: "thread_1" });

    emit("{not json at all\n");

    await expect(pending).rejects.toThrow("PROTOCOL_PARSE_ERROR");
    await expect(pending).rejects.toThrow("failed to parse JSON line");
    if (process.platform !== "win32") {
      expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
    }
  });

  it("relays the stderr of the child", async () => {
    await startClient();

    proc.stderr.emit("data", Buffer.from("boot warning\n", "utf8"));

    expect(errorLog.mock.calls.flat().join(" ")).toContain("[app-server stderr] boot warning");
  });

  it("fails pending requests when the child exits and re-emits the exit", async () => {
    const client = await startClient();
    const exits: Array<[number | null, string | null]> = [];
    client.on("exit", (code: number | null, signal: string | null) => exits.push([code, signal]));

    const pending = client.threadFork({ threadId: "thread_1" });
    proc.emit("exit", 3, null);

    await expect(pending).rejects.toThrow("app-server exited (code: 3, signal: null)");
    expect(exits).toEqual([[3, null]]);
  });

  it("fails pending requests when stdin errors", async () => {
    const client = await startClient();
    const pending = client.threadFork({ threadId: "thread_1" });

    proc.stdin.emit("error", new Error("EPIPE"));

    await expect(pending).rejects.toThrow("EPIPE");
  });

  it("reports the recorded failure on later requests once stdin closed", async () => {
    const client = await startClient();

    proc.stdin.writable = false;
    proc.stdin.emit("close");

    await expect(client.threadFork({ threadId: "thread_1" })).rejects.toThrow(
      "app-server stdin closed"
    );
  });

  it("refuses to send once the client is destroyed", async () => {
    const client = await startClient();
    proc.exitCode = 0;
    await client.destroy();

    expect(client.destroyed).toBe(true);
    await expect(client.threadFork({ threadId: "thread_1" })).rejects.toThrow("Client destroyed");
  });

  it("rejects requests still in flight when destroy is called", async () => {
    const client = await startClient();
    const pending = client.threadFork({ threadId: "thread_1" });

    const destroying = client.destroy();
    proc.emit("exit", 0, null);
    await destroying;

    await expect(pending).rejects.toThrow("Client destroyed");
    expect(proc.stdin.end).toHaveBeenCalled();
    if (process.platform !== "win32") {
      expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
    }
  });

  it("is idempotent on repeated destroy calls", async () => {
    const client = await startClient();
    proc.exitCode = 0;

    await client.destroy();
    const killsAfterFirst = killSpy.mock.calls.length;
    await client.destroy();

    expect(killSpy.mock.calls.length).toBe(killsAfterFirst);
  });

  it("falls back to a direct kill when the process group cannot be signalled", async () => {
    const client = await startClient();
    killSpy.mockImplementation(() => {
      throw new Error("ESRCH");
    });
    proc.exitCode = 0;

    await client.destroy();

    if (process.platform !== "win32") {
      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
      expect(errorLog.mock.calls.flat().join(" ")).toContain(
        "Failed to kill detached process group"
      );
    }
  });

  it("rejects the request when the write itself throws", async () => {
    const client = await startClient();
    proc.stdin.throwOnWrite = new Error("stream exploded");

    await expect(client.threadFork({ threadId: "thread_1" })).rejects.toThrow("stream exploded");
  });

  it("queues writes under backpressure and flushes them on drain", async () => {
    const client = await startClient();
    const before = written().length;

    proc.stdin.writeReturn = false;
    void client.threadFork({ threadId: "thread_1" });
    expect(written()).toHaveLength(before + 1);

    // Now the client is in backpressure: further payloads must be queued, not written.
    void client.threadResume({ threadId: "thread_1" });
    void client.turnInterrupt({ threadId: "thread_1", turnId: "turn_1" });
    expect(written()).toHaveLength(before + 1);

    proc.stdin.writeReturn = true;
    proc.stdin.emit("drain");

    const flushed = written().slice(before + 1);
    expect(flushed.map((line) => line.method)).toEqual([
      Methods.THREAD_RESUME,
      Methods.TURN_INTERRUPT,
    ]);
  });

  it("drops the queue and terminates when it grows past the limit", async () => {
    const client = await startClient();
    proc.stdin.writeReturn = false;
    const queued = client.threadFork({ threadId: "thread_1" });
    reply(lastWritten().id!, { thread: { id: "forked" } });
    await queued;

    const oversized = client.threadStart({ cwd: "x".repeat(6 * 1024 * 1024) }, 1000);

    await expect(oversized).rejects.toThrow("WRITE_QUEUE_DROPPED");
    await expect(oversized).rejects.toThrow("write queue exceeded limit");
    if (process.platform !== "win32") {
      expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
    }

    // The dropped queue must not be flushed later.
    const before = written().length;
    proc.stdin.writeReturn = true;
    proc.stdin.emit("drain");
    expect(written()).toHaveLength(before);
  });

  it("fails queued requests when stdin dies before the flush", async () => {
    const client = await startClient();
    proc.stdin.writeReturn = false;
    const inFlight = client.threadFork({ threadId: "thread_1" });
    const queuedRequest = client.threadResume({ threadId: "thread_1" });
    // The drain below rejects both, and the assertions come after it: without a
    // handler already on each promise the rejection is an unhandled one, which
    // the runner reports against whichever test is running.
    const settled = Promise.allSettled([inFlight, queuedRequest]);

    proc.stdin.writable = false;
    proc.stdin.emit("drain");
    await settled;

    await expect(queuedRequest).rejects.toThrow("WRITE_QUEUE_DROPPED");
    await expect(queuedRequest).rejects.toThrow("stdin is not writable while flushing");
    // The already-written request fails with the same cause.
    await expect(inFlight).rejects.toThrow("WRITE_QUEUE_DROPPED");
  });

  it("fails queued requests when the flush write throws", async () => {
    const client = await startClient();
    proc.stdin.writeReturn = false;
    const inFlight = client.threadFork({ threadId: "thread_1" });
    const queuedRequest = client.threadResume({ threadId: "thread_1" });
    const settled = Promise.allSettled([inFlight, queuedRequest]);

    proc.stdin.throwOnWrite = new Error("stream exploded mid-flush");
    proc.stdin.emit("drain");
    await settled;

    await expect(queuedRequest).rejects.toThrow("stream exploded mid-flush");
    await expect(inFlight).rejects.toThrow("stream exploded mid-flush");
  });

  it("refuses to send before the process is started", async () => {
    const client = new AppServerClient();

    await expect(client.threadFork({ threadId: "thread_1" })).rejects.toThrow(
      "app-server is not running (stdin not writable)"
    );
    expect(client.childPid).toBeUndefined();
  });

  it("throws when a server response is attempted before the process exists", () => {
    const client = new AppServerClient();

    expect(() => client.respondToServer(1, {})).toThrow("app-server process not started");
  });

  it("re-emits a spawn error and fails what was in flight", async () => {
    const client = await startClient();
    const seen: Error[] = [];
    client.on("error", (err: Error) => seen.push(err));
    const pending = client.threadFork({ threadId: "thread_1" });

    proc.emit("error", new Error("ENOENT codex"));

    await expect(pending).rejects.toThrow("ENOENT codex");
    expect(seen.map((e) => e.message)).toEqual(["ENOENT codex"]);
  });

  it("carries the turn and background-terminal calls over the same channel", async () => {
    const client = await startClient();

    const turn = client.turnStart({ threadId: "t", input: [{ type: "text", text: "hi" }] });
    const turnReq = lastWritten();
    expect(turnReq.method).toBe(Methods.TURN_START);
    reply(turnReq.id!, { turn: { id: "turn_1" } });
    await expect(turn).resolves.toEqual({ turn: { id: "turn_1" } });

    const clean = client.threadBackgroundTerminalsClean({ threadId: "t" });
    const cleanReq = lastWritten();
    expect(cleanReq.method).toBe(Methods.THREAD_BACKGROUND_TERMINALS_CLEAN);
    expect(cleanReq.params).toEqual({ threadId: "t" });
    reply(cleanReq.id!, {});
    await expect(clean).resolves.toEqual({});
  });

  it("stops flushing as soon as the stream signals backpressure again", async () => {
    const client = await startClient();
    const before = written().length;

    proc.stdin.writeReturn = false;
    void client.threadFork({ threadId: "thread_1" });
    void client.threadResume({ threadId: "thread_1" });
    void client.turnInterrupt({ threadId: "thread_1", turnId: "turn_1" });

    // The stream stays saturated: the drain flushes one payload and stops.
    proc.stdin.emit("drain");

    const flushed = written().slice(before + 1);
    expect(flushed.map((line) => line.method)).toEqual([Methods.THREAD_RESUME]);

    proc.stdin.writeReturn = true;
    proc.stdin.emit("drain");
    expect(
      written()
        .slice(before + 1)
        .map((line) => line.method)
    ).toEqual([Methods.THREAD_RESUME, Methods.TURN_INTERRUPT]);
  });

  it("does not terminate on a drain with nothing queued", async () => {
    await startClient();
    proc.stdin.writable = false;
    killSpy.mockClear();

    proc.stdin.emit("drain");

    expect(killSpy).not.toHaveBeenCalled();
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("escalates to SIGKILL when the child outlives the grace period", async () => {
    const client = await startClient();
    jest.useFakeTimers();

    const destroying = client.destroy();
    await advanceAsync(5000);

    if (process.platform !== "win32") {
      expect(killSpy).toHaveBeenCalledWith(-4242, "SIGKILL");
    }

    proc.emit("exit", 0, null);
    await destroying;
    jest.useRealTimers();
  });

  it("logs when even the direct kill fails", async () => {
    const client = await startClient();
    killSpy.mockImplementation(() => {
      throw new Error("ESRCH");
    });
    proc.kill.mockImplementation(() => {
      throw new Error("already reaped");
    });
    proc.exitCode = 0;

    await client.destroy();

    expect(errorLog.mock.calls.flat().join(" ")).toContain(
      "Failed to send SIGTERM to app-server process"
    );
  });
});
