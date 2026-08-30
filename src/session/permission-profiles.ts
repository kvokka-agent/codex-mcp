/**
 * The permission profiles a machine offers, and whether a named one is usable.
 *
 * An id Codex does not know comes back from `thread/start` as
 * `failed to load configuration: default_permissions requires a
 * `[permissions]` table` — a message about a TOML table the caller never
 * wrote. So a `permissions` id is held against `permissionProfile/list` before
 * it is sent, and the caller is told which ids exist instead.
 */
import type { ICodexClient } from "../app-server/client-interface.js";
import { Methods, type PermissionProfileSummary } from "../app-server/wire/index.js";
import { ErrorCode } from "../types/index.js";

/**
 * Pages followed before the listing is reported as one this server could not
 * read to the end. A profile absent from an unexhausted listing is not a
 * profile that does not exist.
 */
const MAX_PROFILE_PAGES = 20;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One entry of a `permissionProfile/list` page, or nothing when it is shaped otherwise. */
function readSummary(entry: unknown): PermissionProfileSummary | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const { id, allowed, description } = entry as Record<string, unknown>;
  if (typeof id !== "string" || typeof allowed !== "boolean") return undefined;
  // The schema types `description` `["string","null"]`, and a null one is
  // carried through as the null the backend sent.
  if (description !== undefined && description !== null && typeof description !== "string") {
    return undefined;
  }
  return { id, allowed, description };
}

/**
 * Every permission profile the backend lists for `cwd`.
 *
 * Throws when the backend refused the call, answered a shape this server cannot
 * read, or handed back more pages than `MAX_PROFILE_PAGES`: each of those is a
 * listing that says nothing about which profiles exist, and answering with the
 * profiles of a partial page would turn it into a shorter list of them.
 */
export async function listPermissionProfiles(
  client: ICodexClient,
  cwd?: string
): Promise<PermissionProfileSummary[]> {
  const profiles: PermissionProfileSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PROFILE_PAGES; page++) {
    const response = await client.permissionProfileList({ cwd, cursor });
    if (!Array.isArray(response?.data)) {
      throw new Error(
        `${Methods.PERMISSION_PROFILE_LIST} answered no \`data\` array, so the profiles of this machine are unknown`
      );
    }
    for (const entry of response.data) {
      const summary = readSummary(entry);
      if (!summary) {
        throw new Error(
          `${Methods.PERMISSION_PROFILE_LIST} answered an entry carrying no string \`id\` and boolean \`allowed\``
        );
      }
      profiles.push(summary);
    }
    cursor = typeof response.nextCursor === "string" ? response.nextCursor : undefined;
    if (cursor === undefined) return profiles;
  }
  throw new Error(
    `${Methods.PERMISSION_PROFILE_LIST} handed back more than ${MAX_PROFILE_PAGES} pages and the listing is still not exhausted`
  );
}

/** The ids of a listing, each marked where the backend said it cannot be selected. */
function describeProfiles(profiles: PermissionProfileSummary[]): string {
  if (profiles.length === 0) {
    return "none — a profile comes from a `[permissions.<id>]` table in the Codex config.toml";
  }
  return profiles
    .map((profile) =>
      profile.allowed ? `\`${profile.id}\`` : `\`${profile.id}\` (not selectable)`
    )
    .join(", ");
}

/**
 * Throw unless `id` names a profile this machine offers and allows.
 *
 * A listing that failed is carried through as a failure of its own: the id is
 * not sent on the guess that it is fine.
 */
export async function assertPermissionProfileSelectable(
  client: ICodexClient,
  id: string,
  cwd?: string
): Promise<void> {
  let profiles: PermissionProfileSummary[];
  try {
    profiles = await listPermissionProfiles(client, cwd);
  } catch (err) {
    throw new Error(
      `Error [${ErrorCode.INTERNAL}]: permissions profile '${id}' could not be checked and was not sent: ${describeError(err)}`
    );
  }

  const found = profiles.find((profile) => profile.id === id);
  if (!found) {
    throw new Error(
      `Error [${ErrorCode.INVALID_ARGUMENT}]: no permission profile '${id}' here. This machine offers: ${describeProfiles(profiles)}.`
    );
  }
  if (!found.allowed) {
    throw new Error(
      `Error [${ErrorCode.INVALID_ARGUMENT}]: permission profile '${id}' exists but ${Methods.PERMISSION_PROFILE_LIST} answered \`allowed: false\` for it here. This machine offers: ${describeProfiles(profiles)}.`
    );
  }
}
