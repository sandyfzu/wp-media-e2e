import { lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { TASK_ID_PATTERN } from "../config/schema";
import { errorCode } from "../error-code";
import {
  checkOwnFolder,
  describeFolderProblem,
  PRIVATE_FOLDER,
} from "../folders";
import { RUNS_DIR } from "../runs/identity";
import { shellWord } from "../text";
import { writeJsonAtomic } from "./atomic";
import { StateError } from "./errors";
import { readStateFile } from "./read";
import { runNumberOf } from "./run-retention";

/**
 * A task's run counter, `tasks/<id>.json` in the state directory: the last run number handed out.
 * The next number is saved before it is returned, so a crash after that can skip a number but never
 * hand one out twice — two runs of one id would share a run folder and a report name. A counter that
 * cannot be trusted is refused, never reset: a reset hands out numbers already used.
 *
 * The task's run folders (`runs/<id>-<n>/`) are evidence too: the next number is past the highest of
 * them as well as past the counter, so a lost or restored counter never hands out a number a folder
 * still holds. A number whose folder was pruned leaves no trace there — only the counter knows it.
 *
 * Not safe for two callers on one task at once; the state directory's lock and one loop per task
 * keep it to one.
 */

/** The state directory's folder of task counters. */
export const TASKS_DIR = "tasks";

/** The counter file's schema version. */
export const COUNTER_VERSION = 1;

/** A byte-order mark (U+FEFF), which some editors put first in a file they save. */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** A counter's size: a few dozen bytes; anything near this is not a counter. */
const MAX_COUNTER_BYTES = 1024;

/**
 * A counter file. `lastRun` is a safe integer (`int()` refuses anything past
 * `Number.MAX_SAFE_INTEGER`): from 1 as written; 0, as an operator may set it, for "none yet".
 */
const counterSchema = z.strictObject({
  v: z.literal(COUNTER_VERSION),
  lastRun: z.number().int().min(0),
});

/** A counter file's content. */
export type Counter = z.output<typeof counterSchema>;

/** Where a counter is, for its messages. */
export interface CounterPlace {
  /** The counter file. */
  readonly path: string;
  readonly taskId: string;
  /** `<stateDir>/runs`. */
  readonly runsDir: string;
}

/**
 * A task's counter file.
 *
 * @param stateDir - the state directory.
 * @param taskId - the task's id: checked, since it becomes a file name.
 * @returns `<stateDir>/tasks/<taskId>.json`.
 * @throws {@link RangeError} for an id that is not a task's — which also keeps it one path segment.
 */
export function counterPath(stateDir: string, taskId: string): string {
  if (!TASK_ID_PATTERN.test(taskId))
    throw new RangeError("A counter's task id must be a task's id.");
  return join(stateDir, TASKS_DIR, `${taskId}.json`);
}

/**
 * The number after a counter's text and the task's run folders.
 *
 * @param text - the counter file's text, or `undefined` when there is none. A byte-order mark is
 *   dropped, as the config's loader drops one.
 * @param highestFolder - the highest number among the task's run folders; 0 for none.
 * @param place - the counter, for the messages.
 * @returns the next run number, from 1: past both the counter and the folders.
 * @throws {@link StateError} naming the file when the text is not JSON, not a counter, or there is no
 *   safe number after it.
 */
export function nextAfter(
  text: string | undefined,
  highestFolder: number,
  place: CounterPlace,
): number {
  const last = Math.max(
    text === undefined ? 0 : lastRunOf(text, place),
    highestFolder,
  );
  const next = last + 1;
  if (!Number.isSafeInteger(next))
    throw counterRefused(place, "has no run number left");
  return next;
}

/**
 * Hands out a task's next run number, saving it first.
 *
 * @param stateDir - the state directory.
 * @param taskId - the task's id.
 * @returns the number: past the counter and the task's run folders, from 1.
 * @throws {@link RangeError} for an id that is not a task's.
 * @throws {@link StateError} naming the file or folder when the counter cannot be trusted:
 *   unreadable, not a regular file, not a counter, out of numbers — or `tasks` is not a private
 *   folder of this user's, or `runs` is not a folder.
 * @throws what the file system throws saving it; no number is handed out then.
 *
 * @example
 * ```ts
 * const number = await nextRunNumber(stateDir, "bpng"); // 12
 * const id = runIdOf("bpng", number); // "bpng-12"
 * ```
 */
export async function nextRunNumber(
  stateDir: string,
  taskId: string,
): Promise<number> {
  const path = counterPath(stateDir, taskId);
  const place: CounterPlace = {
    path,
    taskId,
    runsDir: join(stateDir, RUNS_DIR),
  };
  await ensureTasksDir(join(stateDir, TASKS_DIR));
  const text = await readStateFile(path, MAX_COUNTER_BYTES, {
    what: "The run counter",
    remedy: repair(place),
  });
  const next = nextAfter(
    text,
    await highestRunFolder(place.runsDir, taskId),
    place,
  );
  const counter: Counter = { v: COUNTER_VERSION, lastRun: next };
  await writeJsonAtomic(path, counter);
  return next;
}

/**
 * The highest number among a task's run folders: every entry of `runs/` named exactly as one of its
 * run ids, whatever it is — a name taken is a number never to hand out again — and nothing followed.
 *
 * @param runsDir - `<stateDir>/runs`.
 * @param taskId - the task, a valid task id.
 * @returns the number, or 0 when there is none, or no `runs/`.
 * @throws {@link StateError} when `runs` is a link or not a folder.
 * @throws what listing it throws.
 */
export async function highestRunFolder(
  runsDir: string,
  taskId: string,
): Promise<number> {
  const stats = await lstat(runsDir).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (stats === undefined) return 0;
  if (!stats.isDirectory())
    throw new StateError(
      `The run folders' folder ${runsDir} is not a folder (a symbolic link is refused), so the run counter cannot see which numbers were used. Move it away: mv ${shellWord(runsDir)} ${shellWord(`${runsDir}.moved`)}`,
    );
  let highest = 0;
  for (const name of await readdir(runsDir))
    highest = Math.max(highest, runNumberOf(name, taskId) ?? 0);
  return highest;
}

/**
 * The last number a counter's text holds.
 *
 * @param text - the counter file's text.
 * @param place - the counter, for the messages.
 * @throws {@link StateError} when it is not JSON or not a counter.
 */
function lastRunOf(text: string, place: CounterPlace): number {
  let json: unknown;
  try {
    json = JSON.parse(text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text);
  } catch {
    throw counterRefused(place, "is not JSON");
  }
  const parsed = counterSchema.safeParse(json);
  if (!parsed.success)
    throw counterRefused(
      place,
      `is not a run counter (${parsed.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ")})`,
    );
  return parsed.data.lastRun;
}

/**
 * Makes the counters' folder, the owner's alone, unless it is there — and refuses one that is not a
 * real folder of this user's closed to others: a link would send the counters wherever it points,
 * and a folder others may write in lets them do the same.
 *
 * @param dir - `<stateDir>/tasks`.
 * @throws {@link StateError} when it is a symbolic link (a dangling one included), not a folder, or
 *   not this user's alone.
 */
async function ensureTasksDir(dir: string): Promise<void> {
  // Looked at first: `mkdir` fails `ENOENT` through a dangling link, which says nothing useful.
  const there = await lstat(dir).then(
    () => true,
    (error: unknown) => {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    },
  );
  if (!there)
    await mkdir(dir, { mode: 0o700 }).catch((error: unknown) => {
      // Made meanwhile: judged below.
      if (errorCode(error) !== "EEXIST") throw error;
    });
  const check = await checkOwnFolder(dir, PRIVATE_FOLDER);
  if (check.kind === "notFolder")
    throw new StateError(
      `The run counters' folder ${dir} is not a folder (a symbolic link is refused). Remove it: rm ${shellWord(dir)}`,
    );
  if (check.kind !== "ok")
    throw new StateError(
      `The run counters' folder ${dir} ${describeFolderProblem(check)}: it must be this user's alone (chmod 700 ${shellWord(dir)}).`,
    );
}

/**
 * What to do about a counter that cannot be trusted.
 *
 * @param place - the counter.
 */
function repair(place: CounterPlace): string {
  const folders = join(place.runsDir, `${place.taskId}-<n>`);
  return `It is never reset on its own, since a reset reuses run numbers. Remove it to count on from the highest of ${folders}/ (a pruned run's number is not seen there): rm ${shellWord(place.path)} — or set it to {"v":1,"lastRun":<n>}, n the highest number task ${place.taskId} has used (0 for none).`;
}

/**
 * The refusal of a counter that cannot be trusted.
 *
 * @param place - the counter.
 * @param why - what is wrong with it.
 */
function counterRefused(place: CounterPlace, why: string): StateError {
  return new StateError(
    `The run counter ${place.path} ${why}. ${repair(place)}`,
  );
}
