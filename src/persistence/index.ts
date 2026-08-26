/**
 * Persistence primitives — atomic writes, session ownership, event log, recovery scan, retention.
 */
export { atomicWriteJson } from "./atomic-writer.js";
export {
  OWNER_FILE,
  claimSession,
  describeOwner,
  hasLiveOwner,
  ownClaim,
  ownerState,
  readOwner,
  releaseSession,
  type OwnerState,
  type SessionOwner,
} from "./session-owner.js";
export { identifyProcess, ownStartedAt, probePid } from "./process-identity.js";
export { EventLog, type EventCriticality, type EventLogOptions } from "./event-log.js";
export {
  SCHEMA_VERSION,
  scanRecoverableSessions,
  type RecoveredSession,
  type RecoveredSessionMeta,
  type RecoveredPidInfo,
} from "./recovery-scanner.js";
export { pruneSessionDirs, type RetentionPolicy } from "./retention.js";
