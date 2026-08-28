import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");

const LEVEL = { none: 0, read: 1, write: 2 } as const;
type Scope = string;
type Permissions = Record<Scope, keyof typeof LEVEL>;
type Step = { run?: string };
type Job = { uses?: string; permissions?: Permissions; steps?: Step[] };
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };

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

// npm matches a package's trusted publisher against the `workflow_ref` claim, which
// names the file holding the job that started the run — `release.yml` for both a merge
// and a hand-started publish, and never the called `publish.yml` the claim carries in
// `job_workflow_ref`. One file name is configured on npmjs.com, so exactly one file may
// start a run that publishes.
describe("the workflow npm sees", () => {
  const publishing = readdirSync(WORKFLOWS).filter((file) =>
    Object.values(workflow(file).jobs).some((job) =>
      job.steps?.some((step) => step.run?.includes("npm publish"))
    )
  );

  it("holds npm publish in publish.yml alone", () => {
    expect(publishing).toEqual(["publish.yml"]);
  });

  it.each(publishing)("lets nothing but a caller start %s", (file) => {
    expect(Object.keys(workflow(file).on)).toEqual(["workflow_call"]);
  });

  it("gives release.yml the trigger that publishes a tag by hand", () => {
    expect(workflow("release.yml").on).toHaveProperty("workflow_dispatch");
  });
});
