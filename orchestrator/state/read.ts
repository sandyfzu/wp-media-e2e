import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

import { readAtMost } from "../config/load";
import { errorCode } from "../runs/process-group";
import { StateError } from "./errors";

/**
 * Reading one of the orchestrator's small state files: never through a symbolic link, never a FIFO
 * or a folder, never more than a state file can hold — and a file that is not there told apart from
 * one that cannot be read, which a caller must never mistake for "not there".
 */

/**
 * How a state file is opened: read-only, not through a link (`ELOOP` instead), and non-blocking so a
 * FIFO in its place cannot hang the open.
 */
const READ_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * Reads a state file's text, checked and read through one handle, so it cannot be swapped between
 * the check and the read.
 *
 * @param path - the file, absolute.
 * @param what - what it is, for the messages: `"The orchestrator's lock"`.
 * @param maxBytes - the most a valid file holds; a larger one is refused.
 * @returns its text, or `undefined` when nothing is at `path`.
 * @throws {@link StateError} naming `path` when it is a symbolic link, not a regular file, larger than
 *   `maxBytes`, or cannot be read.
 */
export async function readStateFile(
  path: string,
  what: string,
  maxBytes: number,
): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, READ_FLAGS);
    if (!(await handle.stat()).isFile())
      throw new StateError(`${what} ${path} is not a regular file.`);
    const bytes = await readAtMost(handle, maxBytes + 1);
    if (bytes.length > maxBytes)
      throw new StateError(
        `${what} ${path} is larger than its ${String(maxBytes)} bytes.`,
      );
    return Buffer.from(bytes).toString("utf8");
  } catch (error) {
    if (error instanceof StateError) throw error;
    const code = errorCode(error);
    if (code === "ENOENT") return undefined;
    throw new StateError(
      code === "ELOOP"
        ? `${what} ${path} is a symbolic link: state files are never followed through one.`
        : `${what} ${path} cannot be read (${code ?? "unknown error"}).`,
    );
  } finally {
    await handle?.close();
  }
}
