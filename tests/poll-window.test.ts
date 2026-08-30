/**
 * PollWindow: the long-poll budget, and what an MCP client's cut teaches it.
 *
 * Every asserted number comes out of the class under test; the environment it
 * reads is the only thing supplied.
 */
import { describe, expect, it } from "bun:test";
import { MAX_LONG_POLL_WAIT_MS } from "../src/types/index.js";
import {
  MIN_POLL_WINDOW_MS,
  POLL_WINDOW_MARGIN_MS,
  PollWindow,
  SDK_DEFAULT_TOOL_TIMEOUT_MS,
} from "../src/utils/poll-window.js";

describe("PollWindow", () => {
  describe("the ceiling it starts from", () => {
    it("holds an unidentified client to the MCP SDK's own request timeout", () => {
      const window = new PollWindow({});

      expect(window.ceilingMs()).toBe(SDK_DEFAULT_TOOL_TIMEOUT_MS);
      expect(window.budgetMs()).toBe(SDK_DEFAULT_TOOL_TIMEOUT_MS - POLL_WINDOW_MARGIN_MS);
      expect(window.describe().source).toBe("client-default");
    });

    it("claims no ceiling for a client measured to apply none", () => {
      const window = new PollWindow({ CLAUDECODE: "1" });

      expect(window.ceilingMs()).toBeUndefined();
      expect(window.budgetMs()).toBe(MAX_LONG_POLL_WAIT_MS);
      expect(window.describe().source).toBe("none");
    });

    it("takes the ceiling MCP_TOOL_TIMEOUT declares over the client default", () => {
      const window = new PollWindow({ CLAUDECODE: "1", MCP_TOOL_TIMEOUT: "45000" });

      expect(window.ceilingMs()).toBe(45_000);
      expect(window.budgetMs()).toBe(45_000 - POLL_WINDOW_MARGIN_MS);
      expect(window.describe().source).toBe("declared");
    });

    it("ignores an MCP_TOOL_TIMEOUT that names no usable number", () => {
      for (const raw of ["", "soon", "0", "-1", "NaN"]) {
        expect(new PollWindow({ MCP_TOOL_TIMEOUT: raw }).ceilingMs()).toBe(
          SDK_DEFAULT_TOOL_TIMEOUT_MS
        );
      }
    });

    it("hands out no window at all when the ceiling leaves none worth holding", () => {
      const tooShort = new PollWindow({ MCP_TOOL_TIMEOUT: "200" });
      const justShort = new PollWindow({
        MCP_TOOL_TIMEOUT: String(POLL_WINDOW_MARGIN_MS + MIN_POLL_WINDOW_MS - 1),
      });
      const justEnough = new PollWindow({
        MCP_TOOL_TIMEOUT: String(POLL_WINDOW_MARGIN_MS + MIN_POLL_WINDOW_MS),
      });

      expect(tooShort.ceilingMs()).toBe(200);
      expect(tooShort.budgetMs()).toBe(0);
      expect(justShort.budgetMs()).toBe(0);
      expect(justEnough.budgetMs()).toBe(MIN_POLL_WINDOW_MS);
    });
  });

  describe("what a cut teaches it", () => {
    it("takes the measured cut over both the declaration and the default", () => {
      const window = new PollWindow({ CLAUDECODE: "1", MCP_TOOL_TIMEOUT: "600000" });
      const before = window.budgetMs();

      window.recordCut(30_020, "SdkError: Request timed out");

      expect(before).toBe(600_000 - POLL_WINDOW_MARGIN_MS);
      expect(window.ceilingMs()).toBe(30_020);
      expect(window.budgetMs()).toBe(30_020 - POLL_WINDOW_MARGIN_MS);
      expect(window.describe().source).toBe("measured");
    });

    it("keeps the shortest cut, so a later long call cannot raise the ceiling back", () => {
      const window = new PollWindow({ CLAUDECODE: "1" });

      window.recordCut(120_000, "Request timed out");
      window.recordCut(60_000, "SdkError: Request timed out");
      window.recordCut(300_000, "timeout");

      expect(window.ceilingMs()).toBe(60_000);
    });

    it("learns nothing from an abort the client did not blame on its clock", () => {
      const window = new PollWindow({ CLAUDECODE: "1" });

      window.recordCut(1_000, "User pressed escape");
      window.recordCut(1_000, undefined);
      window.recordCut(1_000, new Error("Request timed out"));

      expect(window.ceilingMs()).toBeUndefined();
      expect(window.describe().source).toBe("none");
    });

    it("learns nothing from a duration that is not one", () => {
      const window = new PollWindow({});

      window.recordCut(0, "Request timed out");
      window.recordCut(-5, "Request timed out");
      window.recordCut(Number.NaN, "Request timed out");

      expect(window.ceilingMs()).toBe(SDK_DEFAULT_TOOL_TIMEOUT_MS);
    });
  });
});
