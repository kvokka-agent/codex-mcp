/**
 * The activity marker: extraction from the delta stream, removal from the
 * result, and the line a poll reports.
 *
 * Every asserted value comes out of the code under test — the scanner is fed
 * the same string a real stream carries, cut the way real deltas cut it, and the
 * session tests run a real SessionManager with a real disk log behind a
 * stand-in client.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppServerClient } from "../src/app-server/client.js";
import { Methods } from "../src/app-server/protocol.js";
import {
  ACTIVITY_MARKER_INSTRUCTION,
  ActivityMarkerScanner,
  composeDeveloperInstructions,
  MAX_ACTIVITY_LENGTH,
  stripActivityMarkers,
  stripActivityMarkersFromTurn,
} from "../src/session/activity-marker.js";
import { SessionManager } from "../src/session/manager/session-manager.js";
import { SessionPersistence } from "../src/session/persistence.js";
import type { CheckResult } from "../src/types.js";

/** Feed a whole message through the scanner, cut into chunks of `size` characters. */
function scanInChunks(text: string, size: number): string[] {
  const scanner = new ActivityMarkerScanner();
  const found: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    found.push(...scanner.push(text.slice(i, i + size)));
  }
  return found;
}

/** Feed a whole message through the scanner, cut at one chosen boundary. */
function scanSplitAt(text: string, at: number): string[] {
  const scanner = new ActivityMarkerScanner();
  return [...scanner.push(text.slice(0, at)), ...scanner.push(text.slice(at))];
}

