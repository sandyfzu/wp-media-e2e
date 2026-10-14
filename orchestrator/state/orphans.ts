import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { errorCode } from "../error-code";
import { readCapped, type CappedRead } from "../files";
import { RUN_FILES, RUNS_DIR } from "../runs/identity";
import type { LeaderStartReader } from "../runs/leader";
import { groupAlive, type KillFn } from "../runs/process-group";
import {
  lostRecord,
  matchLeader,
  readRecord,
  writeRunRecord,
  type RunningRecordRead,
  type RunRecord,
} from "../runs/record";
import { safeLine } from "../text";

/**
 * The orphan check, as the orchestrator starts: every run whose record still says `running` is either
 * an **orphan** — its group alive and still led by the process the record names: a run an
 * orchestrator killed or crashed under left holding its cell's sites — or **stale**, and rewritten
 * `lost` so it is not read again. An orphan refuses the start ({@link orphanRefusal}): a second run on
 * its cell would share its sites.
 *
 * Stale is anything else: no process recorded, its group gone, its leader's start not recorded, or a
 * leader that differs — the group's number handed to another process, or its leader gone while
 * members live on. That last is the run's own workers only in the moments after its runner exited;
 * any longer it is a stranger's group, and refusing on it would refuse for as long as it lives.
 * What cannot be checked now — the leader's start unreadable, the group not askable — is an orphan,
 * unconfirmed: a refusal can be retried, a record rewritten cannot.
 *
 * Run it under the orchestrator's lock, before any run starts: a run of this orchestrator still
 * starting, with no process recorded yet, would read as stale.
 */

/** The largest record read, in bytes: a running one is under 1 KiB, an ended one a few. */
export const MAX_RECORD_BYTES = 1024 * 1024;

/** A run left running: its group alive, led by the process its record names. */
export interface Orphan {
  readonly taskId: string;
  /** The run's id, `bpng-12`. */
  readonly id: string;
  readonly pgid: number;
  /** `false` when that could not be checked now, and is assumed. */
  readonly confirmed: boolean;
}

/** Why a running record is taken to be over. */
export type StaleReason =
  | "no process recorded"
  | "process group ended"
  | "leader's start not recorded"
  | "leader differs";

/** A running record found over. */
export interface StaleRun {
  readonly id: string;
  readonly reason: StaleReason;
  /** Whether it was rewritten `lost`; a failure is also a warning. */
  readonly rewritten: boolean;
}

/** What the check found. */
export interface OrphanCheck {
  /** Each refuses the start. In run-folder order. */
  readonly orphans: readonly Orphan[];
  readonly stale: readonly StaleRun[];
  /** What could not be read or rewritten, one line each, safe to log. */
  readonly warnings: readonly string[];
}

/** What the check needs from the system: injected, so each answer it can give is tested. */
export interface OrphanCheckDeps {
  /** `process.kill`, asked whether a group has a member. */
  readonly kill: KillFn;
  /** Reads a process's start (`readLeaderStart`). */
  readonly readLeaderStart: LeaderStartReader;
  readonly now: () => Date;
  /** Writes a record; `writeRunRecord` (atomic) by default. */
  readonly writeRecord?: (path: string, record: RunRecord) => Promise<void>;
}

/** How one running record is classified. */
export type Classification =
  | {
      readonly kind: "orphan";
      readonly pgid: number;
      readonly confirmed: boolean;
    }
  | { readonly kind: "stale"; readonly reason: StaleReason };

/**
 * Classifies one running record.
 *
 * @param record - the record, as read back.
 * @param deps - `kill` and the start reader.
 * @returns orphan (confirmed or not) or stale, and why.
 */
export async function classifyRunning(
  record: Pick<RunningRecordRead, "process">,
  deps: Pick<OrphanCheckDeps, "kill" | "readLeaderStart">,
): Promise<Classification> {
  const { process } = record;
  if (process === undefined)
    return { kind: "stale", reason: "no process recorded" };
  const unconfirmed = {
    kind: "orphan",
    pgid: process.pgid,
    confirmed: false,
  } as const;
  try {
    if (!groupAlive(process.pgid, deps.kill))
      return { kind: "stale", reason: "process group ended" };
  } catch {
    // `kill` answered what it never should: the group cannot be shown gone.
    return unconfirmed;
  }
  switch (await matchLeader(record, deps.readLeaderStart)) {
    case "matches":
      return { ...unconfirmed, confirmed: true };
    case "unreadable":
      return unconfirmed;
    case "unrecorded":
      return { kind: "stale", reason: "leader's start not recorded" };
    case "differs":
      return { kind: "stale", reason: "leader differs" };
  }
}

