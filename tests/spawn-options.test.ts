import { describe, expect, it } from "bun:test";
import { buildAppServerArgs } from "../src/app-server/lifecycle.js";
import { extractSpawnOptions } from "../src/utils/config.js";

describe("buildAppServerArgs", () => {
  it("passes only the subcommand when nothing is configured", () => {
    expect(buildAppServerArgs({})).toEqual(["app-server"]);
  });

  it("emits profile as -p and the remaining top-level options as -c pairs, in order", () => {
    const args = buildAppServerArgs({
      profile: "work",
      model: "o4-mini",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });

    expect(args).toEqual([
      "app-server",
      "-p",
      "work",
      "-c",
      "model=o4-mini",
      "-c",
      "approval_policy=on-request",
      "-c",
      "sandbox_mode=workspace-write",
    ]);
  });

  it("keeps advanced config after the top-level flags", () => {
    const args = buildAppServerArgs({
      model: "o4-mini",
      config: { "tools.web_search": true },
    });

    expect(args).toEqual(["app-server", "-c", "model=o4-mini", "-c", "tools.web_search=true"]);
  });

  it("JSON-encodes structured config values and stringifies null", () => {
    const args = buildAppServerArgs({
      config: { mcp_servers: { fs: { command: "npx" } }, shell: null },
    });

    expect(args).toEqual([
      "app-server",
      "-c",
      'mcp_servers={"fs":{"command":"npx"}}',
      "-c",
      "shell=null",
    ]);
  });

  it("skips empty-string options rather than emitting blank flags", () => {
    expect(buildAppServerArgs({ profile: "", model: "" })).toEqual(["app-server"]);
  });

  it("emits nothing for an empty config object", () => {
    expect(buildAppServerArgs({ config: {} })).toEqual(["app-server"]);
  });
});

const NO_DEFAULTS = { effort: "low", approvalTimeoutMs: 60000 } as const;

describe("extractSpawnOptions", () => {
  it("leaves optional fields undefined when the tool call omits them", () => {
    const opts = extractSpawnOptions(
      {
        prompt: "hello",
        approvalPolicy: "never",
        sandbox: "read-only",
      },
      NO_DEFAULTS
    );

    expect(opts).toEqual({
      profile: undefined,
      model: undefined,
      approvalPolicy: "never",
      sandbox: "read-only",
      config: undefined,
    });
  });

  it("drops advanced fields that are not spawn options", () => {
    const opts = extractSpawnOptions(
      {
        prompt: "hello",
        cwd: "/tmp/project",
        approvalPolicy: "on-failure",
        sandbox: "workspace-write",
        effort: "high",
        advanced: {
          baseInstructions: "be terse",
          developerInstructions: "prefer tests",
          personality: "pragmatic",
          summary: "concise",
          ephemeral: true,
          approvalTimeoutMs: 300000,
          images: ["/tmp/shot.png"],
          outputSchema: { type: "object" },
          config: { model_reasoning_effort: "high" },
        },
      },
      NO_DEFAULTS
    );

    expect(opts).toEqual({
      profile: undefined,
      model: undefined,
      approvalPolicy: "on-failure",
      sandbox: "workspace-write",
      config: { model_reasoning_effort: "high" },
    });
  });

  it("feeds buildAppServerArgs so advanced.config reaches the CLI flags", () => {
    const args = buildAppServerArgs(
      extractSpawnOptions(
        {
          prompt: "hello",
          approvalPolicy: "untrusted",
          sandbox: "danger-full-access",
          model: "gpt-5",
          profile: "work",
          advanced: { config: { "sandbox_workspace_write.network_access": true } },
        },
        NO_DEFAULTS
      )
    );

    expect(args).toEqual([
      "app-server",
      "-p",
      "work",
      "-c",
      "model=gpt-5",
      "-c",
      "approval_policy=untrusted",
      "-c",
      "sandbox_mode=danger-full-access",
      "-c",
      "sandbox_workspace_write.network_access=true",
    ]);
  });
});
