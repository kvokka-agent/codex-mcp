import { describe, expect, it } from "bun:test";
import {
  identifyProcess,
  ownStartedAt,
  parseLstartMs,
  probePid,
} from "../src/persistence/process-identity.js";

describe("parseLstartMs", () => {
  it("reads the fields of a ps reading as UTC", () => {
    expect(parseLstartMs("Fri Aug 28 14:53:13 2026")).toBe(Date.UTC(2026, 7, 28, 14, 53, 13));
  });

  it("reads a day ps space-padded to two columns", () => {
    expect(parseLstartMs("Tue Jan  6 04:05:06 2026")).toBe(Date.UTC(2026, 0, 6, 4, 5, 6));
  });

  // `new Date` reads a string in this shape in the zone of the runtime parsing
  // it, and that is not the zone `ps` printed it in: `bun test` stands the
  // runtime at UTC while the child `ps` prints the machine's own offset.
  it("answers the same instant whatever zone the runtime stands in", () => {
    expect(parseLstartMs("Fri Aug 28 14:53:13 2026")).toBe(1787928793000);
  });

  it("answers nothing for a reading in another shape", () => {
    expect(parseLstartMs("2026-08-28T14:53:13Z")).toBeNull();
    expect(parseLstartMs("Fri Xxx 28 14:53:13 2026")).toBeNull();
    expect(parseLstartMs("")).toBeNull();
  });
});

describe("this process, read back through the sources a recorded owner is checked against", () => {
  it("is alive and is the process its own claim describes", () => {
    expect(probePid(process.pid)).toBe("alive");
    expect(identifyProcess(process.pid, ownStartedAt()).identity).toBe("match");
  });
});
