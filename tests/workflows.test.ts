import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");

const LEVEL = { none: 0, read: 1, write: 2 } as const;
type Scope = string;
type Permissions = Record<Scope, keyof typeof LEVEL>;
type Job = { uses?: string; permissions?: Permissions };
type Workflow = { jobs: Record<string, Job> };

const workflow = (file: string) => parse(readFileSync(join(WORKFLOWS, file), "utf8")) as Workflow;

// What a `permissions` block gives one scope. A block that names the scope gives what it
// says; a block that leaves it out gives none, and so does a job with no block at all.
const granted = (permissions: Permissions | undefined, scope: Scope) =>
  LEVEL[permissions?.[scope] ?? "none"];

const calls = readdirSync(WORKFLOWS).flatMap((file) =>
  Object.entries(workflow(file).jobs)
    .filter(([, job]) => job.uses?.startsWith("./.github/workflows/"))
    .map(([name, job]) => ({ file, name, job, called: basename(job.uses as string) }))
);

describe("a job calling a reusable workflow of this repository", () => {
  it("is the pair release.yml makes", () => {
    expect(calls.map((call) => `${call.file}:${call.name} -> ${call.called}`)).toEqual([
      "release.yml:verify -> ci.yml",
      "release.yml:publish -> publish.yml",
    ]);
  });

  // GitHub refuses a file whose called job asks the token for more than the calling job
  // holds, and it refuses it at startup, before a step runs: "The nested job 'publish' is
  // requesting 'id-token: write', but is only allowed 'id-token: none'." The refusal reads
  // both files at once, which is why actionlint passes a file that carries it.
  it.each(calls)("$file/$name grants $called every permission it asks for", (call) => {
    const asked = Object.values(workflow(call.called).jobs).flatMap((job) =>
      Object.entries(job.permissions ?? {})
    );

    for (const [scope, level] of asked) {
      expect(
        granted(call.job.permissions, scope),
        `${call.file} job ${call.name} owes ${call.called} ${scope}: ${level}`
      ).toBeGreaterThanOrEqual(LEVEL[level]);
    }
  });
});
