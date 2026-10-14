import { lstat } from "node:fs/promises";
import { z } from "zod";

import { parseRunId } from "../../src/common/config/run-id";
import { isoInstant } from "../../src/common/reporting/retention";
import { TASK_ID_PATTERN } from "../config/schema";
import { errorCode } from "../error-code";
import type { RunFinishedEvent } from "../events/run-finished";
import { readCapped, type CappedMiss } from "../files";
import { writeJsonAtomic } from "../state/atomic";
import type { RunIdentity } from "./identity";
import type { LaunchResult } from "./launch";
import type { LeaderStart, LeaderStartReader } from "./leader";

/**
 * A run's record, `run.json` in its folder: written as it starts (`running`, with the process group
 * once one exists) and again as it ends (`ended`, with how its processes ended and its
 * `run.finished`). A record still `running` when an orchestrator starts is either an **orphan** — its
 * group still the run's, holding its cell's sites — or over without its end recorded, and then
 * rewritten `lost` (`state/orphans.ts`). Each run's writes go through one {@link RecordWriter}, in
 * order, so a late `running` never replaces the end.
 *
 * Every reader — the orphan check and run-folder retention — sorts a record through
 * {@link readRunRecordFile} alone, so the two can never disagree on what a record is.
 *
 * The version stays 1 through additive fields: `process.leaderStart` and `process.leaderStartUnread`
 * are optional, and a record with neither was written before they existed.
 */

/** The record's schema version. */
export const RUN_RECORD_VERSION = 1;

/** Every state a record can be in. */
export const RUN_STATES = ["running", "ended", "lost"] as const;

/** A record's state. */
export type RunState = (typeof RUN_STATES)[number];

/** The states of a run that is over. */
const OVER_STATES = ["ended", "lost"] as const satisfies readonly RunState[];

/** The largest `run.json` read, in bytes: a running one is under 1 KiB, an ended one a few KiB. */
export const MAX_RECORD_BYTES = 1024 * 1024;

/** What every record says. */
interface RecordBase {
  readonly v: typeof RUN_RECORD_VERSION;
  /** `bpng-12`. */
  readonly id: string;
  readonly runId: string;
  readonly taskId: string;
  /** ISO 8601, as `Date.prototype.toISOString` writes it. */
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
   * When it started, as `readLeaderStart` read it at spawn: what tells it from a later process given
   * the same number. Absent when that read failed ({@link RunningProcess.leaderStartUnread}).
   */
  readonly leaderStart?: string;
  /** Why its start could not be read at spawn: `gone` (it had already exited), or the reader's why. */
  readonly leaderStartUnread?: string;
}

/** A run that has ended. */
export interface EndedRecord extends RecordBase, LaunchResult {
  readonly state: "ended";
  readonly endedAt: string;
  readonly event: RunFinishedEvent;
}

/**
 * A run found over without its end recorded: still `running` when an orchestrator started again, its
 * group gone or someone else's. How its processes ended is unknown and it never had its
 * `run.finished`, so it is no {@link EndedRecord}, which promises both.
 */
export interface LostRecord extends RecordBase {
  readonly state: "lost";
  /** The process its running record named, kept for whoever looks into it. */
  readonly process?: RunningProcess;
  /** When it was found over: ISO 8601. */
  readonly foundAt: string;
  /** Why it is taken to be over. */
  readonly reason: string;
}

/** A run's record. */
export type RunRecord = RunningRecord | EndedRecord | LostRecord;

/**
 * The record of a run starting, or of its process starting.
 *
 * @param identity - the run.
 * @param taskId - its task.
 * @param process - the process running now, once one is ({@link leaderProcess}).
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

/** A run's id as `runIdOf` makes it: a task's id, then a number from 1. */
const RUN_ID_PATTERN = /^[a-z0-9]+-[1-9][0-9]{0,15}$/;

/** The longest {@link recordWords} text, in characters. */
export const MAX_RECORD_WORDS = 200;

/** What a record's words are: printable ASCII, so a message may quote it, 1 to 200 characters. */
const WORDS_PATTERN = new RegExp(
  `^[\\x20-\\x7e]{1,${String(MAX_RECORD_WORDS)}}$`,
);

/** A reason the orchestrator wrote, as read back ({@link WORDS_PATTERN}). */
const WORDS = z.string().regex(WORDS_PATTERN);

