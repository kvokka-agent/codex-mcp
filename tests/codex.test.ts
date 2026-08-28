import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, jest } from "bun:test";
import type { SessionManager } from "../src/session/manager.js";
import { executeCodex } from "../src/tools/codex.js";
import type { SessionDefaults } from "../src/utils/session-defaults.js";

const DEFAULTS: SessionDefaults = { effort: "low", approvalTimeoutMs: 60000 };

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("executeCodex", () => {
  it("defaults effort to low when omitted", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "codex-tool-"));
    tempDirs.push(cwd);

    const createSession = jest.fn(async () => ({
      sessionId: "sess_1",
      threadId: "thread_1",
      status: "running" as const,
      pollInterval: 120000,
    }));
    const sessionManager = { createSession } as unknown as SessionManager;

    await executeCodex(
      {
        prompt: "hello",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
      sessionManager,
      cwd,
      DEFAULTS
    );

    expect(createSession).toHaveBeenCalledWith(
      "hello",
      cwd,
      {
        profile: undefined,
        model: undefined,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        config: undefined,
      },
      "low",
      { approvalTimeoutMs: 60000 }
    );
  });

  it("passes explicit effort through to SessionManager", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "codex-tool-"));
    tempDirs.push(cwd);

    const createSession = jest.fn(async () => ({
      sessionId: "sess_2",
      threadId: "thread_2",
      status: "running" as const,
      pollInterval: 120000,
    }));
    const sessionManager = { createSession } as unknown as SessionManager;

    await executeCodex(
      {
        prompt: "hello",
        approvalPolicy: "never",
        sandbox: "read-only",
        effort: "xhigh",
      },
      sessionManager,
      cwd,
      DEFAULTS
    );

    expect(createSession).toHaveBeenCalledWith(
      "hello",
      cwd,
      {
        profile: undefined,
        model: undefined,
        approvalPolicy: "never",
        sandbox: "read-only",
        config: undefined,
      },
      "xhigh",
      { approvalTimeoutMs: 60000 }
    );
  });
  it("starts on the environment's model, effort and approval timeout when the call names none", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "codex-tool-"));
    tempDirs.push(cwd);

    const createSession = jest.fn(async () => ({
      sessionId: "sess_3",
      threadId: "thread_3",
      status: "running" as const,
      pollInterval: 120000,
    }));
    const sessionManager = { createSession } as unknown as SessionManager;

    await executeCodex(
      {
        prompt: "hello",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
      sessionManager,
      cwd,
      { model: "gpt-5.6-luna", effort: "high", approvalTimeoutMs: 900000 }
    );

    expect(createSession).toHaveBeenCalledWith(
      "hello",
      cwd,
      {
        profile: undefined,
        model: "gpt-5.6-luna",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        config: undefined,
      },
      "high",
      { approvalTimeoutMs: 900000 }
    );
  });

  it("keeps what the call named over the environment's defaults", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "codex-tool-"));
    tempDirs.push(cwd);

    const createSession = jest.fn(async () => ({
      sessionId: "sess_4",
      threadId: "thread_4",
      status: "running" as const,
      pollInterval: 120000,
    }));
    const sessionManager = { createSession } as unknown as SessionManager;

    await executeCodex(
      {
        prompt: "hello",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        model: "gpt-5",
        effort: "minimal",
        advanced: { approvalTimeoutMs: 300000, ephemeral: true },
      },
      sessionManager,
      cwd,
      { model: "gpt-5.6-luna", effort: "high", approvalTimeoutMs: 900000 }
    );

    expect(createSession).toHaveBeenCalledWith(
      "hello",
      cwd,
      {
        profile: undefined,
        model: "gpt-5",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        config: undefined,
      },
      "minimal",
      { approvalTimeoutMs: 300000, ephemeral: true }
    );
  });
});
