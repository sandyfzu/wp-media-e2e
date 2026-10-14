import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import { errorCode } from "../error-code";
import type { CappedMiss } from "../files";
import { RUN_FILES, RUNS_DIR } from "../runs/identity";
import type { LeaderStartReader } from "../runs/leader";
import { probeGroup, type KillFn } from "../runs/process-group";
import {
  MAX_RECORD_BYTES,
  lostRecord,
  readRunRecordFile,
  writeRunRecord,
  type RunningRecordRead,
  type RunRecord,
} from "../runs/record";
import { safeLine, shellWord } from "../text";

/**
 * The orphan check, as the orchestrator starts: every run whose record still says `running` is either
 * an **orphan** — its process group still the run's, holding its cell's sites: an orchestrator was
 * killed or crashed under it — or **stale**, and rewritten `lost` so it is not read again. An orphan
 * refuses the start ({@link orphanRefusal}): a second run on its cell would share its sites.
 *
 * What makes the group's number the run's: a PID is never handed out while a live process group has
 * that id (POSIX, XBD "Process ID Reuse"; measured on Linux 7.0 by steering `ns_last_pid` onto a live
 * group's id: the next fork skipped it, and took it once the group had ended). So, while group `N`
 * lives:
 * - a live process at PID `N` started when the record says is the run's leader: **confirmed**;
 * - one that started at another time made group `N` itself, after the run's had ended: **stale**;
 * - no process at PID `N` — its leader exited while members live on — is the run's own group with
 *   its runner gone (Playwright's workers outlive a killed runner by ~30 s), or a later process's
 *   group whose leader exited in turn: the two cannot be told apart, so it is an orphan,
 *   **unconfirmed**, and the refusal says how to check;
 * - members none of them ours to signal (`EPERM`) are a stranger's: the orchestrator spawns every
 *   run as itself. **Stale**.
 *
 * Anything else that cannot be checked now — the leader's start unreadable now or at spawn, the group
 * not askable — is an unconfirmed orphan too: a refusal can be retried, a record rewritten cannot.
 *
 * Run it under the orchestrator's lock, before any run starts: a run of this orchestrator still
 * starting, with no process recorded yet, would read as stale.
 */

/** A run left running: its group alive, and the run's or possibly the run's. */
export interface Orphan {
  readonly taskId: string;
  /** The run's id, `bpng-12`. */
  readonly id: string;
  readonly pgid: number;
  /** Its `run.json`, absolute. */
  readonly record: string;
  /** `false` when the group could not be shown to be the run's, and is assumed to be. */
  readonly confirmed: boolean;
  /** Why it could not be confirmed, in words; absent when confirmed. */
  readonly why?: string;
}

/** Why a running record is taken to be over. */
export type StaleReason =
  | "no process recorded"
  | "process group ended"
  | "process group not ours"
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
  | { readonly kind: "orphan"; readonly pgid: number; readonly confirmed: true }
  | {
      readonly kind: "orphan";
      readonly pgid: number;
      readonly confirmed: false;
      readonly why: string;
    }
  | { readonly kind: "stale"; readonly reason: StaleReason };

/**
 * Classifies one running record; see this module's description for each case.
 *
 * @param record - the record, as read back.
 * @param deps - `kill` and the start reader.
 * @returns orphan (confirmed, or not and why) or stale, and why.
 */
export async function classifyRunning(
  record: Pick<RunningRecordRead, "process">,
  deps: Pick<OrphanCheckDeps, "kill" | "readLeaderStart">,
): Promise<Classification> {
  const { process } = record;
  if (process === undefined)
    return { kind: "stale", reason: "no process recorded" };
  const { pgid } = process;
  const unconfirmed = (why: string): Classification => ({
    kind: "orphan",
    pgid,
    confirmed: false,
    why,
  });
  let group: ReturnType<typeof probeGroup>;
  try {
    group = probeGroup(pgid, deps.kill);
  } catch (error) {
    // `kill` answered what it never should: the group cannot be shown gone.
    return unconfirmed(
      `its group could not be asked (${errorCode(error) ?? "unknown error"})`,
    );
  }
  if (group === "empty")
    return { kind: "stale", reason: "process group ended" };
  if (group === "unsignallable")
    return { kind: "stale", reason: "process group not ours" };
  const recorded = process.leaderStart;
  if (recorded === undefined)
    return unconfirmed(
      process.leaderStartUnread === undefined
        ? "its leader's start was not recorded"
        : `its leader's start could not be read at spawn (${process.leaderStartUnread})`,
    );
  const now = await deps.readLeaderStart(pgid);
  if (now.kind === "start")
    return now.value === recorded
      ? { kind: "orphan", pgid, confirmed: true }
      : { kind: "stale", reason: "leader differs" };
  return unconfirmed(
    now.kind === "gone"
      ? `its ${process.name} process has exited, and the rest of its group still runs`
      : `its leader's start cannot be read now (${now.why})`,
  );
}

