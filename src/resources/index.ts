import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { detectCodexCliVersion } from "../utils/codex-version.js";
import type { ResourceCatalogEntry } from "./catalog.js";
import { asTextResource, RESOURCE_CATALOG, RESOURCE_URIS } from "./catalog.js";
import type { ResourceDeps } from "./deps.js";
import { buildConfigGuideText } from "./docs/config.js";
import { buildDelegationGuideText } from "./docs/delegation-guide.js";
import { buildErrorsText } from "./docs/errors.js";
import { buildGotchasText } from "./docs/gotchas.js";
import { buildQuickstartText } from "./docs/quickstart.js";
import { buildCompatReport, buildServerInfoJson } from "./server-info.js";

export { RESOURCE_URIS } from "./catalog.js";
export type { ResourceDeps } from "./deps.js";

function registerCatalogResource(
  server: Pick<McpServer, "registerResource">,
  entry: ResourceCatalogEntry,
  read: (uri: URL) => ReadResourceResult
): void {
  const uri = new URL(RESOURCE_URIS[entry.key]);
  server.registerResource(
    entry.name,
    uri.toString(),
    {
      title: entry.title,
      description: entry.description,
      mimeType: entry.mimeType,
    },
    () => read(uri)
  );
}

export function registerResources(
  server: Pick<McpServer, "registerResource">,
  deps: ResourceDeps
): void {
  let codexCliVersionCache: string | null | undefined;
  const getCodexCliVersion = (): string | null => {
    if (codexCliVersionCache !== undefined) return codexCliVersionCache;
    codexCliVersionCache = detectCodexCliVersion();
    return codexCliVersionCache;
  };

  // One reader per key of RESOURCE_URIS, so every catalog entry has one and the
  // registration follows the catalog's order.
  const readers: Record<keyof typeof RESOURCE_URIS, (uri: URL) => ReadResourceResult> = {
    serverInfo: (uri) =>
      asTextResource(uri, buildServerInfoJson(deps, getCodexCliVersion), "application/json"),
    compatReport: (uri) =>
      asTextResource(uri, buildCompatReport(deps, getCodexCliVersion()), "application/json"),
    config: (uri) =>
      asTextResource(uri, buildConfigGuideText(deps.sessionDefaults), "text/markdown"),
    gotchas: (uri) => asTextResource(uri, buildGotchasText(deps.sessionDefaults), "text/markdown"),
    quickstart: (uri) =>
      asTextResource(uri, buildQuickstartText(deps.sessionDefaults), "text/markdown"),
    errors: (uri) => asTextResource(uri, buildErrorsText(), "text/markdown"),
    delegationGuide: (uri) =>
      asTextResource(uri, buildDelegationGuideText(deps.sessionDefaults), "text/markdown"),
  };

  for (const entry of RESOURCE_CATALOG) {
    registerCatalogResource(server, entry, readers[entry.key]);
  }
}
