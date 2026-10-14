import { NOT_A_FILE, readCapped } from "../files";
import { StateError } from "./errors";

/**
 * Reading one of the orchestrator's small state files: never through a symbolic link, never a FIFO
 * or a folder, never more than a state file can hold — and a file that is not there told apart from
 * one that cannot be read, which a caller must never mistake for "not there".
 */

/** How a state file is named and remedied in a refusal. */
export interface StateFileText {
  /** What it is: `"The orchestrator's lock"`. */
  readonly what: string;
  /** What the operator does about a refused one, one sentence: `"If no orchestrator runs …, remove it: rm …"`. */
  readonly remedy: string;
}

/**
 * Reads a state file's text, checked and read through one handle, so it cannot be swapped between
 * the check and the read.
 *
 * @param path - the file, absolute.
 * @param maxBytes - the most a valid file holds; a larger one is refused.
 * @param text - what the file is and its remedy, for the refusals.
 * @returns its text, or `undefined` when nothing is at `path`.
 * @throws {@link StateError} naming `path`, what is wrong and the remedy when it is a symbolic link,
 *   not a regular file, larger than `maxBytes`, or cannot be read.
 */
export async function readStateFile(
  path: string,
  maxBytes: number,
  text: StateFileText,
): Promise<string | undefined> {
  const read = await readCapped(path, maxBytes, { followLink: false });
  switch (read.kind) {
    case "text":
      return read.text;
    case "missing":
      return undefined;
    case "tooLarge":
      throw refused(
        text,
        `${path} is larger than its ${String(maxBytes)} bytes.`,
      );
    case "unreadable":
      throw refused(
        text,
        read.code === NOT_A_FILE
          ? `${path} is not a regular file.`
          : read.code === "ELOOP"
            ? `${path} is a symbolic link: state files are never followed through one.`
            : `${path} cannot be read (${read.code}).`,
      );
  }
}

/**
 * A refusal: what the file is, what is wrong, then the remedy.
 *
 * @param text - what the file is and its remedy.
 * @param problem - the path and what is wrong, one sentence.
 */
function refused(text: StateFileText, problem: string): StateError {
  return new StateError(`${text.what} ${problem} ${text.remedy}`);
}
