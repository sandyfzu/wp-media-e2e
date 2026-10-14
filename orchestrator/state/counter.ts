import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { TASK_ID_PATTERN } from "../config/schema";
import { errorCode } from "../runs/process-group";
import { writeJsonAtomic } from "./atomic";
import { StateError } from "./errors";
import { readStateFile } from "./read";

/**
 * A task's run counter, `tasks/<id>.json` in the state directory: the last run number handed out.
 * The next number is saved before it is returned, so a crash after that can skip a number but never
 * hand one out twice — two runs of one id would share a run folder and a report name. A counter that
 * cannot be trusted is refused, never reset: a reset hands out numbers already used.
 *
 * Not safe for two callers on one task at once; the state directory's lock and one loop per task
 * keep it to one.
 */

/** The state directory's folder of task counters. */
export const TASKS_DIR = "tasks";

/** The counter file's schema version. */
export const COUNTER_VERSION = 1;

/** A counter's size: a few dozen bytes; anything near this is not a counter. */
const MAX_COUNTER_BYTES = 1024;

/**
 * A counter file, as written. `lastRun` is a safe integer from 1 (`int()` refuses anything past
 * `Number.MAX_SAFE_INTEGER`), the range a run's number has.
 */
const counterSchema = z.strictObject({
  v: z.literal(COUNTER_VERSION),
  lastRun: z.number().int().min(1),
});

/** A counter file's content. */
export type Counter = z.output<typeof counterSchema>;

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
 * The number after a counter's text.
 *
 * @param text - the counter file's text, or `undefined` when there is none: the task's first run.
 * @param path - the file, for the messages.
 * @returns the next run number, from 1.
 * @throws {@link StateError} naming `path` when the text is not JSON, not a counter, or has no safe
 *   number after it.
 */
export function nextAfter(text: string | undefined, path: string): number {
  if (text === undefined) return 1;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw counterRefused(path, "is not JSON");
  }
  const parsed = counterSchema.safeParse(json);
  if (!parsed.success)
    throw counterRefused(
      path,
      `is not a run counter (${parsed.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ")})`,
    );
  const next = parsed.data.lastRun + 1;
  if (!Number.isSafeInteger(next))
    throw counterRefused(path, "has no run number left");
  return next;
}

/**
 * Hands out a task's next run number, saving it first.
 *
 * @param stateDir - the state directory.
 * @param taskId - the task's id.
 * @returns the number, from 1 for a task with no counter yet.
 * @throws {@link RangeError} for an id that is not a task's.
 * @throws {@link StateError} naming the file or folder when the counter cannot be trusted:
 *   unreadable, not a regular file, not a counter, out of numbers — or `tasks` is not a folder.
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
  await ensureTasksDir(join(stateDir, TASKS_DIR));
  const next = nextAfter(
    await readStateFile(path, "The run counter", MAX_COUNTER_BYTES),
    path,
  );
  const counter: Counter = { v: COUNTER_VERSION, lastRun: next };
  await writeJsonAtomic(path, counter);
  return next;
}

/**
 * Makes the counters' folder, the owner's alone, unless it is there — and refuses one that is not a
 * real folder: a link would send the counters wherever it points.
 *
 * @param dir - `<stateDir>/tasks`.
 * @throws {@link StateError} when it is a symbolic link or not a folder.
 */
async function ensureTasksDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 }).catch((error: unknown) => {
    // Something already there: judged below.
    if (errorCode(error) !== "EEXIST") throw error;
  });
  if (!(await lstat(dir)).isDirectory())
    throw new StateError(
      `The run counters' folder ${dir} is not a folder (a symbolic link is refused).`,
    );
}

/**
 * The refusal of a counter that cannot be trusted.
 *
 * @param path - the counter file.
 * @param why - what is wrong with it.
 */
function counterRefused(path: string, why: string): StateError {
  return new StateError(
    `The run counter ${path} ${why}. It is never reset on its own, since a reset reuses run numbers: set it to {"v":1,"lastRun":<n>}, n the highest number among the task's run folders (runs/<task>-<n>/).`,
  );
}
