import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

const RESOURCE_SCHEME = "codex-mcp";

export const RESOURCE_URIS = {
  serverInfo: `${RESOURCE_SCHEME}:///server-info`,
  compatReport: `${RESOURCE_SCHEME}:///compat-report`,
  config: `${RESOURCE_SCHEME}:///config`,
  gotchas: `${RESOURCE_SCHEME}:///gotchas`,
  quickstart: `${RESOURCE_SCHEME}:///quickstart`,
  errors: `${RESOURCE_SCHEME}:///errors`,
  delegationGuide: `${RESOURCE_SCHEME}:///delegation-guide`,
} as const;

export interface ResourceCatalogEntry {
  key: keyof typeof RESOURCE_URIS;
  name: string;
  title: string;
  description: string;
  mimeType: string;
}

export const RESOURCE_CATALOG: ResourceCatalogEntry[] = [
  {
    key: "serverInfo",
    name: "server_info",
    title: "Server Info",
    description: "Server metadata and runtime capabilities",
    mimeType: "application/json",
  },
  {
    key: "compatReport",
    name: "compat_report",
    title: "Compat Report",
    description: "Capability and runtime compatibility report",
    mimeType: "application/json",
  },
  {
    key: "config",
    name: "config",
    title: "Config Guide",
    description: "Parameter guide and config.toml mapping",
    mimeType: "text/markdown",
  },
  {
    key: "gotchas",
    name: "gotchas",
    title: "Gotchas",
    description: "Practical limits and common issues",
    mimeType: "text/markdown",
  },
  {
    key: "quickstart",
    name: "quickstart",
    title: "Quickstart",
    description: "Minimal end-to-end workflow",
    mimeType: "text/markdown",
  },
  {
    key: "errors",
    name: "errors",
    title: "Errors",
    description: "Error code reference and recovery hints",
    mimeType: "text/markdown",
  },
  {
    key: "delegationGuide",
    name: "delegation_guide",
    title: "Delegation Guide",
    description: "Best practices for delegating tasks to Codex",
    mimeType: "text/markdown",
  },
];

export function asTextResource(uri: URL, text: string, mimeType: string): ReadResourceResult {
  return {
    contents: [
      {
        uri: uri.toString(),
        text,
        mimeType,
      },
    ],
  };
}
