import { NOT_A_FILE, readCapped } from "../files";
import { StateError } from "./errors";

/**
 * Reading one of the orchestrator's small state files: never through a symbolic link, never a FIFO
 * or a folder, never more than a state file can hold — and a file that is not there told apart from
 * one that cannot be read, which a caller must never mistake for "not there".
 */

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
  const read = await readCapped(path, maxBytes, { followLink: false });
  switch (read.kind) {
    case "text":
      return read.text;
    case "missing":
      return undefined;
    case "tooLarge":
      throw new StateError(
        `${what} ${path} is larger than its ${String(maxBytes)} bytes.`,
      );
    case "unreadable":
      throw new StateError(
        read.code === NOT_A_FILE
          ? `${what} ${path} is not a regular file.`
          : read.code === "ELOOP"
            ? `${what} ${path} is a symbolic link: state files are never followed through one.`
            : `${what} ${path} cannot be read (${read.code}).`,
      );
  }
}
