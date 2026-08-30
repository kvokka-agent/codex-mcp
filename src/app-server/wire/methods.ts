/**
 * Every method name of the wire protocol, in one table the client addresses the
 * server by.
 *
 * Derived from `codex app-server generate-json-schema`.
 */

export const Methods = {
  // Client → Server
  INITIALIZE: "initialize",
  THREAD_START: "thread/start",
  THREAD_RESUME: "thread/resume",
  THREAD_FORK: "thread/fork",
  THREAD_BACKGROUND_TERMINALS_CLEAN: "thread/backgroundTerminals/clean",
  THREAD_BACKGROUND_TERMINALS_LIST: "thread/backgroundTerminals/list",
  THREAD_BACKGROUND_TERMINALS_TERMINATE: "thread/backgroundTerminals/terminate",
  THREAD_DELETE: "thread/delete",
  PERMISSION_PROFILE_LIST: "permissionProfile/list",
  ACCOUNT_READ: "account/read",
  WINDOWS_SANDBOX_READINESS: "windowsSandbox/readiness",
  TURN_START: "turn/start",
  TURN_INTERRUPT: "turn/interrupt",
  TURN_STEER: "turn/steer",

  // Server → Client requests
  COMMAND_APPROVAL: "item/commandExecution/requestApproval",
  FILE_CHANGE_APPROVAL: "item/fileChange/requestApproval",
  USER_INPUT_REQUEST: "item/tool/requestUserInput",
  DYNAMIC_TOOL_CALL: "item/tool/call",
  AUTH_TOKEN_REFRESH: "account/chatgptAuthTokens/refresh",
  LEGACY_PATCH_APPROVAL: "applyPatchApproval",
  LEGACY_EXEC_APPROVAL: "execCommandApproval",

  // Server → Client notifications
  ERROR: "error",
  THREAD_STARTED: "thread/started",
  THREAD_STATUS_CHANGED: "thread/status/changed",
  THREAD_CLOSED: "thread/closed",
  THREAD_COMPACTED: "thread/compacted",
  THREAD_ARCHIVED: "thread/archived",
  THREAD_UNARCHIVED: "thread/unarchived",
  THREAD_NAME_UPDATED: "thread/name/updated",
  THREAD_TOKEN_USAGE_UPDATED: "thread/tokenUsage/updated",
  TURN_STARTED: "turn/started",
  TURN_COMPLETED: "turn/completed",
  TURN_DIFF_UPDATED: "turn/diff/updated",
  TURN_PLAN_UPDATED: "turn/plan/updated",
  ITEM_STARTED: "item/started",
  ITEM_COMPLETED: "item/completed",
  AGENT_MESSAGE_DELTA: "item/agentMessage/delta",
  COMMAND_OUTPUT_DELTA: "item/commandExecution/outputDelta",
  COMMAND_TERMINAL_INTERACTION: "item/commandExecution/terminalInteraction",
  FILE_CHANGE_OUTPUT_DELTA: "item/fileChange/outputDelta",
  REASONING_TEXT_DELTA: "item/reasoning/textDelta",
  REASONING_SUMMARY_DELTA: "item/reasoning/summaryTextDelta",
  REASONING_SUMMARY_PART_ADDED: "item/reasoning/summaryPartAdded",
  PLAN_DELTA: "item/plan/delta",
  MCP_TOOL_PROGRESS: "item/mcpToolCall/progress",
  AUTO_APPROVAL_REVIEW_STARTED: "item/autoApprovalReview/started",
  AUTO_APPROVAL_REVIEW_COMPLETED: "item/autoApprovalReview/completed",
  AUTO_APPROVAL_REVIEW_STRICT_REQUIRED: "autoApprovalReview/strictReviewRequired",
  MODEL_REROUTED: "model/rerouted",
  FUZZY_FILE_SEARCH_SESSION_UPDATED: "fuzzyFileSearch/sessionUpdated",
  FUZZY_FILE_SEARCH_SESSION_COMPLETED: "fuzzyFileSearch/sessionCompleted",
  WINDOWS_WORLD_WRITABLE_WARNING: "windows/worldWritableWarning",
  ACCOUNT_LOGIN_COMPLETED: "account/login/completed",
  DEPRECATION_NOTICE: "deprecationNotice",
  CONFIG_WARNING: "configWarning",
  WARNING: "warning",
  GUARDIAN_WARNING: "guardianWarning",
  MODEL_SAFETY_BUFFERING_UPDATED: "model/safetyBuffering/updated",
  HOOK_STARTED: "hook/started",
  HOOK_COMPLETED: "hook/completed",
} as const;
