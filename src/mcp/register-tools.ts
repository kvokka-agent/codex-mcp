/** The five tools this server offers, each registered with the schemas it
 * answers by and the executor that does the work. */
import { executeCodex } from "../tools/codex.js";
import { executeCodexCheck } from "../tools/codex-check.js";
import { executeCodexReply } from "../tools/codex-reply.js";
import { executeCodexSession } from "../tools/codex-session.js";
import { executeCodexSetup } from "../tools/codex-setup/index.js";
import { progressReporterFor } from "../utils/progress-notifier.js";
import { payloadIsError, runTool } from "./envelope.js";
import { checkToolOutputShape, codexCheckInputSchema } from "./schemas/check.js";
import { codexInputSchema, codexReplyInputSchema } from "./schemas/codex.js";
import { sessionStartOutputShape } from "./schemas/common.js";
import { sessionToolInputShape, sessionToolOutputShape } from "./schemas/session.js";
import { setupInputShape, setupResultShape } from "./schemas/setup.js";
import type { ToolContext } from "./tool-context.js";

function registerCodexTool(ctx: ToolContext): void {
  const { server, sessionManager, serverCwd, sessionDefaults } = ctx;
  server.registerTool(
    "codex",
    {
      title: "Start Codex Session",
      description:
        "Start a Codex session and return `{ sessionId, threadId, status, progress }` at once — the turn runs on. Follow it with `codex_check(action='poll', waitMs=300000)` in a loop until the status is terminal: that call answers the moment Codex says it is working on something new, so write its `progress.activity` out where the person waiting reads it, then call again. See `codex-mcp:///quickstart` for the loop, `codex-mcp:///config` for parameter guidance, and `codex-mcp:///delegation-guide` for approval/sandbox presets.",
      inputSchema: codexInputSchema(sessionDefaults),
      outputSchema: sessionStartOutputShape,
      annotations: {
        title: "Start Codex Session",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (args) => runTool(() => executeCodex(args, sessionManager, serverCwd, sessionDefaults))
  );
}

function registerCodexReplyTool(ctx: ToolContext): void {
  const { server, sessionManager } = ctx;
  server.registerTool(
    "codex_reply",
    {
      title: "Continue Codex Session",
      description:
        "Continue existing session. Allowed in `idle`/`error`; otherwise `SESSION_BUSY`. Returns at once and the turn runs on; follow it with the same `codex_check(action='poll', waitMs=300000)` loop as `codex`.",
      inputSchema: codexReplyInputSchema,
      outputSchema: sessionStartOutputShape,
      annotations: {
        title: "Continue Codex Session",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (args) => runTool(() => executeCodexReply(args, sessionManager))
  );
}

function registerCodexSetupTool(ctx: ToolContext): void {
  const { server, serverCwd } = ctx;
  server.registerTool(
    "codex_setup",
    {
      title: "Codex Setup",
      description:
        "Run local readiness checks for codex-mcp: executable resolution, the account the app server answers with, Codex CLI version against the minimum this server drives, the Windows sandbox on Windows, project config, and the permission profile ids this machine offers as `permissions`. Use this before starting a session when setup is uncertain, or to learn which profile ids exist here.",
      inputSchema: setupInputShape,
      outputSchema: setupResultShape,
      annotations: {
        title: "Codex Setup",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) => runTool(() => executeCodexSetup(args, serverCwd))
  );
}

function registerCodexSessionTool(ctx: ToolContext): void {
  const { server, sessionManager } = ctx;
  server.registerTool(
    "codex_session",
    {
      title: "Manage Sessions",
      description: `Session actions: list, get, resume, cancel, interrupt, steer, fork, clean, clean_background_terminals, terminate_background_terminal.

- list: every session of the state directory, this server's and every other server's. Each carries \`activity\` — what it last said it was doing — and \`owner\`, the process holding it. A session with status \`abandoned\` and no \`owner\` was cut off when its server went away and can be resumed.
- get: details. includeSensitive defaults to false; true adds threadId/cwd/profile/config.
- resume: pick an \`abandoned\` session back up and drive it from here. Codex restores the thread from its rollout log, including the turn it was interrupted in; continue with codex_reply. A session another running server holds is refused.
- cancel: terminal.
- interrupt: stop current turn, throwing away what it had done.
- steer: add to the turn already running instead of stopping it. Takes prompt. No turn starts: turnId is the turn the steer joined, status stays running, and the turn's one result still comes at its end — carry on polling. Codex reads the added text at the turn's next model round trip, so a steer sent as a turn ends can miss it, and that answers SESSION_NOT_RUNNING naming the turn rather than reporting a steer that landed.
- fork: clone current thread into a new session; source remains unchanged.
- clean: batch-remove idle/error/cancelled sessions, optionally from disk too. Pass statuses:["abandoned"] to drop cut-off sessions instead of resuming them.
- clean_background_terminals: terminate every background terminal of this thread and answer what happened. backgroundTerminals.terminals lists what was there, each with terminated — what Codex answered for that process — and gone, measured by listing the thread again afterwards. backgroundTerminals.survivors is what was still standing at the end. A listing that failed leaves listError and no measurement, never a claim that the thread is clear.
- terminate_background_terminal: terminate one of them. Takes processId, from a clean_background_terminals answer, and reports terminated; a process that stayed up answers false rather than raising.`,
      inputSchema: sessionToolInputShape,
      outputSchema: sessionToolOutputShape,
      annotations: {
        title: "Manage Sessions",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args) => runTool(() => executeCodexSession(args, sessionManager), payloadIsError)
  );
}

function registerCodexCheckTool(ctx: ToolContext): void {
  const { server, sessionManager, sessionDefaults, pollWindow } = ctx;
  server.registerTool(
    "codex_check",
    {
      title: "Poll & Respond",
      description: `Report where a session stands and answer what it waits for. Every action returns the same payload: { sessionId, status, progress, actions[], result?, interactionState, recommendedNextAction }. The turn's own events are never returned — Codex writes the full transcript to its rollout log under ~/.codex/sessions/. Answer every entry of actions[]; stop checking on terminal status (idle/error/cancelled), where result carries the final answer and keeps carrying it while the session stands there. WARNING: without waitMs you are polling on a timer, and approvalTimeoutMs defaults to ${sessionDefaults.approvalTimeoutMs}ms, so approvals expire between checks unless you raise the timeout, use non-interactive policies, or pass waitMs — which answers the moment an approval arrives. See codex-mcp:///quickstart and codex-mcp:///gotchas.

poll: current status; with waitMs it holds the call until the status changes, an action arrives, the turn ends, or Codex says it is working on something new — and answers with the state it found when the window runs out instead. Loop it: write progress.activity out where the person waiting reads it, then call again. progress.activityStandingMs says how long that same line has stood, so a turn that is still on it reads "compiling — 15 min" rather than repeating itself. waitedMs says how long the call was held. Send _meta.progressToken and the same lines also arrive as notifications/progress while the call is still open, with a heartbeat every 30s.
respond_permission: answer an approval action.
respond_user_input: answer a user-input action.`,
      inputSchema: codexCheckInputSchema,
      outputSchema: checkToolOutputShape,
      annotations: {
        title: "Poll & Respond",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args, extra) =>
      runTool(
        () =>
          executeCodexCheck(
            args,
            sessionManager,
            extra.signal,
            pollWindow,
            progressReporterFor(extra._meta, extra.sendNotification)
          ),
        payloadIsError
      )
  );
}

/** Every tool of this server, in the order `tools/list` reports them. */
export function registerTools(ctx: ToolContext): void {
  registerCodexTool(ctx);
  registerCodexReplyTool(ctx);
  registerCodexSetupTool(ctx);
  registerCodexSessionTool(ctx);
  registerCodexCheckTool(ctx);
}
