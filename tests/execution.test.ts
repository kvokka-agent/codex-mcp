import { describe, expect, it } from "bun:test";
import type { ProgressInfo } from "../src/types/index.js";
import {
  coerceProgressForStatus,
  interactionStateForStatus,
  recommendedNextActionForStatus,
} from "../src/utils/execution.js";

describe("interactionStateForStatus", () => {
  it("maps every status to its interaction state", () => {
    expect(interactionStateForStatus("waiting_approval")).toBe("waiting_input");
    expect(interactionStateForStatus("idle")).toBe("finished");
    expect(interactionStateForStatus("error")).toBe("finished");
    expect(interactionStateForStatus("cancelled")).toBe("finished");
    expect(interactionStateForStatus("running")).toBe("working");
  });
});

describe("recommendedNextActionForStatus", () => {
  it("prefers user input over approval while waiting", () => {
    expect(recommendedNextActionForStatus("waiting_approval", ["approval", "user_input"])).toBe(
      "respond_user_input"
    );
  });

  it("asks for a permission answer when only an approval is pending", () => {
    expect(recommendedNextActionForStatus("waiting_approval", ["approval"])).toBe(
      "respond_permission"
    );
  });

  it("falls back to polling when waiting without a known pending action", () => {
    expect(recommendedNextActionForStatus("waiting_approval")).toBe("poll");
  });

  it("asks for nothing on a terminal status and to poll while running", () => {
    expect(recommendedNextActionForStatus("idle")).toBe("none");
    expect(recommendedNextActionForStatus("cancelled")).toBe("none");
    expect(recommendedNextActionForStatus("running")).toBe("poll");
  });
});

describe("coerceProgressForStatus", () => {
  const progress: ProgressInfo = {
    phase: "running",
    lastEventAt: "2024-01-01T00:00:00.000Z",
    pendingActionCount: 2,
  };

  it("returns undefined without a progress object", () => {
    expect(coerceProgressForStatus("idle", undefined)).toBeUndefined();
  });

  it("forces the phase to match a terminal status and clears pending actions", () => {
    expect(coerceProgressForStatus("idle", progress)).toMatchObject({
      phase: "finished",
      pendingActionCount: 0,
    });
    expect(coerceProgressForStatus("error", progress)).toMatchObject({ phase: "error" });
    expect(coerceProgressForStatus("cancelled", progress)).toMatchObject({ phase: "cancelled" });
  });

  it("keeps the highest pending action count while waiting for approval", () => {
    expect(
      coerceProgressForStatus("waiting_approval", progress, { pendingActionCount: 5 })
    ).toMatchObject({ phase: "waiting_approval", pendingActionCount: 5 });
    expect(
      coerceProgressForStatus("waiting_approval", progress, { pendingActionCount: 1 })
    ).toMatchObject({ pendingActionCount: 2 });
  });

  it("keeps the reported phase and pending count while running", () => {
    expect(coerceProgressForStatus("running", progress)).toEqual({
      phase: "running",
      lastEventAt: "2024-01-01T00:00:00.000Z",
      pendingActionCount: 2,
    });
  });

  it("overrides lastEventAt with the completion timestamp when given", () => {
    expect(
      coerceProgressForStatus("idle", progress, { completedAt: "2024-02-02T00:00:00.000Z" })
    ).toMatchObject({ lastEventAt: "2024-02-02T00:00:00.000Z" });
  });
});
