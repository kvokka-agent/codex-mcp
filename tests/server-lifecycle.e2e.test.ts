/**
 * What a codex-mcp process does with its own lifetime and its own state
 * directory, measured on the built server rather than on an import of it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerProcess } from "./helpers/server-harness.js";

const servers: ServerProcess[] = [];
const strays: ChildProcess[] = [];

function startServer(stateDir?: string): ServerProcess {
  const server = new ServerProcess(stateDir ? { stateDir } : {});
  servers.push(server);
  return server;
}

function freshStateDir(): string {
  return mkdtempSync(join(tmpdir(), "codex-mcp-state-"));
}

function sessionDir(stateDir: string, sessionId: string): string {
  return join(stateDir, "sessions", sessionId);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

/** A process that outlives its parent and ignores SIGTERM, as a wedged orphan does. */
function spawnStubbornChild(): ChildProcess {
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1e9);"],
    { detached: true, stdio: "ignore" }
  );
  child.unref();
  strays.push(child);
  return child;
}

async function pollUntil<T>(
  read: () => Promise<T> | T,
  accept: (value: T) => boolean,
  timeoutMs = 10_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await read();
  while (Date.now() < deadline) {
    if (accept(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
    last = await read();
  }
  throw new Error(`condition never held; last value: ${JSON.stringify(last)}`);
}

afterEach(async () => {
  while (servers.length) await servers.pop()!.dispose();
  while (strays.length) {
    const stray = strays.pop()!;
    try {
      if (stray.pid) process.kill(-stray.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

describe("startup", () => {
  it("serves MCP while an orphan of a dead owner is still being reaped", async () => {
    const stateDir = freshStateDir();
    const orphan = spawnStubbornChild();
    const dir = sessionDir(stateDir, "sess_orphaned");
    mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    // No schemaVersion: the scanner reads a meta.json that carries none, so this
    // fixture is the same session whichever schema version the code holds.
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        sessionId: "sess_orphaned",
        status: "running",
        createdAt: at,
        lastActiveAt: at,
      })
    );
    writeFileSync(
      join(dir, "pid.json"),
      JSON.stringify({ pid: orphan.pid, spawnedAt: at, command: "fake-codex app-server" })
    );

    const server = startServer(stateDir);
    await server.initialize();
    const listed = await server.callTool("codex_session", { action: "list" });
    expect((listed.sessions as Array<{ sessionId: string }>).map((s) => s.sessionId)).toContain(
      "sess_orphaned"
    );
  }, 40_000);
});

describe("shutdown", () => {
  it("exits when its client closes stdin while a turn is still running", async () => {
    const server = startServer();
    await server.initialize();
    const started = await server.callTool("codex", {
      prompt: "ACTIVITY=Waiting-forever HANG",
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    await pollUntil(
      () => server.callTool("codex_check", { action: "poll", sessionId: started.sessionId }),
      (state) => state.status === "running"
    );

    server.endStdin();
    const exit = await server.waitForExit(25_000);
    expect(exit.code).toBe(0);
  }, 60_000);

  it("hands a cut-off session back as abandoned and gives up its ownership", async () => {
    const stateDir = freshStateDir();
    const server = startServer(stateDir);
    await server.initialize();
    const started = await server.callTool("codex", {
      prompt: "ACTIVITY=Rebuilding-the-index HANG",
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const sessionId = started.sessionId as string;
    await pollUntil(
      () => server.callTool("codex_check", { action: "poll", sessionId }),
      (state) => state.status === "running"
    );

    server.killClientEnd();
    const exit = await server.waitForExit(25_000);
    expect(exit.code).toBe(0);

    const meta = readJson(join(sessionDir(stateDir, sessionId), "meta.json"));
    expect(meta.status).toBe("abandoned");
    expect(existsSync(join(sessionDir(stateDir, sessionId), "owner.json"))).toBe(false);
  }, 60_000);
});

describe("session metadata", () => {
  it("writes threadId to meta.json while the first turn is still running", async () => {
    const stateDir = freshStateDir();
    const server = startServer(stateDir);
    await server.initialize();
    const started = await server.callTool("codex", {
      prompt: "ACTIVITY=Counting-the-files HANG",
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const sessionId = started.sessionId as string;
    const threadId = started.threadId as string;
    expect(threadId).toMatch(/^thr_/);

    const meta = await pollUntil(
      () => readJson(join(sessionDir(stateDir, sessionId), "meta.json")),
      (value) => value.threadId !== undefined,
      5_000
    );
    expect(meta.threadId).toBe(threadId);
    expect(meta.status).toBe("running");
  }, 40_000);
});

describe("two servers on one state directory", () => {
  it("both persist their own sessions and each sees the other's", async () => {
    const stateDir = freshStateDir();
    const first = startServer(stateDir);
    const second = startServer(stateDir);
    await first.initialize();
    await second.initialize();

    const args = {
      cwd: process.cwd(),
      approvalPolicy: "never" as const,
      sandbox: "read-only" as const,
    };
    const one = await first.callTool("codex", { ...args, prompt: "ACTIVITY=First-task HANG" });
    const two = await second.callTool("codex", { ...args, prompt: "ACTIVITY=Second-task HANG" });
    const idOne = one.sessionId as string;
    const idTwo = two.sessionId as string;

    expect(existsSync(join(sessionDir(stateDir, idOne), "meta.json"))).toBe(true);
    expect(existsSync(join(sessionDir(stateDir, idTwo), "meta.json"))).toBe(true);

    const listed = await pollUntil(
      () => first.callTool("codex_session", { action: "list" }),
      (value) =>
        (value.sessions as Array<{ sessionId: string }>).some((s) => s.sessionId === idTwo),
      10_000
    );
    const sessions = listed.sessions as Array<{
      sessionId: string;
      owner?: { pid: number; state: string };
    }>;
    const mine = sessions.find((s) => s.sessionId === idOne)!;
    const theirs = sessions.find((s) => s.sessionId === idTwo)!;
    expect(mine.owner).toEqual({ pid: first.pid, state: "self" });
    expect(theirs.owner).toEqual({ pid: second.pid, state: "other" });
  }, 60_000);

  it("adopts the sessions of a dead owner and leaves a live owner's alone", async () => {
    const stateDir = freshStateDir();
    const dying = startServer(stateDir);
    const living = startServer(stateDir);
    await dying.initialize();
    await living.initialize();

    const args = {
      cwd: process.cwd(),
      approvalPolicy: "never" as const,
      sandbox: "read-only" as const,
    };
    const lost = await dying.callTool("codex", { ...args, prompt: "ACTIVITY=Подсчёт-файлов HANG" });
    const held = await living.callTool("codex", { ...args, prompt: "ACTIVITY=Held-work HANG" });
    const lostId = lost.sessionId as string;
    const heldId = held.sessionId as string;
    await pollUntil(
      () => readJson(join(sessionDir(stateDir, lostId), "meta.json")),
      (value) => value.threadId !== undefined,
      5_000
    );

    dying.child.kill("SIGKILL");
    await dying.waitForExit(5_000);

    const successor = startServer(stateDir);
    await successor.initialize();
    const listed = (await successor.callTool("codex_session", { action: "list" }))
      .sessions as Array<{
      sessionId: string;
      status: string;
      activity?: string;
      owner?: { pid: number; state: string };
    }>;

    const adopted = listed.find((s) => s.sessionId === lostId)!;
    expect(adopted.status).toBe("abandoned");
    expect(adopted.activity).toBe("Подсчёт-файлов");
    expect(adopted.owner).toBeUndefined();
    expect(existsSync(join(sessionDir(stateDir, lostId), "owner.json"))).toBe(false);

    const untouched = listed.find((s) => s.sessionId === heldId)!;
    expect(untouched.owner).toEqual({ pid: living.pid, state: "other" });
    expect(untouched.status).toBe("running");
    expect(readJson(join(sessionDir(stateDir, heldId), "owner.json")).pid).toBe(living.pid);
  }, 90_000);

  it("resumes an abandoned session and carries the thread on", async () => {
    const stateDir = freshStateDir();
    const dying = startServer(stateDir);
    await dying.initialize();
    const lost = await dying.callTool("codex", {
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "read-only",
      prompt: "ACTIVITY=Первый-виток HANG",
    });
    const sessionId = lost.sessionId as string;
    const threadId = lost.threadId as string;
    await pollUntil(
      () => readJson(join(sessionDir(stateDir, sessionId), "meta.json")),
      (value) => value.threadId !== undefined,
      5_000
    );
    dying.child.kill("SIGKILL");
    await dying.waitForExit(5_000);

    const successor = startServer(stateDir);
    await successor.initialize();
    const resumed = await successor.callTool("codex_session", { action: "resume", sessionId });
    expect(resumed.threadId).toBe(threadId);
    expect(resumed.status).toBe("idle");
    expect(readJson(join(sessionDir(stateDir, sessionId), "owner.json")).pid).toBe(successor.pid);

    await successor.callTool("codex_reply", { sessionId, prompt: "carry on" });
    const finished = await pollUntil(
      () => successor.callTool("codex_check", { action: "poll", sessionId }),
      (value) => value.status === "idle"
    );
    expect((finished.result as { text: string }).text).toBe("FAKE ANSWER: carry on");
  }, 90_000);
});