describe("ActivityMarkerScanner", () => {
  it("reports the marker whole however the stream cut it", () => {
    const text = "%%%ACTIVITY: Разбираю падение теста в session-manager%%%\nСмотрю лог.";

    // Every boundary, including the ones inside the opening and closing `%%%`.
    for (let at = 0; at <= text.length; at++) {
      expect(scanSplitAt(text, at), `split at ${at}`).toEqual([
        "Разбираю падение теста в session-manager",
      ]);
    }
  });

  it("reports the marker whole when every delta is one character", () => {
    const text = "Начинаю.%%%ACTIVITY: Читаю src/session/manager.ts%%%\nдальше";
    expect(scanInChunks(text, 1)).toEqual(["Читаю src/session/manager.ts"]);
  });

  it("reports the marker whole at every chunk size a real stream produces", () => {
    const text = "%%%ACTIVITY: Считаю файлы в src%%%\nтекст";
    for (let size = 1; size <= 12; size++) {
      expect(scanInChunks(text, size), `chunk size ${size}`).toEqual(["Считаю файлы в src"]);
    }
  });

  it("reports the deltas a live codex actually sent", () => {
    // Captured verbatim from `codex app-server` 0.149.1 on this instruction: the
    // opener arrived whole, the closing sentinel arrived as "%%" + "%\n".
    const deltas = [
      "%%%",
      "ACT",
      "IVITY",
      ":",
      " Под",
      "с",
      "читы",
      "ваю",
      " фай",
      "лы",
      " Type",
      "Script",
      " в",
      " src",
      "/",
      "%%",
      "%\n",
      "С",
      "начала",
      " получ",
      "у",
      " точ",
      "ный",
      " список",
      " файлов",
      ".",
    ];
    const scanner = new ActivityMarkerScanner();
    const found = deltas.flatMap((delta) => scanner.push(delta));
    expect(found).toEqual(["Подсчитываю файлы TypeScript в src/"]);
  });

  it("reports every marker of a message, in order", () => {
    const text = [
      "%%%ACTIVITY: Читаю тест%%%",
      "Сначала посмотрю на падение.",
      "%%%ACTIVITY: Правлю манифест%%%",
      "Теперь правлю.",
      "%%%ACTIVITY: Гоняю npm test%%%",
    ].join("\n");
    for (let size = 1; size <= 7; size++) {
      expect(scanInChunks(text, size), `chunk size ${size}`).toEqual([
        "Читаю тест",
        "Правлю манифест",
        "Гоняю npm test",
      ]);
    }
  });

  it("gives up an opener that never closes and keeps reading", () => {
    const text = "%%%ACTIVITY: забыл закрыть\nдальше текст\n%%%ACTIVITY: этот закрыт%%%";
    expect(scanInChunks(text, 1)).toEqual(["этот закрыт"]);
  });

  it("reports nothing for an opener left open at the end of the stream", () => {
    const scanner = new ActivityMarkerScanner();
    expect(scanner.push("готово. %%%ACTIVITY: пишу отч")).toEqual([]);
    expect(scanner.push("ёт")).toEqual([]);
  });

  it("reports nothing for an opener that runs past the scan limit", () => {
    const scanner = new ActivityMarkerScanner();
    expect(scanner.push(`%%%ACTIVITY: ${"a".repeat(600)}%%%`)).toEqual([]);
  });

  it("cuts a closed marker to the length cap", () => {
    const long = "ю".repeat(MAX_ACTIVITY_LENGTH + 40);
    const [line] = scanInChunks(`%%%ACTIVITY: ${long}%%%`, 3);
    expect(line).toHaveLength(MAX_ACTIVITY_LENGTH);
    expect(line).toBe("ю".repeat(MAX_ACTIVITY_LENGTH));
  });

  it("reports nothing for a marker whose text is empty", () => {
    expect(scanInChunks("%%%ACTIVITY:%%%", 1)).toEqual([]);
    expect(scanInChunks("%%%ACTIVITY:   %%%", 1)).toEqual([]);
  });

  it("ignores a run of percent signs in quoted command output", () => {
    // What Codex quoted back from a shell in a live run: `printf` formats and a
    // `%%%` run, none of them carrying the ACTIVITY tag.
    const quoted = [
      "Команда вернула:",
      "```sh",
      "printf 'Файлов: %s\\n' \"$(printf '%s\\n' \"$files\" | wc -l)\"",
      "awk '{printf \"%%%d\\n\", $1}'",
      "%%% 100%%% done %%%",
      "```",
    ].join("\n");
    expect(scanInChunks(quoted, 1)).toEqual([]);
    expect(scanInChunks(quoted, 4)).toEqual([]);
  });

  it("reads a whole marker quoted inside command output as a marker", () => {
    // The tag is what separates a marker from ordinary text, so a literal marker
    // Codex quotes back is indistinguishable from one it means. The cost is one
    // wrong heading, overwritten by the next real one.
    const quoted = "Файл содержит:\n```\n%%%ACTIVITY: строка из файла%%%\n```\nи это всё.";
    expect(scanInChunks(quoted, 1)).toEqual(["строка из файла"]);
  });

  it("starts clean after a reset", () => {
    const scanner = new ActivityMarkerScanner();
    expect(scanner.push("%%%ACTIVITY: половина")).toEqual([]);
    scanner.reset();
    expect(scanner.push(" второй половины%%%")).toEqual([]);
    expect(scanner.push("%%%ACTIVITY: новая%%%")).toEqual(["новая"]);
  });
});

describe("stripActivityMarkers", () => {
  it("returns text carrying no marker unchanged", () => {
    const text = "Готово. Тест падал на 100% из-за %s в printf.\n\n  отступ сохранён";
    expect(stripActivityMarkers(text)).toBe(text);
  });

  it("removes a marker that occupies its own line, and the blank line with it", () => {
    const stripped = stripActivityMarkers(
      "%%%ACTIVITY: Читаю тест%%%\nПадение в session-manager.\n%%%ACTIVITY: Правлю%%%\nГотово."
    );
    expect(stripped).toBe("Падение в session-manager.\nГотово.");
  });

  it("removes a marker written inside a line", () => {
    expect(stripActivityMarkers("Начал %%%ACTIVITY: чтение%%% и закончил.")).toBe(
      "Начал  и закончил."
    );
  });

  it("removes an opener left unclosed", () => {
    expect(stripActivityMarkers("Ответ готов.\n%%%ACTIVITY: забыл закрыть")).toBe("Ответ готов.");
  });

  it("leaves a percent run that carries no tag", () => {
    const text = "Покрытие 90%%% строк, формат %%%s.";
    expect(stripActivityMarkers(text)).toBe(text);
  });
});

