import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { errorCode } from "../error-code";
import type { CappedMiss } from "../files";
import { RUN_FILES, RUNS_DIR } from "../runs/identity";
import {
  MAX_RECORD_BYTES,
  readRunRecordFile,
  type RunningRecordRead,
} from "../runs/record";
import { safeLine } from "../text";
import { checkRunsFolder } from "./runs-folder";

/**
 * The run folders under `<state>/runs/` whose record still says `running`: what the orphan check judges
 * at a start, and what a start that gives up waiting for its runs names. Nothing is ever read through a
 * link — neither the runs' folder, nor a run's folder (an entry's type is its own), nor its record — and
 * a record is only ever its own folder's (`readRunRecordFile`).
 */

/** A record still saying `running`, and where it is. */
export interface RunningFolder {
  readonly record: RunningRecordRead;
  /** Its `run.json`, absolute. */
  readonly path: string;
}

/** A run folder that could not be read as one: its name, and a line safe to log. */
export interface RunFolderWarning {
  /** The folder's name, as listed. */
  readonly name: string;
  readonly text: string;
}

/** Every running record under the runs' folder, and what could not be read. */
export interface RunningFolders {
  /** In run-folder order. */
  readonly running: readonly RunningFolder[];
  readonly warnings: readonly RunFolderWarning[];
}

/**
 * Reads every run folder's record that still says `running`. A record that cannot be read, or is not
 * one, is a warning; a folder being removed (hidden), with no record yet, or over, is passed over.
 *
 * @param stateDir - the state directory.
 * @returns the running records and the warnings.
 * @throws a `StateError` coded `ELOOP` when the runs' folder is a link, `ENOTDIR` when it is no
 *   folder, uncoded when it is another user's or open to other writers (`checkRunsFolder`), or
 *   what `lstat` and `readdir` throw besides `ENOENT` — a missing one holds no run.
 */
export async function readRunningFolders(
  stateDir: string,
): Promise<RunningFolders> {
  const runsDir = join(stateDir, RUNS_DIR);
  const running: RunningFolder[] = [];
  const warnings: RunFolderWarning[] = [];
  for (const entry of await listRuns(runsDir)) {
    const read = await readRunning(runsDir, entry);
    if (read.kind === "running") running.push(read.folder);
    else if (read.kind === "warning")
      warnings.push({ name: entry.name, text: read.text });
  }
  return { running, warnings };
}

/** One run folder's record, read: a running one, nothing to do, or a warning. */
type RunningRead =
  | { readonly kind: "running"; readonly folder: RunningFolder }
  | { readonly kind: "skip" }
  | { readonly kind: "warning"; readonly text: string };

/**
 * Reads one run folder's record, when it still says `running`.
 *
 * @param runsDir - `<state>/runs`.
 * @param entry - the folder's entry.
 * @returns the record, nothing, or a warning.
 */
async function readRunning(
  runsDir: string,
  entry: Dirent,
): Promise<RunningRead> {
  // Hidden: a folder the retention is removing.
  if (entry.name.startsWith(".")) return { kind: "skip" };
  const name = safeLine(entry.name, 80);
  // A link to a folder is not followed: an entry's type is the entry's own.
  if (!entry.isDirectory())
    return {
      kind: "warning",
      text: `${name} in the runs' folder is not a folder: passed over`,
    };
  const path = join(runsDir, entry.name, RUN_FILES.record);
  const read = await readRunRecordFile(path, entry.name);
  switch (read.kind) {
    case "missing":
    case "over":
      return { kind: "skip" };
    case "running":
      return { kind: "running", folder: { record: read.record, path } };
    case "malformed":
      return {
        kind: "warning",
        text: `run ${name}'s record is not one this orchestrator reads (${read.why}): passed over`,
      };
    default:
      return {
        kind: "warning",
        text: `run ${name}'s record ${describeUnread(read)}: passed over`,
      };
  }
}

/**
 * The runs' folder's entries, sorted by name; none when it does not exist yet. The folder itself is
 * never followed: through a link, a reader would act on records outside the state directory.
 *
 * @param runsDir - `<state>/runs`.
 * @returns the entries.
 * @throws as {@link readRunningFolders}.
 */
async function listRuns(runsDir: string): Promise<Dirent[]> {
  try {
    if (!(await checkRunsFolder(runsDir))) return [];
    const entries = await readdir(runsDir, { withFileTypes: true });
    return entries.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

/**
 * Why a record could not be read, in words.
 *
 * @param read - the failed read.
 * @returns the reason.
 */
function describeUnread(
  read: Exclude<CappedMiss, { kind: "missing" }>,
): string {
  if (read.kind === "tooLarge")
    return `is over ${String(MAX_RECORD_BYTES)} bytes`;
  return read.code === "ELOOP"
    ? "is a symbolic link"
    : `could not be read (${read.code})`;
}
