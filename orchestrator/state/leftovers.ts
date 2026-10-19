import { lstat, readdir, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";

import { TASK_ID_PATTERN } from "../config/schema";
import { errorCode } from "../error-code";
import { TASKS_DIR } from "./counter";
import { LOCK_FILE } from "./lock-owner";

/**
 * What a crash leaves in the state directory: a temporary file the lock or a counter was being
 * written through, or a claim on a lock a start died taking over. Each is removed by whoever next
 * takes the lock — only names this code writes, only regular files (a link is never followed nor
 * removed), only once older than {@link LEFTOVER_AGE_MS}: a write or a take-over lasts milliseconds,
 * so nothing that old is still in use.
 */

/** How old a leftover must be before it is removed, in milliseconds. */
export const LEFTOVER_AGE_MS = 60_000;

/** A temporary name's random part: 6 bytes, in hex. */
const TEMP = "[0-9a-f]{12}\\.tmp";

/**
 * A lock's leftovers, by its file's name: its temporary file, a claim, and a claim's temporary file.
 *
 * @param lockFile - the lock's name: `orchestrator.lock`.
 * @returns the pattern of their names.
 */
export function lockLeftoverPattern(lockFile: string): RegExp {
  const lock = lockFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const claim = `\\.${lock}\\.[0-9a-f]{32}\\.claim`;
  return new RegExp(
    `^(?:\\.${lock}\\.${TEMP}|${claim}|\\.${claim}\\.${TEMP})$`,
  );
}

/** The state directory's leftovers: its lock's. */
const STATE_LEFTOVER = lockLeftoverPattern(LOCK_FILE);

/** A counter's temporary file in `tasks/`: `.<task>.json.<hex>.tmp`, as `writeJsonAtomic` names it. */
const COUNTER_TEMP = new RegExp(`^\\.(.+)\\.json\\.${TEMP}$`);

/** What a sweep did. */
export interface LeftoverSweep {
  readonly removed: readonly string[];
  /** Leftovers that could not be removed, and the system error's code. */
  readonly failed: readonly { readonly path: string; readonly code: string }[];
}

/**
 * Whether a name in the state directory is one of the lock's leftovers.
 *
 * @param name - an entry's name.
 * @returns `true` for the lock's temporary file, a claim, or a claim's temporary file.
 */
export function isStateLeftover(name: string): boolean {
  return STATE_LEFTOVER.test(name);
}

/**
 * Whether a name in `tasks/` is a counter's leftover temporary file.
 *
 * @param name - an entry's name.
 * @returns `true` for a temporary file named after a valid task id.
 */
export function isCounterLeftover(name: string): boolean {
  const task = COUNTER_TEMP.exec(name)?.[1];
  return task !== undefined && TASK_ID_PATTERN.test(task);
}

/**
 * Removes the state directory's leftovers. Call it holding the lock. Never rejects: a sweep that
 * fails leaves the files for the next one, and says so. The state directory is the operator's choice
 * and may be a link to a folder: a link is resolved first, so its leftovers are found where it leads —
 * `tasks/` inside it is never followed.
 *
 * @param stateDir - the state directory.
 * @param now - the time, in milliseconds since the epoch.
 * @returns what was removed, and what could not be.
 */
export async function sweepLeftovers(
  stateDir: string,
  now: number,
): Promise<LeftoverSweep> {
  let real: string;
  try {
    // Only a link is resolved: the paths said stay as the operator wrote them otherwise.
    real = (await lstat(stateDir)).isSymbolicLink()
      ? await realpath(stateDir)
      : stateDir;
  } catch (error) {
    const code = errorCode(error) ?? "unknown error";
    // Not there: nothing to sweep, as for any folder.
    return {
      removed: [],
      failed: code === "ENOENT" ? [] : [{ path: stateDir, code }],
    };
  }
  const state = await sweepFolder(real, isStateLeftover, now);
  const tasks = await sweepFolder(
    join(real, TASKS_DIR),
    isCounterLeftover,
    now,
  );
  return {
    removed: [...state.removed, ...tasks.removed],
    failed: [...state.failed, ...tasks.failed],
  };
}

/**
 * Removes one folder's leftovers: the names `isLeftover` accepts, each only when a regular file
 * older than {@link LEFTOVER_AGE_MS}. A folder that is a link, or not there, holds none. Never rejects.
 *
 * @param dir - the folder.
 * @param isLeftover - whether a name is a leftover.
 * @param now - the time, in milliseconds since the epoch.
 * @returns what was removed, and what could not be.
 */
export async function sweepFolder(
  dir: string,
  isLeftover: (name: string) => boolean,
  now: number,
): Promise<LeftoverSweep> {
  const removed: string[] = [];
  const failed: { path: string; code: string }[] = [];
  let names: string[];
  try {
    // A link is never listed through.
    if (!(await lstat(dir)).isDirectory()) return { removed, failed };
    names = await readdir(dir);
  } catch (error) {
    const code = errorCode(error) ?? "unknown error";
    if (code !== "ENOENT") failed.push({ path: dir, code });
    return { removed, failed };
  }
  for (const name of names.filter(isLeftover).sort()) {
    const path = join(dir, name);
    const outcome = await removeIfOld(path, now);
    if (outcome === "removed") removed.push(path);
    else if (outcome !== "kept") failed.push({ path, code: outcome.code });
  }
  return { removed, failed };
}

/**
 * Removes a leftover when it is a regular file older than {@link LEFTOVER_AGE_MS}.
 *
 * @param path - the leftover.
 * @param now - the time.
 * @returns `removed`; `kept` when it is young, not a regular file, or already gone; or the error.
 */
async function removeIfOld(
  path: string,
  now: number,
): Promise<"removed" | "kept" | { code: string }> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || now - stats.mtimeMs < LEFTOVER_AGE_MS) return "kept";
    // `unlink` removes a name, never what a link points to.
    await unlink(path);
    return "removed";
  } catch (error) {
    const code = errorCode(error) ?? "unknown error";
    return code === "ENOENT" ? "kept" : { code };
  }
}
