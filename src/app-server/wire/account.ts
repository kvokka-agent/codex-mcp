/**
 * The account the install signs Codex requests with, and whether the Windows
 * sandbox on this machine is set up.
 *
 * Derived from `codex app-server generate-json-schema`.
 */

/** account/read — schema v2/GetAccountParams.json. */
export interface GetAccountParams {
  /**
   * Refresh the token before answering. Default false, and left there here:
   * this server reads the account, it does not manage the credential.
   */
  refreshToken?: boolean;
}

/** The plan a ChatGPT account is on — schema definition `PlanType`. */
export type PlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "prolite"
  | "team"
  | "self_serve_business_prolite"
  | "self_serve_business_usage_based"
  | "business"
  | "ent26"
  | "enterprise_cbp_automation"
  | "enterprise_cbp_usage_based"
  | "enterprise"
  | "edu"
  | "edu_plus"
  | "edu_pro"
  | "unknown";

/** The credential the account signs requests with — schema definition `Account`. */
export type Account =
  | { type: "apiKey" }
  | { type: "chatgpt"; email: string | null; planType: PlanType }
  | { type: "amazonBedrock"; usesCodexManagedCredentials?: boolean };

/**
 * account/read response — schema v2/GetAccountResponse.json.
 *
 * `requiresOpenaiAuth` is false where the configured model provider carries its
 * own credentials, and a null `account` there is not a missing login.
 */
export interface GetAccountResult {
  requiresOpenaiAuth: boolean;
  account?: Account | null;
}

// ── Windows sandbox ────────────────────────────────────────────────

/** schema definition `WindowsSandboxReadiness`. */
export type WindowsSandboxReadiness = "ready" | "notConfigured" | "updateRequired";

/**
 * windowsSandbox/readiness response — schema
 * v2/WindowsSandboxReadinessResponse.json. The method takes null params.
 *
 * The backend answers on every platform and gates nothing on the operating
 * system: a Linux 0.150.1 answers `{"status":"notConfigured"}`, the same value a
 * Windows machine with no sandbox gives, so only a `win32` caller may read it.
 */
export interface WindowsSandboxReadinessResult {
  status: WindowsSandboxReadiness;
}
