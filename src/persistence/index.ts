/**
 * Persistence primitives — atomic writes, session ownership, event log, recovery scan, retention.
 */
export { atomicWriteJson } from "./atomic-writer.js";
export { type EventCriticality, EventLog } from "./event-log.js";
export { ownStartedAt } from "./process-identity.js";
export {
  type RecoveredSession,
  SCHEMA_VERSION,
  scanRecoverableSessions,
} from "./recovery-scanner.js";
export { pruneSessionDirs, type RetentionPolicy } from "./retention.js";
export {
  claimSession,
  describeOwner,
  type OwnerState,
  ownerState,
  readOwner,
  releaseSession,
} from "./session-owner.js";
