import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
// @ts-expect-error -- plain ESM, shared with the script that runs it.
import { BADGE_PATH } from "../scripts/lib/fallow-badge.mjs";

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");

const LEVEL = { none: 0, read: 1, write: 2 } as const;
type Scope = string;
type Permissions = Record<Scope, keyof typeof LEVEL>;
type Step = { run?: string; uses?: string; with?: Record<string, unknown> };
type Job = {
  uses?: string;
  needs?: string[];
  if?: string;
  permissions?: Permissions;
  steps?: Step[];
};
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

// A plugin dependency's version range resolves against `{plugin-name}--v{version}` tags
// and no other form, so a release that pushes `v{version}` alone leaves every dependent
// plugin at `no-matching-tag`.
describe("the release tags", () => {
  const promote = workflow("release.yml").jobs.promote;
  const step = promote.steps?.find((each) => each.run?.includes("git tag")) as Step;

  it("carries the plugin tag beside the version tag", () => {
    expect(step.run).toContain('git tag "v$VERSION" "$SHA"');
    expect(step.run).toContain("bun scripts/release.mjs tag");
    expect(step.run).toContain('git tag "$plugin_tag" "$SHA"');
  });

  it("pushes the branch and both tags in one atomic push", () => {
    const push = (step.run as string)
      .split("\n")
      .join(" ")
      .replace(/\\\s+/g, " ")
      .split(" git ")
      .find((command) => command.startsWith("push --atomic")) as string;

    expect(push).toContain("refs/tags/v$VERSION");
    expect(push).toContain("refs/tags/$plugin_tag");
  });

  it("gives the job the bun that names the tag", () => {
    expect(promote.steps?.some((each) => each.uses?.startsWith("oven-sh/setup-bun@"))).toBe(true);
  });
});

// The badge job pushes to the release branch after `promote` moved it, and what it
// pushes is what `bun run badge` measured. Every mistake below leaves the release
// green and the badge stale, weeks after the change that made it.
describe("the release badge job", () => {
  const badge = workflow("release.yml").jobs.badge;
  const steps = badge.steps ?? [];
  const runs = steps.map((step) => step.run ?? "");

  it("runs only where the release moved the branch", () => {
    expect(badge.needs).toEqual(["prepare", "promote"]);
    // `promote` is skipped by a merge that cut no version and by a hand-started
    // publish, and `needs` carries that skip here — an `always()` would not.
    expect(badge.if).toBeUndefined();
  });

  it("measures the commit the release tagged", () => {
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@")) as Step;

    expect(checkout.with?.ref).toBe("${{ needs.prepare.outputs.sha }}");
    expect(checkout.with?.["fetch-depth"]).toBe(0);
  });

  // `fallow health` scores against the Istanbul report `.fallowrc.jsonc` names and
  // exits 2 without it, so the suite has to run under coverage first.
  it("runs the coverage the score is read from before reading it", () => {
    expect(runs.indexOf("bun run coverage")).toBeGreaterThanOrEqual(0);
    expect(runs.indexOf("bun run badge")).toBeGreaterThan(runs.indexOf("bun run coverage"));
  });

  it("commits the file the badge script writes, and nothing else", () => {
    const push = runs.find((run) => run.includes("git push")) as string;

    expect(push).toContain(`git commit -m "chore(release): score v$VERSION [skip ci]"`);
    expect(push).toContain(`-- ${BADGE_PATH}`);
    expect(push).toContain(`git diff --quiet -- ${BADGE_PATH}`);
  });

  // The tags `promote` pushed sit on the branch tip this commit fast-forwards; a
  // forced push would take the release out from under them.
  it("pushes the badge commit as a plain fast-forward", () => {
    const push = runs.find((run) => run.includes("git push")) as string;

    expect(push).toContain('git push origin "HEAD:refs/heads/$RELEASE_BRANCH"');
    expect(push).not.toContain("--force");
    expect(badge.permissions?.contents).toBe("write");
  });
});