/**
 * Text as a record's words: what the reader accepts ({@link WORDS_PATTERN}), so a record written can
 * always be read back — a word the reader refused would make the whole record malformed, and a live
 * run passed over. Each run of characters outside printable ASCII becomes `?`, once the text is trimmed; blank text is
 * `unknown`; a text past {@link MAX_RECORD_WORDS} is cut, `...` closing it.
 *
 * @param text - what to record, from anywhere (a system's error code, a reader's why).
 * @returns the words.
 * @example
 * ```ts
 * recordWords("ERR_ü\n"); // "ERR_?"
 * ```
 */
export function recordWords(text: string): string {
  const words = text.trim().replace(/[^\x20-\x7e]+/g, "?");
  if (words === "") return "unknown";
  return words.length > MAX_RECORD_WORDS
    ? `${words.slice(0, MAX_RECORD_WORDS - 3)}...`
    : words;
}

/**
 * What every record is read back for: who the run is — each field a message may quote checked to be
 * what the orchestrator writes, so none can carry a control character — and when it started.
 */
const baseShape = {
  v: z.literal(RUN_RECORD_VERSION),
  id: z.string().regex(RUN_ID_PATTERN),
  runId: z.string(),
  taskId: z.string().regex(TASK_ID_PATTERN),
  // Checked by `consistent`: in the one form the orchestrator writes, and its RUN_ID's time.
  startedAt: z.string(),
};

/**
 * The run's id is its task's, and its RUN_ID is its start and its id — so a start in any form but
 * `toISOString`'s (no zone, read as local time; no milliseconds) is no record's.
 *
 * @param record - the identity read back.
 */
function consistent(record: {
  readonly id: string;
  readonly runId: string;
  readonly taskId: string;
  readonly startedAt: string;
}): boolean {
  const runId = parseRunId(record.runId);
  return (
    record.id.startsWith(`${record.taskId}-`) &&
    runId?.suffix === record.id &&
    runId.time === isoInstant(record.startedAt)
  );
}

/** A record still running, as read back: its identity and enough to find its group. */
const runningSchema = z
  .object({
    ...baseShape,
    state: z.literal("running"),
    process: z
      .object({
        name: z.enum(["bddgen", "playwright"]),
        // A group id that would reach every process (1), or the orchestrator's own (0), is no run's.
        pgid: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
        leaderStart: WORDS.optional(),
        leaderStartUnread: WORDS.optional(),
      })
      .optional(),
  })
  .refine(consistent);

/** A record of a run that is over, as read back: its identity, start and state, nothing else. */
const overSchema = z
  .object({ ...baseShape, state: z.enum(OVER_STATES) })
  .refine(consistent);

/** A record that says its run is still running, as read back. */
export type RunningRecordRead = z.output<typeof runningSchema>;

/** A record of a run that is over (`ended` or `lost`), as read back. */
export type OverRecordRead = z.output<typeof overSchema>;

/** A record's text, sorted ({@link parseRunRecord}). */
export type RecordRead =
  | { readonly kind: "running"; readonly record: RunningRecordRead }
  | { readonly kind: "over"; readonly record: OverRecordRead }
  /** Not a record this orchestrator reads, or not this folder's: why, in words. */
  | { readonly kind: "malformed"; readonly why: string };

/** A run folder's `run.json`, read and sorted ({@link readRunRecordFile}). */
export type RecordFileRead = RecordRead | CappedMiss;

/**
 * Sorts a record's text: still running, over, or malformed. A record is only ever its own folder's.
 *
 * @param text - `run.json`'s text.
 * @param id - the run folder's name, the run's id the record must name.
 * @returns the record as read back, or why it is none.
 */
export function parseRunRecord(text: string, id: string): RecordRead {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "malformed", why: "not JSON" };
  }
  const running = runningSchema.safeParse(json);
  const read: RecordRead = running.success
    ? { kind: "running", record: running.data }
    : overOrMalformed(json);
  if (read.kind !== "malformed" && read.record.id !== id)
    return { kind: "malformed", why: "another run's record" };
  return read;
}

/**
 * A parsed record that is not a running one: over, or malformed.
 *
 * @param json - the parsed text.
 */
function overOrMalformed(json: unknown): RecordRead {
  const over = overSchema.safeParse(json);
  return over.success
    ? { kind: "over", record: over.data }
    : { kind: "malformed", why: "not a run record this orchestrator reads" };
}

/**
 * Reads and sorts a run folder's `run.json`: never through a link, never waiting on a FIFO, never
 * past {@link MAX_RECORD_BYTES}.
 *
 * @param path - the record's path.
 * @param id - the run folder's name.
 * @returns why nothing was read, or the record sorted ({@link parseRunRecord}). Never rejects.
 */
