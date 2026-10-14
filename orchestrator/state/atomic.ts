import { randomBytes } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Writing a state file so a reader — or the orchestrator after a crash or a power loss — sees the old
 * content or the new, never half of either: the text goes to a new temporary file beside it, flushed
 * to disk, which then replaces it by `rename`, atomic within one file system; the folder is flushed
 * last, so the rename itself survives a power loss.
 */

/**
 * Writes `value` as JSON to `path`, atomically and durably, readable by the owner only. Once it
 * resolves, the new content is on disk: a power loss after it cannot bring the old content back.
 *
 * @param path - the file.
 * @param value - what to write: a value `JSON.stringify` can write.
 * @throws what the write, a flush or the rename throws; the temporary file is removed first. A
 *   failed flush of the folder throws although the file was replaced: the new content is then
 *   visible but not certain to outlive a power loss.
 */
export async function writeJsonAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const folder = dirname(path);
  const temporary = join(
    folder,
    `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await writeDurably(temporary, text);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await syncFolder(folder);
}

/**
 * Creates `path` with `text`, owner-only, and flushes it to disk before closing it.
 *
 * @param path - a new file: `wx`, so a name already taken is never written through, whatever it is.
 * @param text - its content.
 * @throws what the open, the write, the flush or the close throws.
 */
async function writeDurably(path: string, text: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(text);
    // The data and the size it needs; the rename then publishes nothing a power loss can empty.
    await handle.datasync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  // A write error some file systems report only now must fail the write.
  await handle.close();
}

/**
 * Flushes a folder's entries to disk — a rename in it is not durable before — by opening it read-only
 * and `fsync`ing it, which Linux and macOS both accept for a folder (measured).
 *
 * @param folder - the folder.
 * @throws what the open or the flush throws; a failed close of the read-only handle loses nothing.
 */
async function syncFolder(folder: string): Promise<void> {
  const handle = await open(folder, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}