/**
 * Checks every run folder under `<stateDir>/runs/`. A record that cannot be read, or is not one, is
 * a warning and left as it is; only a run folder with no record yet is passed over in silence.
 *
 * @param stateDir - the state directory.
 * @param deps - the system.
 * @returns the orphans, the stale runs, and the warnings.
 * @throws what listing the runs' folder throws besides `ENOENT` — with the folder unreadable, no run
 *   can be shown not to be an orphan.
 */
export async function checkOrphans(
  stateDir: string,
  deps: OrphanCheckDeps,
): Promise<OrphanCheck> {
  const runsDir = join(stateDir, RUNS_DIR);
  const orphans: Orphan[] = [];
  const stale: StaleRun[] = [];
  const warnings: string[] = [];
  for (const entry of await listRuns(runsDir)) {
    const read = await readRunning(runsDir, entry);
    if (read.kind === "skip") continue;
    if (read.kind === "warning") {
      warnings.push(read.text);
      continue;
    }
    const { record, path } = read;
    const verdict = await classifyRunning(record, deps);
    if (verdict.kind === "orphan") {
      orphans.push({
        taskId: record.taskId,
        id: record.id,
        pgid: verdict.pgid,
        confirmed: verdict.confirmed,
      });
      continue;
    }
    const code = await markLost(path, record, verdict.reason, deps);
    if (code !== undefined)
      warnings.push(
        `run ${record.id}'s record could not be marked lost (${code}): it is read again at the next start`,
      );
    stale.push({
      id: record.id,
      reason: verdict.reason,
      rewritten: code === undefined,
    });
  }
  return { orphans, stale, warnings };
}

/**
 * The refusal an orphan makes: the task, the run, its group, and the command that ends it.
 *
 * @param orphan - the orphan.
 * @returns one line for the terminal and the log.
 */
export function orphanRefusal(orphan: Orphan): string {
  const pgid = String(orphan.pgid);
  const unconfirmed = orphan.confirmed
    ? ""
    : " (it could not be confirmed that the group is still the run's)";
  return (
    `Task ${orphan.taskId} still has run ${orphan.id} running, in process group ${pgid}` +
    `${unconfirmed}: an orchestrator stopped without ending it, and a second run would share its ` +
    `sites. End it with: kill -KILL -${pgid}`
  );
}

/** One run folder's record, read: a running one, nothing to do, or a warning. */
type RunningRead =
  | {
      readonly kind: "running";
      readonly record: RunningRecordRead;
      readonly path: string;
    }
  | { readonly kind: "skip" }
  | { readonly kind: "warning"; readonly text: string };

/**
 * Reads one run folder's record, when it still says `running`: never through a link, never a FIFO,
 * within {@link MAX_RECORD_BYTES}, and only when it names the folder it is in.
 *
 * @param runsDir - `<state>/runs`.
 * @param entry - the folder's entry.
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
  const read = await readCapped(path, MAX_RECORD_BYTES, { followLink: false });
  if (read.kind === "missing") return { kind: "skip" };
  if (read.kind !== "text")
    return {
      kind: "warning",
      text: `run ${name}'s record ${describeUnread(read)}: passed over`,
    };
  const record = readRecord(read.text);
  if (record.kind === "over") return { kind: "skip" };
  if (record.kind === "malformed" || record.record.id !== entry.name)
    return {
      kind: "warning",
      text: `run ${name}'s record is not one this orchestrator reads: passed over`,
    };
  return { kind: "running", record: record.record, path };
}

/**
 * The runs' folder's entries, sorted by name; none when it does not exist yet.
 *
 * @param runsDir - `<state>/runs`.
 */
async function listRuns(runsDir: string): Promise<Dirent[]> {
  try {
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
 * Rewrites a stale record as `lost`, atomically.
 *
 * @param path - its `run.json`.
 * @param record - what it said.
 * @param reason - why it is over.
 * @param deps - the clock and the writer.
 * @returns `undefined` once written, else the error's code.
 */
async function markLost(
  path: string,
  record: RunningRecordRead,
  reason: StaleReason,
  deps: OrphanCheckDeps,
): Promise<string | undefined> {
  try {
    await (deps.writeRecord ?? writeRunRecord)(
      path,
      lostRecord(record, reason, deps.now()),
    );
    return undefined;
  } catch (error) {
    return errorCode(error) ?? "unknown error";
  }
}

/**
 * Why a record could not be read, in words.
 *
 * @param read - the failed read.
 */
function describeUnread(
  read: Exclude<CappedRead, { kind: "text" } | { kind: "missing" }>,
): string {
  if (read.kind === "tooLarge")
    return `is over ${String(MAX_RECORD_BYTES)} bytes`;
  return read.code === "ELOOP"
    ? "is a symbolic link"
    : `could not be read (${read.code})`;
}
