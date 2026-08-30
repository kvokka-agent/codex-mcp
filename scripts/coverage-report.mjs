#!/usr/bin/env bun
// Writes the Istanbul report fallow reads, from the lcov `bun test --coverage`
// left behind. `bun run coverage` runs the two in order.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeIstanbulReport } from "./lib/lcov-istanbul.mjs";

const { path, files, functions } = writeIstanbulReport(
  join(dirname(fileURLToPath(import.meta.url)), "..")
);
console.error(`Wrote ${path} (${files} files, ${functions} functions).`);
