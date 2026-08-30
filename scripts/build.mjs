#!/usr/bin/env bun
// Builds what the package ships: one bundled ESM entry point that bun runs, and
// the declarations beside it.
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
  // `node` rather than `bun`: the target picks which builtins the bundle may
  // lean on, and node's are the ones bun also implements. Nothing bun-only is
  // inlined, so the same file starts under either runtime.
  target: "node",
  format: "esm",
  sourcemap: "linked",
  // `src/mcp/index.ts` and `src/app-server/client/index.ts` read this to tell the MCP
  // client and the app-server which version is speaking to them.
  define: { __PKG_VERSION__: JSON.stringify(version) },
  banner: "#!/usr/bin/env bun",
});

if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}