describe("stripActivityMarkersFromTurn", () => {
  it("cuts the markers out of the turn's own copy of the text", () => {
    const turn = stripActivityMarkersFromTurn({
      id: "turn_1",
      status: "completed",
      items: [
        { id: "i1", type: "agentMessage", text: "%%%ACTIVITY: Читаю тест%%%\nответ" },
        { id: "i2", type: "commandExecution", command: "ls" },
      ],
    }) as { id: string; items: Array<Record<string, unknown>> };

    expect(turn.items[0].text).toBe("ответ");
    // Everything the turn carries beyond `items[].text` is passed through.
    expect(turn.id).toBe("turn_1");
    expect(turn.items[1]).toEqual({ id: "i2", type: "commandExecution", command: "ls" });
  });

  it("leaves the turn as it came when it is not a record", () => {
    expect(stripActivityMarkersFromTurn(undefined)).toBeUndefined();
    expect(stripActivityMarkersFromTurn("plain")).toBe("plain");
    expect(stripActivityMarkersFromTurn([1, 2])).toEqual([1, 2]);
  });
});

describe("composeDeveloperInstructions", () => {
  afterEach(() => {
    delete process.env.CODEX_MCP_DISABLE_ACTIVITY_MARKER;
  });

  it("sends the marker instruction when the caller asked for nothing", () => {
    expect(composeDeveloperInstructions()).toBe(ACTIVITY_MARKER_INSTRUCTION);
  });

  it("keeps the caller's instructions after the marker instruction", () => {
    const composed = composeDeveloperInstructions("Отвечай по-русски.");
    expect(composed).toBe(`${ACTIVITY_MARKER_INSTRUCTION}\n\nОтвечай по-русски.`);
  });

  it("sends the caller's instructions alone when the marker is switched off", () => {
    process.env.CODEX_MCP_DISABLE_ACTIVITY_MARKER = "1";
    expect(composeDeveloperInstructions("Отвечай по-русски.")).toBe("Отвечай по-русски.");
    expect(composeDeveloperInstructions()).toBeUndefined();
  });
});

class MockClient extends EventEmitter {
  notificationHandler: ((method: string, params: unknown) => void) | null = null;

  childPid: number | undefined = undefined;

  start = jest.fn(async () => ({ userAgent: "mock" }));
  threadStart = jest.fn(async () => ({ thread: { id: "thread_mock" } }));
  threadFork = jest.fn(async () => ({ thread: { id: "thread_forked" } }));
  threadResume = jest.fn(async () => ({ thread: { id: "thread_forked" } }));
  threadBackgroundTerminalsClean = jest.fn(async () => ({}));
  turnStart = jest.fn(async () => ({ turn: { id: "turn_mock" } }));
  turnInterrupt = jest.fn(async () => {});
  respondToServer = jest.fn();
  respondErrorToServer = jest.fn();
  destroy = jest.fn(async () => {});

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }

  onServerRequest(): void {}

  emit_(method: string, params: unknown): void {
    this.notificationHandler?.(method, params);
  }
}

