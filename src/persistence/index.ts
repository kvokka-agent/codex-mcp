/**
 * Persistence primitives — atomic writes, lockfile, event log, recovery scan, retention.
 */
export { atomicWriteJson } from "./atomic-writer.js";
export { acquireLock } from "./lockfile.js";
export { EventLog, type EventCriticality, type EventLogOptions } from "./event-log.js";
export {
  SCHEMA_VERSION,
  scanRecoverableSessions,
  type RecoveredSession,
  type RecoveredSessionMeta,
  type RecoveredPidInfo,
} from "./recovery-scanner.js";
export { pruneSessionDirs, type RetentionPolicy } from "./retention.js";
