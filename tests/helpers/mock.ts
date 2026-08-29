/**
 * Standing a module in for the one a source file imports.
 */
import { afterAll, mock } from "bun:test";

/**
 * Put `factory` in place of `specifier` for this file, and put `real` back when
 * the file is done.
 *
 * `bun test` runs every file of the suite in one process, so a stand-in left
 * standing is standing in for every file that runs after this one: the run that
 * found this out had `readFileSync` throwing `ENOENT` in four files that never
 * asked for it.
 *
 * `real` is a copy of the module's namespace taken before the stand-in goes up.
 * The registry hands out one namespace object per module and the stand-in
 * overwrites its properties, so the namespace itself is no longer what the
 * module was by the time the file ends.
 *
 * Both spellings are registered: `import "fs"` and `import "node:fs"` reach the
 * same module through two entries, and a stand-in under one leaves a source
 * importing the other running the real thing.
 */
export function mockModule(specifier: string, real: object, factory: () => unknown): void {
  const bare = specifier.replace(/^node:/, "");
  const spellings = [bare, `node:${bare}`];
  for (const spelling of spellings) mock.module(spelling, factory);
  afterAll(() => {
    for (const spelling of spellings) mock.module(spelling, () => real);
  });
}
