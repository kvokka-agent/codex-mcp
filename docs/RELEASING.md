# Releasing codex-mcp

A release starts with one label on a pull request and needs nothing else from you.
Add `release:major`, `release:minor` or `release:patch` before the merge, and the
merge itself raises the version, checks it, tags it and publishes it to npm.

## Before the first release

The three labels have to exist on the repository. Create them once:

```bash
gh label create release:major --repo kvokka/codex-mcp --color B60205 --description "Merging this cuts a major release"
gh label create release:minor --repo kvokka/codex-mcp --color 0E8A16 --description "Merging this cuts a minor release"
gh label create release:patch --repo kvokka/codex-mcp --color 1D76DB --description "Merging this cuts a patch release"
```

The npm trusted publisher for `@kvokka/codex-mcp` names the workflow that publishes,
which is still `.github/workflows/publish.yml` — the release run calls that file
rather than repeating what it does, and the OIDC token names the file holding the
job. If the first release run reaches the publish job and npm rejects the token,
that setting is where to look.

## The label

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

`.github/workflows/release.yml` runs on every push to `master` and holds four jobs:

1. **bump** reads the labels of the pull request whose merge produced the commit,
   through `repos/{repo}/commits/{sha}/pulls`. With no release label it stops here.
   Otherwise it runs `node scripts/release.mjs bump <level>`, which writes the new
   version into every file that carries one, commits them as
   `chore(release): vX.Y.Z` and pushes that commit to `master`.
2. **verify** calls `.github/workflows/ci.yml` on that commit — the same matrix of
   seven runners the pull request went through, plus the markdown lint.
3. **tag** creates `vX.Y.Z` on the verified commit and pushes it. Nothing is tagged
   before the matrix is green.
4. **publish** calls `.github/workflows/publish.yml` on the tag, which runs
   `npm publish --provenance --access public` from the `npm` environment. The npm
   registry authenticates the run through OIDC, so the workflow carries no token.

All four are one workflow run: the version, the tag and the published package come
out of a single link in the Actions tab.

## Where the version lives

`scripts/release.mjs` holds the list in `TARGETS`, and `tests/release.test.ts`
checks every entry against the file it names, so a file that moves fails the test
rather than the release.

| File                                          | What carries the version                       |
| --------------------------------------------- | ---------------------------------------------- |
| `package.json`                                | the npm package                                |
| `package-lock.json`                           | the package's own two records in the lock file |
| `plugins/codex-mcp/.claude-plugin/plugin.json` | the Claude Code plugin manifest                |
| `.claude-plugin/marketplace.json`             | the plugin's entry in the marketplace          |
| `plugins/codex-mcp/.mcp.json`                 | the `@kvokka/codex-mcp@X.Y.Z` pin the plugin installs |
| `plugins/codex-mcp/README.md`                 | the same pin, written out for the reader       |

The bump refuses to run when a file no longer carries the number of version
references the list expects, so a half-updated tree never reaches a tag.

Adding a place: give it an entry in `TARGETS` with a pattern matching exactly the
text around the version, and the existing test covers it.

## The CHANGELOG

`CHANGELOG.md` is written by hand, in the pull request that carries the label. The
release run does not touch it.

## When a run stops halfway

Read the run in the Actions tab and find the first red job.

**bump failed.** Nothing was written. The version files, the tags and npm are
untouched. Fix what the log names and re-run the workflow from the Actions tab.

**verify failed.** `master` carries the `chore(release): vX.Y.Z` commit, no tag
exists and npm holds nothing new. Fix the failure in a new pull request. Label that
pull request with the same level you meant, which raises the version once more —
the version the broken commit named is skipped, and skipping a number costs
nothing. To reuse the number instead, revert the release commit before merging the
fix.

**tag failed.** Same state as above plus whatever the log says about the push,
usually a tag that already exists. Delete the stale tag
(`git push origin :refs/tags/vX.Y.Z`) only after checking that npm does not already
hold that version, then re-run the failed jobs.

**publish failed.** The tag `vX.Y.Z` exists and `master` carries its version, but
npm does not have the package. Nothing needs undoing. Run the `Publish` workflow by
hand from the Actions tab with `ref` set to `vX.Y.Z`; it checks out the tag and
publishes exactly what the release run would have published. A publish that failed
because the version is already on npm needs nothing at all — the release is out.

**The run published and then something failed.** npm versions cannot be replaced.
Release the fix as a new patch.

## Checking a release

- npm: <https://www.npmjs.com/package/@kvokka/codex-mcp> shows the version and its
  provenance attestation.
- The plugin: `/plugin marketplace add kvokka/codex-mcp` in Claude Code installs the
  plugin at the version `marketplace.json` names, which pins the npm package through
  `.mcp.json`.
