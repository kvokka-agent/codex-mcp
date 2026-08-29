/**
 * Reading the stdio of a codex child: the line framing both app-server clients
 * parse JSONL out of, and the stderr both forward.
 *
 * Every asserted value is what the reader returned for the chunks the test fed
 * it; only the child process it reads is stood in for.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { LineReader, readChildOutput } from "../src/app-server/child-stdio.js";

describe("LineReader", () => {
  it("returns the lines a chunk completed and holds the partial one back", () => {
    const reader = new LineReader();

    expect(reader.take(Buffer.from('{"a":1}\n{"b":'))).toEqual(['{"a":1}']);
    expect(reader.take(Buffer.from("2}\n"))).toEqual(['{"b":2}']);
  });

  it("trims each line and drops the blank ones", () => {
    const reader = new LineReader();

    expect(reader.take(Buffer.from("  one  \n\n\t\n two\n"))).toEqual(["one", "two"]);
  });

  it("holds a character split across two chunks until the chunk that finishes it", () => {
    const reader = new LineReader();
    const snowman = Buffer.from("☃\n", "utf8");

    expect(reader.take(snowman.subarray(0, 2))).toEqual([]);
    expect(reader.take(snowman.subarray(2))).toEqual(["☃"]);
  });

  it("drops the held line and the held character on reset", () => {
    const reader = new LineReader();
    const snowman = Buffer.from("half☃", "utf8");
    reader.take(snowman.subarray(0, snowman.length - 1));

    reader.reset();

    expect(reader.take(Buffer.from("whole\n"))).toEqual(["whole"]);
  });
});

describe("readChildOutput", () => {
  const restore: (() => void)[] = [];

  afterEach(() => {
    for (const undo of restore.splice(0)) undo();
  });

  function captureStderr(): string[] {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void lines.push(args.join(" "));
    restore.push(() => {
      console.error = original;
    });
    return lines;
  }

  function fakeChild(): ChildProcess {
    return { stdout: new EventEmitter(), stderr: new EventEmitter() } as unknown as ChildProcess;
  }

  it("hands every stdout chunk to the reader", () => {
    const child = fakeChild();
    const seen: string[] = [];
    readChildOutput(child, (chunk) => void seen.push(chunk.toString()), "[prefix]");

    child.stdout?.emit("data", Buffer.from("first"));
    child.stdout?.emit("data", Buffer.from("second"));

    expect(seen).toEqual(["first", "second"]);
  });

  it("puts each stderr chunk on this process's stderr under the prefix, without its trailing newline", () => {
    const lines = captureStderr();
    const child = fakeChild();
    readChildOutput(child, () => {}, "[app-server stderr]");

    child.stderr?.emit("data", Buffer.from("codex is warming up\n"));

    expect(lines).toEqual(["[app-server stderr] codex is warming up"]);
  });
});
