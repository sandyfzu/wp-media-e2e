import { z } from "zod";

import type { RunFinishedEvent } from "../events/run-finished";
import { writeJsonAtomic } from "../state/atomic";
import type { RunIdentity } from "./identity";
import type { LaunchResult } from "./launch";
import type { LeaderStartReader } from "./leader";

/**
 * A run's record, `run.json` in its folder: written as it starts (`running`, with the process group
 * once one exists) and again as it ends (`ended`, with how its processes ended and its
 * `run.finished`). A record still `running` whose live group is led by the process it names is a run
 * the orchestrator lost — killed or crashed under it — and still holding its cell's sites. Each run's
 * writes go through one {@link RecordWriter}, in order, so a late `running` never replaces the end.
 *
 * The version stays 1 through additive fields: `process.leaderStart` is optional, and a record without
 * it — written before it existed, or whose leader's start could not be read — can never be matched to
 * a live leader, which is exactly what it proves.
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
  readonly process?: RunningProcess;
}

/** The process a running record names. */
export interface RunningProcess {
  readonly name: "bddgen" | "playwright";
  /** Its group's id: its own PID, as it leads its group. */
  readonly pgid: number;
  /**
   * When it started, as `readLeaderStart` read it at spawn; absent when that read failed. What tells
   * it from a later process given the same number.
   */
  readonly leaderStart?: string;
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
      leaderStart: z.string().min(1).max(200).optional(),
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

/** How a record's leader compares with the process that has its PID now ({@link matchLeader}). */
export type LeaderMatch =
  /** The same process: the start read now is the one recorded. */
  | "matches"
  /** Another process has the PID now, or none has. */
  | "differs"
  /** The record names no process, or no start: nothing can be matched. */
  | "unrecorded"
  /** The start cannot be read now: the leader may well be there. */
  | "unreadable";

/**
 * Whether a running record's group is still led by the process it names. Only a start read now
 * equal to the one recorded matches: a group id is a number the system hands out again.
 *
 * @param record - the record, as read back.
 * @param read - reads a process's start (`readLeaderStart`).
 * @returns how they compare.
 */
export async function matchLeader(
  record: Pick<RunningRecordRead, "process">,
  read: LeaderStartReader,
): Promise<LeaderMatch> {
  const recorded = record.process?.leaderStart;
  if (record.process === undefined || recorded === undefined)
    return "unrecorded";
  const now = await read(record.process.pgid);
  if (now.kind === "unknown") return "unreadable";
  return now.kind === "start" && now.value === recorded ? "matches" : "differs";
}

/**
 * A running record's process with its leader's start, read now: call it as the process is spawned,
 * before it can have ended and its PID gone to another. A start that cannot be read is left out.
 *
 * @param name - the process.
 * @param pgid - its group: its PID.
 * @param read - reads a process's start (`readLeaderStart`).
 */
export async function leaderProcess(
  name: RunningProcess["name"],
  pgid: number,
  read: LeaderStartReader,
): Promise<RunningProcess> {
  const start = await read(pgid);
  return start.kind === "start"
    ? { name, pgid, leaderStart: start.value }
    : { name, pgid };
}

/** What became of a write queued with a {@link RecordWriter}. */
export type RecordWriteResult = "written" | "dropped";

/** One run's record writes, one after another. */
export interface RecordWriter {
  /**
   * Queues a write: it applies after every write queued before it. A `running` record queued after a
   * record of the run's end is dropped, even when that write failed — a late process notice must
   * never make an ended run read as running.
   *
   * @param record - the record, or a promise of it (a leader's start still being read).
   * @returns what became of it.
   * @throws what the write throws, or the promise's rejection; later writes still apply.
   */
  write(record: RunRecord | Promise<RunRecord>): Promise<RecordWriteResult>;
}

/**
 * A run's record writer: every write to its `run.json` goes through it, in the order asked.
 *
 * @param path - the run's `run.json`.
 * @param write - writes one record; {@link writeRunRecord} by default.
 */
export function createRecordWriter(
  path: string,
  write: (path: string, record: RunRecord) => Promise<void> = writeRunRecord,
): RecordWriter {
  let queue: Promise<unknown> = Promise.resolve();
  let ended = false;
  return {
    write(record) {
      const pending = Promise.resolve(record);
      // Handled now: it may reject while earlier writes are still applying.
      pending.catch(() => undefined);
      const result = queue.then(async (): Promise<RecordWriteResult> => {
        const next = await pending;
        // Applied in call order, so "an end applied before" is "an end asked for before".
        if (next.state === "running" && ended) return "dropped";
        if (next.state !== "running") ended = true;
        await write(path, next);
        return "written";
      });
      queue = result.catch(() => undefined);
      return result;
    },
  };
}
