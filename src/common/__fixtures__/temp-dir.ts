import { existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";

/**
 * For specs: removing a temporary folder a spec made, and nothing else. A hook's folder variable is
 * still `""` when its `beforeEach` was interrupted before `mkdtemp` (Ctrl-C, `--max-failures`, a
 * timeout), yet the `afterEach` runs: `join("", "..")` is the working directory's parent — the
 * checkout's — and `join("", "x")` a folder in the checkout. So a folder is removed only when it is
 * absolute and lies inside the system's temporary folder, both judged by their real paths.
 */

/**
 * Whether `path` may be removed as a spec's temporary folder: absolute, and inside the temporary
 * folder (never the temporary folder itself), by real paths. A path that does not exist is judged by
 * its text against the temporary folder's both spellings.
 *
 * @param path - the folder.
 * @returns `true` when it is a spec's temporary folder.
 */
export function isTempDir(path: string): boolean {
  if (path === "" || !isAbsolute(path)) return false;
  const roots = [tmpdir(), realpathSync(tmpdir())];
  const real = existsSync(path) ? realpathSync(path) : path;
  return roots.some((root) => {
    const inside = relative(root, real);
    return (
      inside !== "" &&
      inside !== ".." &&
      !inside.startsWith(`..${sep}`) &&
      !isAbsolute(inside)
    );
  });
}

/**
 * Removes a spec's temporary folder, recursively: nothing when `path` is `""` (never set), the folder
 * when {@link isTempDir} says it is one.
 *
 * @param path - the folder; `""` when the hook that makes it never got that far.
 * @throws {@link Error} when `path` is set but is no temporary folder: a spec's bug, never removed.
 */
export function removeTempDir(path: string): void {
  if (path === "") return;
  if (!isTempDir(path))
    throw new Error(
      `refusing to remove ${JSON.stringify(path)}: not a folder inside the temporary folder ${tmpdir()}`,
    );
  rmSync(path, { recursive: true, force: true });
}
