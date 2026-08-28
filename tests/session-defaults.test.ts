import { describe, expect, it } from "bun:test";
import { DEFAULT_APPROVAL_TIMEOUT_MS, DEFAULT_EFFORT_LEVEL } from "../src/types.js";
import { SESSION_DEFAULT_ENV, resolveSessionDefaults } from "../src/utils/session-defaults.js";

describe("resolveSessionDefaults", () => {
  it("falls back to the built-in defaults when the environment names none", () => {
    expect(resolveSessionDefaults({})).toEqual({
      model: undefined,
      effort: DEFAULT_EFFORT_LEVEL,
      approvalTimeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
    });
  });

  it("reads all three from the environment", () => {
    expect(
      resolveSessionDefaults({
        [SESSION_DEFAULT_ENV.model]: "gpt-5.6-luna",
        [SESSION_DEFAULT_ENV.effort]: "high",
        [SESSION_DEFAULT_ENV.approvalTimeoutMs]: "900000",
      })
    ).toEqual({ model: "gpt-5.6-luna", effort: "high", approvalTimeoutMs: 900000 });
  });

  it("trims what the client wrote and treats a blank value as unset", () => {
    expect(
      resolveSessionDefaults({
        [SESSION_DEFAULT_ENV.model]: "  gpt-5.6-luna  ",
        [SESSION_DEFAULT_ENV.effort]: " medium ",
        [SESSION_DEFAULT_ENV.approvalTimeoutMs]: "   ",
      })
    ).toEqual({
      model: "gpt-5.6-luna",
      effort: "medium",
      approvalTimeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
    });
  });

  it("refuses an effort level the enum does not define", () => {
    expect(() => resolveSessionDefaults({ [SESSION_DEFAULT_ENV.effort]: "highest" })).toThrow(
      `${SESSION_DEFAULT_ENV.effort}="highest" is not a reasoning effort`
    );
  });

  for (const value of ["0", "-1", "1.5", "abc", "60000ms", "Infinity"]) {
    it(`refuses an approval timeout of ${value}`, () => {
      expect(() =>
        resolveSessionDefaults({ [SESSION_DEFAULT_ENV.approvalTimeoutMs]: value })
      ).toThrow(`${SESSION_DEFAULT_ENV.approvalTimeoutMs}="${value}"`);
    });
  }

  it("reads process.env when no environment is passed", () => {
    const key = SESSION_DEFAULT_ENV.effort;
    const before = process.env[key];
    process.env[key] = "xhigh";
    try {
      expect(resolveSessionDefaults().effort).toBe("xhigh");
    } finally {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    }
  });
});
