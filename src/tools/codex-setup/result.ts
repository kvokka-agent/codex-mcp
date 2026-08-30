/** What `codex_setup` is asked for, and what it answers. */
import type {
  Account,
  PermissionProfileSummary,
  WindowsSandboxReadiness,
} from "../../app-server/wire/index.js";
import type { CodexExecutableInfo } from "../../utils/codex-executable.js";

export interface CodexSetupInput {
  cwd?: string;
}

/**
 * What the app server answered about authentication.
 *
 * `not_required` is an install whose model provider carries its own
 * credentials: `account/read` answers `requiresOpenaiAuth: false` there, and a
 * null account is not a missing login. `unknown` is the state nothing answered.
 */
type AuthState = "authenticated" | "unauthenticated" | "not_required" | "unknown";

export interface CodexSetupResult {
  ready: boolean;
  cwd: string;
  executable: {
    ok: boolean;
    source: CodexExecutableInfo["source"] | "error";
    command?: string;
    isPath?: boolean;
    detail: string;
  };
  auth: {
    ok: boolean;
    state: AuthState;
    /** The credential the account signs with, as `account/read` named it. */
    accountType?: Account["type"];
    detail: string;
  };
  backend: {
    ok: boolean;
    cliVersion: string | null;
    minimumCliVersion: string;
    detail: string;
  };
  /** Present for a caller on Windows whose app server answered the readiness call. */
  windowsSandbox?: {
    status: WindowsSandboxReadiness;
  };
  runtime: {
    sameMachineRequired: true;
    stateDir: string;
  };
  projectContext: {
    hasUserConfig: boolean;
    hasProjectConfig: boolean;
  };
  /**
   * The ids a `codex` or `codex_reply` call may pass as `permissions`.
   *
   * `profiles` is absent unless the listing answered: a listing that failed, or
   * one that was never run because no executable resolved, says nothing about
   * which profiles exist, and an empty array there would read as a machine that
   * offers none.
   */
  permissionProfiles: {
    ok: boolean;
    profiles?: PermissionProfileSummary[];
    detail: string;
  };
  warnings: string[];
  nextSteps: string[];
}
