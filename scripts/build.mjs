#!/usr/bin/env bun
// Builds what the package ships: one bundled ESM entry point that Node runs,
// and the declarations beside it.
//
// `bun build` writes no declarations, so `tsc --emitDeclarationOnly` writes
// those; `package.json` runs the two in order.

import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const outdir = join(root, "dist");

rmSync(outdir, { recursive: true, force: true });

const built = await Bun.build({
  entrypoints: [join(root, "src/index.ts")],
  outdir,
  target: "node",
  format: "esm",
  sourcemap: "linked",
  // `src/server.ts` and `src/app-server/client.ts` read this to tell the MCP
  // client and the app-server which version is speaking to them.
  define: { __PKG_VERSION__: JSON.stringify(version) },
  banner: "#!/usr/bin/env node",
});

if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}
