# codex-schema (vendored)

This directory vendors the JSON Schema bundle generated from the local `codex app-server` protocol.

`codex-schema/metadata.json` is the only place recording which CLI version produced this bundle,
when, and with which command.

We commit it to git to:

- Make protocol changes reviewable (schema diffs in PRs).
- Keep `src/app-server/protocol.ts` and the session/approval logic aligned with a pinned protocol snapshot.
- Avoid “works on my machine” drift caused by different local `codex` versions.

`tests/protocol-schema.test.ts` compares this bundle with `src/app-server/protocol.ts`: every method
constant, every parameter field and the `AskForApproval` union. A regenerated bundle fails that test
wherever the TypeScript model no longer matches.

## How to update

1. Ensure you have the desired `codex` CLI version installed.
2. Regenerate the bundle:

```bash
codex app-server generate-json-schema --experimental --out codex-schema
```

3. Update `codex-schema/metadata.json`.
4. Run `bun test tests/protocol-schema.test.ts` and resolve every reported difference — by
   extending `src/app-server/protocol.ts`, or by recording the reason in that test's exception lists.
