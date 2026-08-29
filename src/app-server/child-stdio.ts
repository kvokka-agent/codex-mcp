/**
 * Reading the stdio of a codex child process: the line framing both clients
 * parse JSONL out of, and the stderr both put on this process's stderr.
 */
import type { ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";

/**
 * Splits a child's stdout into whole lines.
 *
 * A chunk ends anywhere, including inside a multi-byte character, so both the
 * trailing partial line and the decoder's partial character are held until the
 * chunk that finishes them.
 */
export class LineReader {
  private buffer: string;
  private decoder: StringDecoder;

  // The fields are set here rather than at their declarations: bun's coverage
  // counts a field initializer as a function it never marks hit.
  constructor() {
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
  }

  /** The lines this chunk completed, trimmed, with the blank ones dropped. */
  take(chunk: Buffer): string[] {
    this.buffer += this.decoder.write(chunk);
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    const complete: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) complete.push(trimmed);
    }
    return complete;
  }

  /** Drop what is held, so the next chunk starts a stream of its own. */
  reset(): void {
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
  }
}

/** Read a child's stdout chunk by chunk and forward its stderr under `stderrPrefix`. */
export function readChildOutput(
  proc: ChildProcess,
  onStdout: (chunk: Buffer) => void,
  stderrPrefix: string
): void {
  proc.stdout!.on("data", (chunk: Buffer) => onStdout(chunk));
  proc.stderr!.on("data", (chunk: Buffer) => {
    console.error(`${stderrPrefix} ${chunk.toString().trimEnd()}`);
  });
}
