import { describe, expect, it } from "vitest";
import {
  buildEffortFallbackWarning,
  classifyTurnCompatibilityError,
  compatibilityErrorMessage,
  toFriendlyTurnCompatibilityError,
} from "../src/utils/turn-compat.js";

describe("classifyTurnCompatibilityError", () => {
  it("classifies an error naming minimal effort and web_search", () => {
    const err = new Error(
      "unsupported reasoning_effort=minimal when the web_search tool is enabled"
    );
    expect(classifyTurnCompatibilityError(err)).toBe("minimal_web_search");
  });

  it("matches the spaced spellings of web search and reasoning effort", () => {
    expect(
      classifyTurnCompatibilityError("Minimal reasoning effort cannot use web search here")
    ).toBe("minimal_web_search");
  });

  it("returns undefined when one of the three markers is missing", () => {
    expect(classifyTurnCompatibilityError(new Error("minimal effort is fine"))).toBeUndefined();
    expect(
      classifyTurnCompatibilityError(new Error("web_search failed with reasoning_effort=low"))
    ).toBeUndefined();
    expect(
      classifyTurnCompatibilityError(new Error("minimal web_search quota exceeded"))
    ).toBeUndefined();
  });

  it("stringifies non-Error values before matching", () => {
    expect(
      classifyTurnCompatibilityError({
        toString: () => "MINIMAL effort rejected by web_search",
      })
    ).toBe("minimal_web_search");
    expect(classifyTurnCompatibilityError(undefined)).toBeUndefined();
  });
});

describe("compatibilityErrorMessage", () => {
  it("names the error code and the remedy", () => {
    const message = compatibilityErrorMessage("minimal_web_search");
    expect(message).toContain("Error [INVALID_ARGUMENT]:");
    expect(message).toContain("effort=minimal is incompatible with the Codex web_search tool");
    expect(message).toContain("Use effort=low or higher");
  });
});

describe("toFriendlyTurnCompatibilityError", () => {
  it("replaces a recognized error with the friendly message", () => {
    const friendly = toFriendlyTurnCompatibilityError(
      new Error("reasoning_effort minimal is not compatible with web_search")
    );
    expect(friendly).toBeInstanceOf(Error);
    expect(friendly.message).toBe(compatibilityErrorMessage("minimal_web_search"));
  });

  it("passes an unrelated Error through unchanged", () => {
    const original = new Error("connection reset");
    expect(toFriendlyTurnCompatibilityError(original)).toBe(original);
  });

  it("wraps an unrelated non-Error value", () => {
    const wrapped = toFriendlyTurnCompatibilityError("boom");
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe("boom");
  });
});

describe("buildEffortFallbackWarning", () => {
  it("names both the rejected and the retried effort", () => {
    expect(buildEffortFallbackWarning("minimal", "low")).toBe(
      "effort=minimal is incompatible with the Codex web_search tool in this CLI build; automatically retried with effort=low."
    );
  });
});
