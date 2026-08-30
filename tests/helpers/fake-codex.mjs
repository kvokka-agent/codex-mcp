#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
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
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
    index = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
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

/**
 * The settings block every thread response carries. The real app-server answers
 * what the thread ended up running with; this one answers the same values every
 * time, so a test reads a fixed answer rather than its own request echoed back.
 */
const THREAD_SETTINGS = {
  model: "fake-default-model",
  modelProvider: "fake-provider",
  approvalPolicy: "on-request",
  sandbox: { type: "workspaceWrite", networkAccess: false },
  reasoningEffort: "medium",
};

function threadReply(id) {
  return { ...THREAD_SETTINGS, cwd: process.cwd(), thread: { id, status: { type: "idle" } } };
}

function startThread(msg) {
  threadId = `thr_${randomUUID()}`;
  reply(msg.id, threadReply(threadId));
  notify("thread/started", { threadId, thread: { id: threadId, status: { type: "idle" } } });
}

function resumeThread(msg) {
  threadId = msg.params?.threadId ?? threadId;
  reply(msg.id, threadReply(threadId));
  notify("thread/started", { threadId, thread: { id: threadId, status: { type: "idle" } } });
}

function forkThread(msg) {
  const forked = `thr_${randomUUID()}`;
  reply(msg.id, threadReply(forked));
}

function interruptTurn(msg) {
  reply(msg.id, {});
  if (activeTurnId) {
    completeTurn(activeTurnId, "interrupted", "");
  }
}

const METHODS = {
  initialize: (msg) => reply(msg.id, { userAgent: "fake-codex/1.0" }),
  "thread/start": startThread,
  "thread/resume": resumeThread,
  "thread/fork": forkThread,
  "turn/start": startTurn,
  "turn/interrupt": interruptTurn,
};

function handle(msg) {
  const method = METHODS[msg.method];
  if (method) {
    method(msg);
    return;
  }
  send({
    jsonrpc: "2.0",
    id: msg.id,
    error: { code: -32601, message: `fake-codex: no method ${msg.method}` },
  });
}

function promptText(params) {
  const input = Array.isArray(params?.input) ? params.input : [];
  return input
    .filter((item) => item?.type === "text")
    .map((item) => item.text)
    .join(" ");
}

function activityOf(prompt) {
  return /ACTIVITY=([^\s]+)/.exec(prompt)?.[1] ?? "Reading the request";
}

function startTurn(msg) {
  const turnId = `turn_${++turnCounter}`;
  activeTurnId = turnId;
  reply(msg.id, { turn: { id: turnId, status: "in_progress" } });
  notify("turn/started", { threadId, turn: { id: turnId, status: "in_progress" } });

  const prompt = promptText(msg.params);
  // The scanner reads the marker out of the delta stream, so it arrives the way
  // a model emits it: split across deltas.
  for (const delta of [`%%%ACTIVITY: ${activityOf(prompt)}`, "%%%\n"]) {
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