describe("SessionManager and the activity marker", () => {
  let manager: SessionManager;
  let client: MockClient;
  let sessionId: string;
  let root: string;
  let persistence: SessionPersistence;
  const workspace = tmpdir();

  /** Stream one agent message the way codex does: token-sized deltas, then the item. */
  function streamMessage(text: string, itemId = "msg_1", chunk = 3): void {
    for (let i = 0; i < text.length; i += chunk) {
      client.emit_(Methods.AGENT_MESSAGE_DELTA, {
        threadId: "thread_mock",
        turnId: "turn_mock",
        itemId,
        delta: text.slice(i, i + chunk),
      });
    }
    client.emit_(Methods.ITEM_COMPLETED, {
      threadId: "thread_mock",
      turnId: "turn_mock",
      item: { id: itemId, type: "agentMessage", text },
    });
  }

  function poll(): CheckResult {
    return manager.pollStatus(sessionId);
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "codex-mcp-activity-"));
    persistence = new SessionPersistence(root);
    client = new MockClient();
    manager = new SessionManager({
      disableCleanup: true,
      persistence,
      createClient: () => client as unknown as AppServerClient,
    });
    ({ sessionId } = await manager.createSession("задача", workspace, {}, "low"));
    client.emit_(Methods.TURN_STARTED, { turn: { id: "turn_mock", status: "inProgress" } });
  });

  afterEach(() => {
    manager.destroy();
    persistence.destroy();
    rmSync(root, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it("starts the thread with the marker instruction", () => {
    const [params] = client.threadStart.mock.calls[0] as [{ developerInstructions?: string }];
    expect(params.developerInstructions).toBe(ACTIVITY_MARKER_INSTRUCTION);
  });

  it("carries the marker instruction into a fork and its resume", async () => {
    client.emit_(Methods.TURN_COMPLETED, { turn: { id: "turn_mock", status: "completed" } });
    await manager.forkSession(sessionId);

    const [forkParams] = client.threadFork.mock.calls[0] as [{ developerInstructions?: string }];
    const [resumeParams] = client.threadResume.mock.calls[0] as [
      { developerInstructions?: string },
    ];
    expect(forkParams.developerInstructions).toBe(ACTIVITY_MARKER_INSTRUCTION);
    expect(resumeParams.developerInstructions).toBe(ACTIVITY_MARKER_INSTRUCTION);
  });

  it("reports no activity before the turn's first marker", () => {
    expect(poll().progress.activity).toBeUndefined();
  });

  it("reports the last marker of the stream in progress.activity", () => {
    streamMessage("%%%ACTIVITY: Читаю тест%%%\nСмотрю падение.", "msg_1");
    expect(poll().progress.activity).toBe("Читаю тест");

    streamMessage("%%%ACTIVITY: Правлю манифест%%%\nМеняю поле.", "msg_2");
    expect(poll().progress.activity).toBe("Правлю манифест");
  });

  it("keeps the markers out of the turn's result", () => {
    streamMessage("%%%ACTIVITY: Пишу ответ%%%\nГотово: тест падал на неверном поле.", "msg_final");
    client.emit_(Methods.TURN_COMPLETED, { turn: { id: "turn_mock", status: "completed" } });

    const result = poll().result;
    expect(result?.text).toBe("Готово: тест падал на неверном поле.");
    expect(result?.text).not.toContain("%%%");
  });

  it("drops the previous turn's activity when a new turn starts", () => {
    streamMessage("%%%ACTIVITY: Читаю тест%%%\nтекст", "msg_1");
    expect(poll().progress.activity).toBe("Читаю тест");

    client.emit_(Methods.TURN_COMPLETED, { turn: { id: "turn_mock", status: "completed" } });
    client.emit_(Methods.TURN_STARTED, { turn: { id: "turn_2", status: "inProgress" } });
    expect(poll().progress.activity).toBeUndefined();
  });

  it("writes one activity record per marker to events.jsonl", () => {
    streamMessage("%%%ACTIVITY: Читаю тест%%%\nтекст", "msg_1");
    streamMessage("%%%ACTIVITY: Правлю манифест%%%\nтекст", "msg_2");

    const lines = readFileSync(join(root, "sessions", sessionId, "events.jsonl"), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
    const activities = lines.filter((entry) => entry.type === "activity");

    expect(activities.map((entry) => entry.data.activity)).toEqual([
      "Читаю тест",
      "Правлю манифест",
    ]);
    expect(activities[0].data.turnId).toBe("turn_mock");
    expect(activities[0].data.itemId).toBe("msg_1");
    expect(activities[1].data.itemId).toBe("msg_2");
  });

  it("wakes a long poll on a marker", async () => {
    const before = manager.getSessionSignal(sessionId);
    let woke = false;
    const waiting = manager.waitForChange(sessionId, 60_000).then(() => {
      woke = true;
    });

    streamMessage("%%%ACTIVITY: Читаю тест%%%\nтекст", "msg_1");
    await waiting;

    expect(woke).toBe(true);
    expect(manager.getSessionSignal(sessionId).key).not.toBe(before.key);
  });

  it("sleeps through a delta that carries no marker", () => {
    const before = manager.getSessionSignal(sessionId);
    streamMessage("обычный текст без единого маркера", "msg_1");
    expect(manager.getSessionSignal(sessionId).key).toBe(before.key);
  });
});
