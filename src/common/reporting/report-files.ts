import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Writing into a run's report folder while readers may be looking: a file replaced whole and at once,
 * and a few bytes spliced into the end of a large file without reading or rewriting the rest.
 */

/**
 * Writes a file whole, at once: the text goes into a hidden temporary file beside it, which then
 * replaces the file by rename — atomic on one filesystem — so a reader polling it never sees half a
 * file, and a write that fails leaves the previous version. The folder is created if missing.
 *
 * @param path - the file.
 * @param text - its whole content.
 * @throws the filesystem's error; the temporary file is removed first.
 */
export function writeFileAtomic(path: string, text: string): void {
  const folder = dirname(path);
  mkdirSync(folder, { recursive: true });
  const temporary = join(
    folder,
    `.${basename(path)}.${String(process.pid)}.tmp`,
  );
  try {
    writeFileSync(temporary, text);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** How much of a file's end {@link spliceIntoTail} reads: far more than an HTML file's closing tags. */
export const TAIL_BYTES = 64 * 1024;

/**
 * Rewrites a file's end in place: reads its last {@link TAIL_BYTES}, lets `splice` say from which byte
 * of them the file continues differently, and writes that from there — a report of many megabytes
 * is neither read whole nor copied. The file only grows; a splice that would shorten it is refused.
 *
 * @param path - the file, which must exist.
 * @param splice - given the tail, the new bytes and the tail offset they start at; `undefined` to
 *   leave the file as it is.
 * @returns whether the file was changed.
 * @throws the filesystem's error, or a {@link RangeError} for a splice that would shorten the file.
 */
export function spliceIntoTail(
  path: string,
  splice: (
    tail: Buffer,
  ) => { readonly offset: number; readonly bytes: Buffer } | undefined,
): boolean {
  const fd = openSync(path, "r+");
  try {
    // A FIFO or a device reports no size: nothing is read from it, so nothing can block.
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const tail = buffer.subarray(
      0,
      readSync(fd, buffer, 0, buffer.length, start),
    );
    const change = splice(tail);
    if (change === undefined) return false;
    if (
      change.offset < 0 ||
      change.offset + change.bytes.length < tail.length
    ) {
      throw new RangeError("a splice may only grow the file");
    }
    writeSync(fd, change.bytes, 0, change.bytes.length, start + change.offset);
    return true;
  } finally {
    closeSync(fd);
  }
}
