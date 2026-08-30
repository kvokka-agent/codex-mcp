/**
 * SessionManager — the surface a tool call reaches. It owns one `SessionRuntime`
 * and the cleanup timer, and every method is the module function that does the work.
 */
import { AppServerClient } from "../../app-server/client/index.js";
import type { AppServerSpawnOptions } from "../../app-server/lifecycle.js";
import type { RecoveredSession } from "../../persistence/index.js";
import {
  type BackgroundTerminalsReport,
  type CheckResult,
  CLEANUP_INTERVAL_MS,
  type EffortLevel,
  type ProgressInfo,
  type PublicSessionInfo,
  type SensitiveSessionInfo,
  type SessionSignal,
  type SessionStartResult,
  type SteerResult,
  type TurnResult,
} from "../../types/index.js";
import { resolveApproval, resolveUserInput } from "./approvals.js";
import {
  type CleanSessionsOptions,
  type CleanSessionsResult,
  cancelSession,
  cleanSessions,
  cleanupSessions,
  destroy,
} from "./cleanup.js";
import type {
  ApprovalExtra,
  CreateSessionAdvanced,
  SessionManagerOptions,
  TurnOverrides,
} from "./core.js";
import { SessionRuntime } from "./core.js";

export type { SessionManagerOptions };

import { finalizeForShutdown, forkSession, resumeSession } from "./fork-resume.js";
import {
  getActiveSessionCount,
  getCodexDefaultModel,
  getLastResult,
  getPendingActionTypes,
  getProgress,
  getSession,
  getSessionSignal,
  listAllSessions,
  listSessions,
  onActivity,
  pollStatus,
} from "./poll.js";
import { ingestRecovered } from "./store.js";
import {
  cleanBackgroundTerminals,
  interruptSession,
  steerSession,
  terminateBackgroundTerminal,
} from "./turn-control.js";
import { createSession, replyToSession } from "./turns.js";
import { waitForChange } from "./waiters.js";

export class SessionManager {
  private readonly runtime: SessionRuntime;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SessionManagerOptions = {}) {
    this.runtime = new SessionRuntime(
      options.createClient ?? (() => new AppServerClient()),
      options.persistence ?? null
    );

    if (!options.disableCleanup) {
      this.cleanupTimer = setInterval(() => cleanupSessions(this.runtime), CLEANUP_INTERVAL_MS);
      if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }
  }

  ingestRecovered(recovered: RecoveredSession[]): void {
    ingestRecovered(this.runtime, recovered);
  }

  createSession(
    prompt: string,
    cwd: string,
    spawnOpts: AppServerSpawnOptions,
    effort: EffortLevel,
    advanced?: CreateSessionAdvanced
  ): Promise<SessionStartResult> {
    return createSession(this.runtime, prompt, cwd, spawnOpts, effort, advanced);
  }

  replyToSession(
    sessionId: string,
    prompt: string,
    overrides?: TurnOverrides
  ): Promise<SessionStartResult> {
    return replyToSession(this.runtime, sessionId, prompt, overrides);
  }

  resumeSession(sessionId: string): Promise<SessionStartResult> {
    return resumeSession(this.runtime, sessionId);
  }

  forkSession(sessionId: string): Promise<SessionStartResult> {
    return forkSession(this.runtime, sessionId);
  }

  finalizeForShutdown(): void {
    finalizeForShutdown(this.runtime);
  }

  listSessions(): PublicSessionInfo[] {
    return listSessions(this.runtime);
  }

  listAllSessions(): PublicSessionInfo[] {
    return listAllSessions(this.runtime);
  }

  getActiveSessionCount(): number {
    return getActiveSessionCount(this.runtime);
  }

  getCodexDefaultModel(): string | null {
    return getCodexDefaultModel(this.runtime);
  }

  getSession(
    sessionId: string,
    includeSensitive = false
  ): PublicSessionInfo | SensitiveSessionInfo {
    return getSession(this.runtime, sessionId, includeSensitive);
  }

  getLastResult(sessionId: string): TurnResult | undefined {
    return getLastResult(this.runtime, sessionId);
  }

  getProgress(sessionId: string): ProgressInfo {
    return getProgress(this.runtime, sessionId);
  }

  onActivity(sessionId: string, listener: (activity: string) => void): () => void {
    return onActivity(this.runtime, sessionId, listener);
  }

  getPendingActionTypes(sessionId: string): Array<"approval" | "user_input"> {
    return getPendingActionTypes(this.runtime, sessionId);
  }

  pollStatus(sessionId: string): CheckResult {
    return pollStatus(this.runtime, sessionId);
  }

  getSessionSignal(sessionId: string): SessionSignal {
    return getSessionSignal(this.runtime, sessionId);
  }

  waitForChange(sessionId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return waitForChange(this.runtime, sessionId, timeoutMs, signal);
  }

  interruptSession(sessionId: string): Promise<void> {
    return interruptSession(this.runtime, sessionId);
  }

  steerSession(sessionId: string, prompt: string): Promise<SteerResult> {
    return steerSession(this.runtime, sessionId, prompt);
  }

  cleanBackgroundTerminals(sessionId: string): Promise<BackgroundTerminalsReport> {
    return cleanBackgroundTerminals(this.runtime, sessionId);
  }

  terminateBackgroundTerminal(
    sessionId: string,
    processId: string
  ): Promise<BackgroundTerminalsReport> {
    return terminateBackgroundTerminal(this.runtime, sessionId, processId);
  }

  cancelSession(sessionId: string, reason?: string): Promise<void> {
    return cancelSession(this.runtime, sessionId, reason);
  }

  cleanSessions(options?: CleanSessionsOptions): Promise<CleanSessionsResult> {
    return cleanSessions(this.runtime, options);
  }

  resolveApproval(
    sessionId: string,
    requestId: string,
    decision: string,
    extra?: ApprovalExtra
  ): void {
    resolveApproval(this.runtime, sessionId, requestId, decision, extra);
  }

  resolveUserInput(
    sessionId: string,
    requestId: string,
    answers: Record<string, { answers: string[] }>
  ): void {
    resolveUserInput(this.runtime, sessionId, requestId, answers);
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    destroy(this.runtime);
  }
}
