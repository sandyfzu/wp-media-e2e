import { z } from "zod";

import type { RunFinishedEvent } from "../events/run-finished";
import { writeJsonAtomic } from "../state/atomic";
import type { RunIdentity } from "./identity";
import type { LaunchResult } from "./launch";

/**
 * A run's record, `run.json` in its folder: written as it starts (`running`, with the process group
 * once one exists) and again as it ends (`ended`, with how its processes ended and its
 * `run.finished`). A record still `running` with a live group is a run the orchestrator lost — killed
 * or crashed under it — and still holding its cell's sites.
 */

/** The record's schema version. */
export const RUN_RECORD_VERSION = 1;

/** What every record says. */
interface RecordBase {
  readonly v: typeof RUN_RECORD_VERSION;
  /** `bpng-12`. */
  readonly id: string;
  readonly runId: string;
  readonly taskId: string;
  /** ISO 8601. */
  readonly startedAt: string;
}

/** A run under way. */
export interface RunningRecord extends RecordBase {
  readonly state: "running";
  /** The process running now and its group; absent before the first one started. */
  readonly process?: {
    readonly name: "bddgen" | "playwright";
    readonly pgid: number;
  };
}

/** A run that has ended. */
export interface EndedRecord extends RecordBase, LaunchResult {
  readonly state: "ended";
  readonly endedAt: string;
  readonly event: RunFinishedEvent;
}

/** A run's record. */
export type RunRecord = RunningRecord | EndedRecord;

/**
 * The record of a run starting, or of its process starting.
 *
 * @param identity - the run.
 * @param taskId - its task.
 * @param process - the process running now, once one is.
 */
export function runningRecord(
  identity: Pick<RunIdentity, "id" | "runId" | "startedAt">,
  taskId: string,
  process?: RunningRecord["process"],
): RunningRecord {
  return {
    v: RUN_RECORD_VERSION,
    state: "running",
    ...base(identity, taskId),
    ...(process === undefined ? {} : { process }),
  };
}

/**
 * The record of a run that has ended.
 *
 * @param identity - the run.
 * @param taskId - its task.
 * @param launch - how its processes ended.
 * @param event - its `run.finished`.
 */
export function endedRecord(
  identity: Pick<RunIdentity, "id" | "runId" | "startedAt">,
  taskId: string,
  launch: LaunchResult,
  event: RunFinishedEvent,
): EndedRecord {
  return {
    v: RUN_RECORD_VERSION,
    state: "ended",
    ...base(identity, taskId),
    endedAt: event.endedAt,
    ...launch,
    event,
  };
}

/**
 * The fields every record shares.
 *
 * @param identity - the run.
 * @param taskId - its task.
 */
function base(
  identity: Pick<RunIdentity, "id" | "runId" | "startedAt">,
  taskId: string,
): Omit<RecordBase, "v"> {
  return {
    id: identity.id,
    runId: identity.runId,
    taskId,
    startedAt: identity.startedAt.toISOString(),
  };
}

/**
 * Writes a record, atomically.
 *
 * @param path - the run's `run.json`.
 * @param record - the record.
 */
export function writeRunRecord(path: string, record: RunRecord): Promise<void> {
  return writeJsonAtomic(path, record);
}

/** What is read back of a record still running: enough to find its group. */
const runningSchema = z.object({
  v: z.literal(RUN_RECORD_VERSION),
  state: z.literal("running"),
  id: z.string(),
  process: z
    .object({
      name: z.enum(["bddgen", "playwright"]),
      pgid: z.number().int().min(2),
    })
    .optional(),
});

/** A record that says its run is still running, as read back. */
export type RunningRecordRead = z.output<typeof runningSchema>;

/**
 * Reads a record's text back, when it says its run is still running.
 *
 * @param text - `run.json`'s text.
 * @returns the run's id and its process group, or `undefined` for an ended run or a text that is not
 *   a record.
 */
export function readRunningRecord(text: string): RunningRecordRead | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = runningSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}