export async function readRunRecordFile(
  path: string,
  id: string,
): Promise<RecordFileRead> {
  const read = await readCapped(path, MAX_RECORD_BYTES, { followLink: false });
  return read.kind === "text" ? parseRunRecord(read.text, id) : read;
}

/**
 * The record of a run found over: what its running record said, now `lost`.
 *
 * @param record - its running record, as read back.
 * @param reason - why it is taken to be over.
 * @param foundAt - now.
 */
export function lostRecord(
  record: RunningRecordRead,
  reason: string,
  foundAt: Date,
): LostRecord {
  return {
    v: RUN_RECORD_VERSION,
    state: "lost",
    id: record.id,
    runId: record.runId,
    taskId: record.taskId,
    startedAt: record.startedAt,
    ...(record.process === undefined ? {} : { process: record.process }),
    foundAt: foundAt.toISOString(),
    reason,
  };
}

/**
 * A running record's process with its leader's start, read now: call it as the process is spawned,
 * before it can have ended and its PID gone to another. A read that cannot tell is tried once more;
 * a start still unread is recorded as such, with why ({@link recordWords}, so the record reads back) —
 * never left out silently, since the orphan check must then assume the run may be live.
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
  let start: LeaderStart = await read(pgid);
  if (start.kind === "unknown") start = await read(pgid);
  // A start the reader would refuse is no start to match against: recorded as unread instead.
  if (start.kind === "start" && WORDS_PATTERN.test(start.value))
    return { name, pgid, leaderStart: start.value };
  if (start.kind === "start")
    return { name, pgid, leaderStartUnread: "start not recordable" };
  return {
    name,
    pgid,
    leaderStartUnread: start.kind === "gone" ? "gone" : recordWords(start.why),
  };
}

/** What became of a write queued with a {@link RecordWriter}. */
export type RecordWriteResult = "written" | "dropped";

/** One run's record writes, one after another. */
export interface RecordWriter {
  /**
   * Queues a write: it applies after every write queued before it. A `running` record queued after a
   * record of the run's end is dropped, even when that write failed — a late process notice must
   * never make an ended run read as running. The first write refuses a path that already holds
   * anything: a run's record is new, and a number handed out twice must never overwrite an earlier
   * run's record (that write rejects with code `EEXIST`, and so does every later one).
   *
   * Write the first record only once `launchRun` has passed its checks of the run folder. Every write
   * may reject: await it or catch it — an unhandled rejection ends the orchestrator.
   *
   * @param record - the record, or a promise of it (a leader's start still being read).
   * @returns what became of it.
   * @throws what the write throws, or the promise's rejection; later writes still apply.
   */
  write(record: RunRecord | Promise<RunRecord>): Promise<RecordWriteResult>;
}

/** What a {@link RecordWriter} needs from the system: injected, so each answer is tested. */
export interface RecordWriterDeps {
  /** Writes one record; {@link writeRunRecord} by default. */
  readonly write?: (path: string, record: RunRecord) => Promise<void>;
  /** Whether anything is at a path, never following a link; `lstat` by default. */
  readonly taken?: (path: string) => Promise<boolean>;
}

/**
 * A run's record writer: every write to its `run.json` goes through it, in the order asked.
 *
 * @param path - the run's `run.json`.
 * @param deps - the writer and the existence check; the real ones by default.
 */
export function createRecordWriter(
  path: string,
  deps: RecordWriterDeps = {},
): RecordWriter {
  const write = deps.write ?? writeRunRecord;
  const taken = deps.taken ?? pathTaken;
  let queue: Promise<unknown> = Promise.resolve();
  let ended = false;
  // Settled by the first write's check; every later write waits for it in the queue.
  let fresh: boolean | undefined;
  return {
    write(record) {
      const pending = Promise.resolve(record);
      // Handled now: it may reject while earlier writes are still applying.
      pending.catch(() => undefined);
      const result = queue.then(async (): Promise<RecordWriteResult> => {
        fresh ??= !(await taken(path));
        if (!fresh)
          throw Object.assign(
            new Error("a record is already there: a run's record is new"),
            { code: "EEXIST" },
          );
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

/**
 * Whether anything is at `path` — a file, a folder, a link, even a dangling one.
 *
 * @param path - the path.
 * @throws what `lstat` throws besides `ENOENT`.
 */
async function pathTaken(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}
