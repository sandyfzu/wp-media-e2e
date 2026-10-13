import { randomBytes } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Writing a state file so a reader — or the orchestrator after a crash — sees the old content or the
 * new, never half of either: the text goes to a new temporary file beside it, which then replaces it
 * by `rename`, atomic within one file system.
 */

/**
 * Writes `value` as JSON to `path`, atomically, readable by the owner only.
 *
 * @param path - the file.
 * @param value - what to write: a value `JSON.stringify` can write.
 * @throws what the write or the rename throws; the temporary file is removed first.
 */
export async function writeJsonAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    // `wx`: a name already taken is never written through, whatever it is.
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
