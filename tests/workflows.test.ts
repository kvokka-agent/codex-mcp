import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
// @ts-expect-error -- plain ESM, shared with the script that runs it.
import { BADGES, badgeOutput } from "../scripts/lib/badge-file.mjs";

const WORKFLOWS = join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");

const LEVEL = { none: 0, read: 1, write: 2 } as const;
type Scope = string;
type Permissions = Record<Scope, keyof typeof LEVEL>;
type Step = {
  id?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  uses?: string;
  needs?: string[];
  if?: string;
  permissions?: Permissions;
  outputs?: Record<string, string>;
  steps?: Step[];
};
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };

const workflow = (file: string) => parse(readFileSync(join(WORKFLOWS, file), "utf8")) as Workflow;

/** One `git …` command of a run block, with the line continuations joined up. */
const gitCommand = (run: string, starts: string) =>
  run
    .split("\n")
    .join(" ")
    .replace(/\\\s+/g, " ")
    .split(" git ")
    .find((command) => command.startsWith(starts)) as string;

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
    const push = gitCommand(step.run as string, "push --atomic");

    expect(push).toContain("refs/tags/v$VERSION");
    expect(push).toContain("refs/tags/$plugin_tag");
  });

  it("gives the job the bun that names the tag", () => {
    expect(promote.steps?.some((each) => each.uses?.startsWith("oven-sh/setup-bun@"))).toBe(true);
  });
});

// Both README badges are measured by the job that runs the suite under coverage and
// committed by the job that moves the release branch. Every mistake below leaves a
// release green and a badge stale, or puts a tag on a commit nothing checked.
describe("the badges the release commits", () => {
  const ci = workflow("ci.yml");
  const check = ci.jobs.check;
  const release = workflow("release.yml");
  const promote = release.jobs.promote;
  const git = promote.steps?.find((each) => each.run?.includes("git tag"))?.run as string;
  // The output name each badge travels under — read off the line the script writes
  // to `$GITHUB_OUTPUT` — and the file each is written to.
  const names = Object.keys(BADGES as Record<string, string>).map((label) => {
    const line = badgeOutput({ label }) as string;
    return line.slice(0, line.indexOf("="));
  });
  const paths = Object.values(BADGES as Record<string, string>).join(" ");

  it("is measured where the suite already ran under coverage", () => {
    const runs = (check.steps ?? []).map((step) => step.run ?? "");

    expect(runs.indexOf("bun run lint:fallow")).toBeGreaterThanOrEqual(0);
    expect(runs.findIndex((run) => run.startsWith("bun run badge"))).toBeGreaterThan(
      runs.indexOf("bun run lint:fallow")
    );
  });

  // The suite under coverage is the expensive half of a release and it runs in
  // `verify`. A release job that ran it again would be measuring a second time what
  // the matrix already answered — and would need the build the e2e tests spawn.
  it("runs the suite once a release, in the workflow that checks the commit", () => {
    const runs = Object.values(release.jobs).flatMap((job) =>
      (job.steps ?? []).map((step) => step.run ?? "")
    );

    expect(runs.filter((run) => /bun (run coverage|run test|test)\b/.test(run))).toEqual([]);
  });

  // A reusable workflow's output takes three declarations to reach its caller: the
  // step writes `$GITHUB_OUTPUT`, the job names it in `outputs`, and `workflow_call`
  // names it again with the job's value. A name that stops matching anywhere along
  // the chain arrives as the empty string, months later, in the release.
  it("carries each document from the step that wrote it to the caller of ci.yml", () => {
    const step = (check.steps ?? []).find((each) => each.run?.startsWith("bun run badge")) as Step;
    const called = ci.on.workflow_call as { outputs: Record<string, { value: string }> };

    expect(Object.keys(check.outputs ?? {})).toEqual(names);
    expect(Object.keys(called.outputs)).toEqual(names);
    for (const name of names) {
      expect(check.outputs?.[name]).toBe(`\${{ steps.${step.id}.outputs.${name} }}`);
      expect(called.outputs[name]?.value).toBe(`\${{ jobs.check.outputs.${name} }}`);
    }
  });

  it("gives promote what verify answered, and writes no document it made up", () => {
    const step = promote.steps?.find((each) => each.run?.includes("badges.mjs write")) as Step;

    expect(promote.needs).toContain("verify");
    expect(Object.values(step.env ?? {})).toEqual(
      names.map((name) => `\${{ needs.verify.outputs.${name} }}`)
    );
    for (const variable of Object.keys(step.env ?? {})) {
      expect(step.run).toContain(`"$${variable}"`);
    }
  });

  // The commit carrying the badges is checked by nothing: it is written after the
  // matrix passed, out of two documents the matrix measured. So the tags name $SHA,
  // the commit `verify` ran on, and the branch alone moves to its child.
  it("tags the verified commit and moves the branch to the badge commit", () => {
    const push = gitCommand(git, "push --atomic");

    expect(git).toContain('git tag "v$VERSION" "$SHA"');
    expect(git).toContain('git tag "$plugin_tag" "$SHA"');
    expect(git).toContain('head="$SHA"');
    expect(git).toContain("head=$(git rev-parse HEAD)");
    expect(push).toContain('"$head:refs/heads/$RELEASE_BRANCH"');
    expect(push).not.toContain("$SHA:refs/heads/");
  });

  it("writes the badge commit onto the verified commit and nothing else", () => {
    const checkout = promote.steps?.find((step) =>
      step.uses?.startsWith("actions/checkout@")
    ) as Step;

    expect(checkout.with?.ref).toBe("${{ needs.prepare.outputs.sha }}");
    // git proves the fast-forward out of the history between the branch and the
    // commit, and the default depth of 1 carries none of it.
    expect(checkout.with?.["fetch-depth"]).toBe(0);
    expect(git).toContain(`git diff --quiet -- ${paths}`);
    expect(git).toContain(`-- ${paths}`);
    expect(git).not.toContain("git reset");
    expect(git).not.toContain("--force");
    expect(promote.permissions?.contents).toBe("write");
  });

  // `[skip ci]` is read off the head commit of a push, which this commit is, so it
  // keeps the branch update from starting a release run over two generated documents.
  it("marks the badge commit so it starts no run of its own", () => {
    expect(git).toContain(`git commit -m "chore(release): badges v$VERSION [skip ci]"`);
  });

  it("happens in the job that moves the branch, rather than in one of its own", () => {
    expect(Object.keys(release.jobs)).toEqual(["prepare", "verify", "promote", "publish"]);
  });
});

// Ten points of this repository's health score are the hotspot penalty, which fallow
// reads out of the commits of the last six months. Over the default depth of 1 no file
// is a hotspot, the penalty comes out 0, and the score the gate prints climbs to 95
// against the 85 the badge carries.
describe("the ci check job", () => {
  const check = workflow("ci.yml").jobs.check;
  const steps = check.steps ?? [];

  it("checks the tree out with the history the health score is read from", () => {
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@")) as Step;

    expect(checkout.with?.["fetch-depth"]).toBe(0);
  });
});
