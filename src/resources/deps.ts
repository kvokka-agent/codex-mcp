import type { SessionManager } from "../session/manager/session-manager.js";
import type { SessionDefaults } from "../utils/session-defaults.js";

type RuntimeMetadataProvider = Pick<
  SessionManager,
  "getActiveSessionCount" | "getCodexDefaultModel"
>;

export interface ResourceDeps {
  version: string;
  sessionManager: RuntimeMetadataProvider;
  /** Whether the state directory was claimed at startup, so session history outlives a restart. */
  diskPersistence: boolean;
  /** How a session starts when the caller names nothing, as the environment set it. */
  sessionDefaults: SessionDefaults;
}
