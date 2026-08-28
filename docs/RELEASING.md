# Releasing codex-mcp

A release starts with one label on a pull request and needs nothing else from you.
Add `release:major`, `release:minor` or `release:patch` before the merge, and the
merge itself raises the version in all six files that carry it, checks that tree,
tags it and publishes it to npm.

## The label

The three labels exist on <https://github.com/kvokka/codex-mcp>:

| Label            | 2.2.0 becomes | Use it for                                            |
| ---------------- | ------------- | ----------------------------------------------------- |
| `release:patch`  | 2.2.1         | a fix that keeps every tool call working as it did     |
| `release:minor`  | 2.3.0         | a new tool, a new parameter, a new optional behaviour  |
| `release:major`  | 3.0.0         | a change that breaks a caller of an existing tool      |

A pull request without a `release:*` label merges without releasing anything. The
release run says so in its log and ends green — merging documentation or a refactor
is not a failure.

Two `release:*` labels at once, or a label such as `release:hotfix`, fail the run
before it writes anything. Fix the labels and re-run the `Release` workflow, or
merge an empty follow-up pull request carrying the label you meant.

## What the merge does

`.github/workflows/release.yml` runs on every push to `master` and holds four jobs.
`master` moves in the third of them, after the matrix has passed.

1. **prepare** reads the labels of the pull request whose merge produced the commit,
   through `repos/{repo}/commits/{sha}/pulls`. With no release label the job ends
   here and the three below it are skipped. With one it runs
   `bun scripts/release.mjs bump <level>` on the tip of `master`, commits the
   version files as `chore(release): vX.Y.Z` and pushes that commit to a branch of
   its own, `release-candidate/<run id>-<attempt>`. `master` does not move.
2. **verify** calls `.github/workflows/ci.yml` on the candidate commit — the same
   matrix of six runners the pull request went through, plus the markdown lint. It
   checks the tree that ships, the raised version files included.
3. **promote** fast-forwards `master` to the candidate commit and pushes the tag
   `vX.Y.Z` in one `git push --atomic`, then deletes the candidate branch. This is
   the first moment `master` carries the new version, and the tag names the exact
   commit the matrix passed on.
4. **publish** calls `.github/workflows/publish.yml` on the tag, which runs
   `npm publish --provenance --access public` from the `npm` environment. The npm
   registry authenticates the run through OIDC, so the workflow carries no token.
   The job runs in `kvokka/codex-mcp` and nowhere else: a fork that merges a
   labelled pull request raises its own version and tags its own copy, and its run
   reaches this job, skips it and ends green.

A red matrix leaves `master`, the tags and npm as they were. The candidate branch is
the only thing such a run wrote, and it holds the commit that failed.

All four are one workflow run: the version, the tag and the published package come
out of a single link in the Actions tab.

The same workflow takes a `ref` by hand from the Actions tab. Given a tag it runs
`publish` alone, which is how a tag that exists without its npm version reaches npm —
see **publish failed** below.

## Two merges close together

`concurrency: release-${{ github.ref }}` with `cancel-in-progress: false` runs one
release at a time. A merge that lands while a release runs waits for it, then reads
`master` as that release left it and raises the version once more — 2.3.0 followed
by 2.3.1.

`promote` compares `master` against the commit `prepare` built on. A commit that
reached `master` while the matrix ran — a second merge, a direct push — makes the two
differ, and the job stops with the message before it tags anything. Re-run the
workflow from the Actions tab: the new run builds a candidate on the current tip and
checks that one. The atomic push behind that check covers the seconds after it,
because GitHub rejects the tag together with a branch update it refuses.

GitHub keeps at most one run waiting per concurrency group, so three merges in quick
succession cancel the middle run before it starts. Its label cuts no version, and its
code ships in the version the last merge cuts. Merge labelled pull requests one at a
time, or re-run the cancelled release from the Actions tab.

## The npm trusted publisher

The trusted publisher of `@kvokka/codex-mcp` on npmjs.com carries these values:

| Field                | Value         |
| -------------------- | ------------- |
| Organization or user | `kvokka`      |
| Repository           | `codex-mcp`   |
| Workflow filename    | `release.yml` |
| Environment name     | `npm`         |

