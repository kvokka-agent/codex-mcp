#!/usr/bin/env node
/**
 * A codex app-server stand-in for the end-to-end tests.
 *
 * It speaks the subset of the JSON-RPC wire format the server drives: the
 * initialize handshake, thread/start, thread/resume, turn/start,
 * turn/interrupt, and the notifications a turn produces. What the turn does is
 * chosen by the prompt: a prompt holding HANG never completes, so a test can
 * cut the client while a turn is running.
 *
 * `--help` answers so the app-server probe of detect.ts reads as supported.
 */
import process from "node:process";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers";

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write("Usage: fake-codex app-server\n");
  process.exit(0);
}
if (argv[0] !== "app-server") {
  process.stderr.write(`fake-codex: unsupported command ${argv[0] ?? "<none>"}\n`);
  process.exit(2);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

/** The thread this process holds, whether it started it or resumed one. */
let threadId = null;
let turnCounter = 0;
let activeTurnId = null;

function handle(msg) {
  switch (msg.method) {
    case "initialize":
      reply(msg.id, { userAgent: "fake-codex/1.0" });
      return;
    case "thread/start":
      threadId = `thr_${randomUUID()}`;
      reply(msg.id, { thread: { id: threadId, status: { type: "idle" } } });
      notify("thread/started", { threadId, thread: { id: threadId, status: { type: "idle" } } });
      return;
    case "thread/resume":
      threadId = msg.params?.threadId ?? threadId;
      reply(msg.id, { thread: { id: threadId, status: { type: "idle" } } });
      notify("thread/started", { threadId, thread: { id: threadId, status: { type: "idle" } } });
      return;
    case "thread/fork": {
      const forked = `thr_${randomUUID()}`;
      reply(msg.id, { thread: { id: forked, status: { type: "idle" } } });
      return;
    }
    case "turn/start":
      startTurn(msg);
      return;
    case "turn/interrupt":
      reply(msg.id, {});
      if (activeTurnId) {
        completeTurn(activeTurnId, "interrupted", "");
      }
      return;
    default:
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `fake-codex: no method ${msg.method}` },
      });
  }
}

function promptText(params) {
  const input = Array.isArray(params?.input) ? params.input : [];
  return input
    .filter((item) => item?.type === "text")
    .map((item) => item.text)
    .join(" ");
}

function startTurn(msg) {
  const turnId = `turn_${++turnCounter}`;
  activeTurnId = turnId;
  reply(msg.id, { turn: { id: turnId, status: "in_progress" } });
  notify("turn/started", { threadId, turn: { id: turnId, status: "in_progress" } });

  const prompt = promptText(msg.params);
  const activity = /ACTIVITY=([^\s]+)/.exec(prompt)?.[1] ?? "Reading the request";
  // The scanner reads the marker out of the delta stream, so it arrives the way
  // a model emits it: split across deltas.
  for (const delta of [`%%%ACTIVITY: ${activity}`, "%%%\n"]) {
    notify("item/agentMessage/delta", { threadId, turnId, itemId: "item_0", delta });
  }

  if (prompt.includes("HANG")) return; // the turn never finishes

  setTimeout(() => completeTurn(turnId, "completed", `FAKE ANSWER: ${prompt}`), 50);
}

function completeTurn(turnId, status, text) {
  if (activeTurnId !== turnId) return;
  activeTurnId = null;
  notify("item/completed", {
    threadId,
    turnId,
    item: { id: "item_0", type: "agentMessage", text },
  });
  notify("turn/completed", { threadId, turn: { id: turnId, status, items: [] } });
  notify("thread/status/changed", { threadId, status: { type: "idle" } });
}