/**
 * Checks every run folder under `<stateDir>/runs/`. A record that cannot be read, or is not one, is
 * a warning and left as it is; only a run folder with no record yet is passed over in silence.
 *
 * @param stateDir - the state directory.
 * @param deps - the system.
 * @returns the orphans, the stale runs, and the warnings.
 * @throws when the runs' folder is a link (never followed) or no folder, or cannot be listed — with
 *   it unreadable, no run can be shown not to be an orphan. A missing one holds no run.
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
        record: path,
        confirmed: verdict.confirmed,
        ...(verdict.confirmed ? {} : { why: verdict.why }),
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
 * The refusal an orphan makes: the task, the run, its group, and the way out. A confirmed one names
 * the command that ends it; an unconfirmed one first says how to look at the group — `ps -g` selects
 * a process group on macOS and a session on Linux, the same thing for a run, which is spawned in a
 * session of its own — and how to mark the run over when the group is not its.
 *
 * @param orphan - the orphan.
 * @returns one line for the terminal and the log.
 */
export function orphanRefusal(orphan: Orphan): string {
  const pgid = String(orphan.pgid);
  const end = `kill -KILL -${pgid}`;
  if (orphan.confirmed)
    return (
      `Task ${orphan.taskId} still has run ${orphan.id} running, in process group ${pgid}: an ` +
      `orchestrator stopped without ending it, and a second run would share its sites. End it with: ${end}`
    );
  return (
    `Task ${orphan.taskId} may still have run ${orphan.id} running, in process group ${pgid} — ` +
    `unconfirmed: ${orphan.why ?? "it could not be checked"}. A second run would share its sites. ` +
    `Check the group first: ps -o pid,user,lstart,command -g ${pgid}. If those are the run's ` +
    `processes, end them with: ${end}. If not, mark the run over: in ` +
    `${safeLine(shellWord(orphan.record), 1000)}, set "state" to "lost".`
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
 * Reads one run folder's record, when it still says `running` (`readRunRecordFile`: never through a
 * link, never a FIFO, within its cap, and only when it names the folder it is in).
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
  const read = await readRunRecordFile(path, entry.name);
  switch (read.kind) {
    case "missing":
    case "over":
      return { kind: "skip" };
    case "running":
      return { kind: "running", record: read.record, path };
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
 * never followed: through a link, the check would rewrite records outside the state directory.
 *
 * @param runsDir - `<state>/runs`.
 * @throws an error coded `ELOOP` for a link, `ENOTDIR` for anything else but a folder, or what
 *   `lstat` and `readdir` throw besides `ENOENT`.
 */
async function listRuns(runsDir: string): Promise<Dirent[]> {
  try {
    const stats = await lstat(runsDir);
    if (stats.isSymbolicLink())
      throw Object.assign(
        new Error("the runs' folder is a symbolic link, never followed"),
        { code: "ELOOP" },
      );
    if (!stats.isDirectory())
      throw Object.assign(new Error("the runs' folder is not a folder"), {
        code: "ENOTDIR",
      });
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
  read: Exclude<CappedMiss, { kind: "missing" }>,
): string {
  if (read.kind === "tooLarge")
    return `is over ${String(MAX_RECORD_BYTES)} bytes`;
  return read.code === "ELOOP"
    ? "is a symbolic link"
    : `could not be read (${read.code})`;
}