`release.yml` and not `publish.yml`, because npm matches the workflow filename against
the `workflow_ref` claim of the GitHub token, and that claim names the file the run
started in. A merge and a hand-started publish both start in `release.yml`; the
`publish.yml` it calls reaches the token only as `job_workflow_ref`, which npm reads
nothing from. npm states the rule under
[Troubleshooting](https://docs.npmjs.com/trusted-publishers): "Some GitHub Actions
workflows use `workflow_call` to invoke other workflows that run `npm publish`, or use
`workflow_dispatch` for manual publishing. When this happens, validation checks the
calling workflow's name instead of the workflow that actually contains the publish
command, which can cause configuration mismatches."

That is why `publish.yml` carries `workflow_call` and no trigger of its own, and why
`tests/workflows.test.ts` fails when a second file grows a publish step or `publish.yml`
grows a trigger: npm holds one workflow filename per package, so one file may start a
run that publishes.

npm checks nothing when the configuration is saved, and the registry answers a token it
does not accept with `404 package not found` — what it also answers for a package that
does not exist. The publish step therefore runs at `NPM_CONFIG_LOGLEVEL: verbose`, which
puts the reason the registry gave into the log:

```text
verbose oidc Failed token exchange request with body message: OIDC token exchange error - package not found
```

Without that line a rejected token reads as `npm error code E404` on the package URL,
naming neither the token nor the publisher.

A repository secret `NPM_TOKEN` publishes instead when it exists — the workflow passes it
as `NODE_AUTH_TOKEN`, and npm prefers the OIDC token whenever the exchange succeeds.

## Where the version lives

`scripts/release.mjs` holds the list in `TARGETS`, and `tests/release.test.ts`
checks every entry against the file it names, so a file that moves fails the test
rather than the release.

| File                                          | What carries the version                       |
| --------------------------------------------- | ---------------------------------------------- |
| `package.json`                                | the npm package                                |
| `plugins/codex-mcp/.claude-plugin/plugin.json` | the Claude Code plugin manifest                |
| `.claude-plugin/marketplace.json`             | the plugin's entry in the marketplace          |
| `plugins/codex-mcp/.mcp.json`                 | the `@kvokka/codex-mcp@X.Y.Z` pin the plugin installs |
| `plugins/codex-mcp/README.md`                 | the same pin, written out for the reader       |

The bump refuses to run when a file no longer carries the number of version
references the list expects, so a half-updated tree never reaches a tag.

Adding a place: give it an entry in `TARGETS` with a pattern matching exactly the
text around the version, and add its path to the list `tests/release.test.ts`
pins. The per-target checks then cover the new entry on their own; the list is
an equality check and fails until it names the file.

## The CHANGELOG

`CHANGELOG.md` is written by hand, in the pull request that carries the label. The
release run does not touch it.

## When a run stops halfway

Read the run in the Actions tab and find the first red job.

**The run is `Startup failure` and lists no jobs.** GitHub rejected the workflow file
before it started anything, and the run page names the reason under `Invalid workflow
file`. Nothing was released and nothing needs undoing; fix the file and merge the fix
with the label you meant.

**prepare failed.** Nothing was released. `master`, the tags and npm are untouched.
Fix what the log names and re-run the workflow from the Actions tab.

**verify failed.** Nothing was released. `master` carries no version commit, no tag
exists and npm holds nothing new. The branch `release-candidate/<run id>-<attempt>`
holds the commit the matrix rejected: read the failure against it, then delete the
branch. Fix the failure in a new pull request carrying the label you meant. The
version the rejected candidate named is still free, and the next run takes it.

**promote failed.** Ask git which refs moved:

```bash
git ls-remote origin refs/heads/master 'refs/tags/vX.Y.Z'
```

The push is atomic, so the branch and the tag moved together or not at all. Neither
moved — the log says `master` moved during the matrix, or the push was rejected: the
state is the one **verify failed** describes, and re-running the workflow builds a
fresh candidate on the current tip. Both moved — the release is on `master` and
tagged, and only the candidate branch deletion failed: delete
`release-candidate/<run id>-<attempt>` by hand and re-run the failed jobs so
**publish** gets its turn.

**publish failed.** The tag `vX.Y.Z` exists and `master` carries its version, but npm
does not have the package. Nothing needs undoing, and the version stays the one the tag
names. Run the `Release` workflow by hand with `ref` set to that tag:

```bash
gh workflow run release.yml --repo kvokka/codex-mcp --ref master -f ref=vX.Y.Z
```

The run skips `prepare`, `verify` and `promote` — it raises no version and moves no
branch — and goes straight to `publish`, which checks out the tag and publishes exactly
what the failed run would have published. Start it from `release.yml` and not from
`publish.yml`: the trusted publisher matches the file the run starts in.

A publish that failed because the version is already on npm needs nothing at all — the
release is out.

**The run published and then something failed.** npm versions cannot be replaced.
Release the fix as a new patch.

Candidate branches left behind by a failed run are safe to delete once you have read
them; nothing but that run refers to them.

## Checking a release

- npm: <https://www.npmjs.com/package/@kvokka/codex-mcp> shows the version and its
  provenance attestation.
- The plugin: `/plugin marketplace add kvokka/codex-mcp` in Claude Code installs the
  plugin at the version `marketplace.json` names, which pins the npm package through
  `.mcp.json`.
