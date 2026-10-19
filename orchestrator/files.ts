import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

import { errorCode } from "./error-code";

/**
 * Reading a file the orchestrator did not write itself — its config, a state file, a run's report —
 * safely: opened without waiting (a FIFO in its place cannot hang the open), refused unless it is a
 * regular file, never read past a cap however large it is or grows, and checked and read through one
 * handle, so it cannot be swapped between the check and the read. Never throws: the result says why
 * nothing was read, and each caller words that its own way.
 */

/** Opens for reading without waiting; a regular file reads the same either way. */
const READ_NONBLOCKING = constants.O_RDONLY | constants.O_NONBLOCK;

/** The most bytes asked of one `read`: a small file costs a small buffer, whatever its cap. */
const CHUNK_BYTES = 64 * 1024;

/** The code an `unreadable` read carries when the path is there and is no regular file. */
export const NOT_A_FILE = "not a file";

/** Why a file was not read. */
export type CappedMiss =
  | { readonly kind: "missing" }
  /** Over the cap: its size as last seen, always above the cap. */
  | { readonly kind: "tooLarge"; readonly bytes: number }
  /** It is there, and could not be read: the system error's code, or {@link NOT_A_FILE}. */
  | { readonly kind: "unreadable"; readonly code: string };

/** A file read within a cap, as text. */
export type CappedRead =
  { readonly kind: "text"; readonly text: string } | CappedMiss;

/** A file read within a cap, as bytes, with its `stat` mode (type and permission bits). */
export type CappedBytes =
  | {
      readonly kind: "bytes";
      readonly bytes: Uint8Array;
      readonly mode: number;
    }
  | CappedMiss;

/** How a capped read opens its file. */
export interface ReadCappedOptions {
  /**
   * `false`: a link in the file's place is refused (`unreadable`, `ELOOP`) rather than read — for a
   * file only its place vouches for. Followed by default.
   */
  readonly followLink?: boolean;
}

/**
 * Reads a whole file's bytes, unless it holds more than `maxBytes`. The cap is judged by what is
 * read — up to `maxBytes + 1` bytes — never by a size `stat` gave earlier, so a file growing while it
 * is read is still refused.
 *
 * @param path - the file.
 * @param maxBytes - the cap, a whole number from 0.
 * @param options - whether a link in its place is followed.
 * @returns its bytes and mode, or why there are none.
 * @throws {@link RangeError} when `maxBytes` is not a whole number from 0.
 */
export async function readCappedBytes(
  path: string,
  maxBytes: number,
  options: ReadCappedOptions = {},
): Promise<CappedBytes> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new RangeError(
      `A read's cap is a whole number of bytes from 0, got ${String(maxBytes)}.`,
    );
  const flags =
    options.followLink === false
      ? READ_NONBLOCKING | constants.O_NOFOLLOW
      : READ_NONBLOCKING;
  let handle: FileHandle;
  try {
    handle = await open(path, flags);
  } catch (error) {
    const code = errorCode(error);
    return code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unreadable", code: code ?? "unknown error" };
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { kind: "unreadable", code: NOT_A_FILE };
    const bytes = await readAtMost(handle, maxBytes + 1);
    if (bytes.length > maxBytes)
      return {
        kind: "tooLarge",
        bytes: await sizeAtLeast(handle, bytes.length),
      };
    return { kind: "bytes", bytes, mode: stats.mode };
  } catch (error) {
    return { kind: "unreadable", code: errorCode(error) ?? "unknown error" };
  } finally {
    // Read-only: a failed close loses nothing, so it never replaces the result.
    await handle.close().catch(() => undefined);
  }
}

/**
 * Reads a whole file as UTF-8 text (an invalid sequence becomes U+FFFD), unless it holds more than
 * `maxBytes`; see {@link readCappedBytes}.
 *
 * @param path - the file.
 * @param maxBytes - the cap, a whole number from 0.
 * @param options - whether a link in its place is followed.
 * @returns its text, or why there is none.
 * @throws {@link RangeError} when `maxBytes` is not a whole number from 0.
 *
 * @example
 * ```ts
 * const read = await readCapped(recordPath, 64 * 1024, { followLink: false });
 * if (read.kind === "text") parse(read.text);
 * ```
 */
export async function readCapped(
  path: string,
  maxBytes: number,
  options: ReadCappedOptions = {},
): Promise<CappedRead> {
  const read = await readCappedBytes(path, maxBytes, options);
  return read.kind === "bytes"
    ? { kind: "text", text: Buffer.from(read.bytes).toString("utf8") }
    : read;
}

/**
 * Reads from the start of `handle` until its end or `limit` bytes, whichever comes first — never
 * more, however large the file is or grows.
 *
 * @param handle - an open file.
 * @param limit - the most bytes to read.
 * @returns what was read.
 */
export async function readAtMost(
  handle: FileHandle,
  limit: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (length < limit) {
    const chunk = new Uint8Array(Math.min(CHUNK_BYTES, limit - length));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, length);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    length += bytesRead;
  }
  return chunks.length === 1 && chunks[0] !== undefined
    ? chunks[0]
    : Buffer.concat(chunks);
}

/**
 * An oversized file's size, for the message: as `stat` says now, but never below what was read — a
 * file cut short after the read must not look within its cap.
 *
 * @param handle - the open file.
 * @param read - how many bytes were read.
 * @returns the larger of the two; `read` when `stat` fails.
 */
async function sizeAtLeast(handle: FileHandle, read: number): Promise<number> {
  const size = await handle.stat().then(
    (stats) => stats.size,
    () => 0,
  );
  return Math.max(size, read);
}
