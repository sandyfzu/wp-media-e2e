import { dirname, join } from "node:path";

import { errorCode } from "../error-code";
import { RUN_FILES } from "../runs/identity";
import type { LeaderStartReader } from "../runs/leader";
import { probeGroup, type KillFn } from "../runs/process-group";
import {
  lostRecord,
  writeRunRecord,
  type RunningRecordRead,
  type RunRecord,
} from "../runs/record";
import { MAX_QUOTED_PATH, safeLine, shellWord } from "../text";
import {
  BOOT_TEXT,
  earlierBoot,
  readPidSpace,
  type PidSpace,
} from "./pid-space";
import { readRunningFolders, type RunFolderWarning } from "./run-folders";

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
 * - members none of them ours to signal (`EPERM`) are judged by the leader the same way: a run's own
 *   group may hold only another user's processes once the rest has ended — a `sudo` command the local
 *   transport runs as root, still working after the group's SIGKILL — so `EPERM` alone never makes a
 *   record stale, as it never makes a group empty (`waitForEmptyGroup`). Its leader gone, it is an
 *   **unconfirmed** orphan that says so.
 *
 * Anything else that cannot be checked now — the leader's start unreadable now or at spawn, the group
 * not askable — is an unconfirmed orphan too: a refusal can be retried, a record rewritten cannot. So
 * is a record saying a process was **starting** (`startingRecord`): its orchestrator stopped between
 * writing it and recording the process's group, the process may run, and with no group recorded there
 * is nothing to probe — the refusal says how to find its processes instead. And so is a run folder
 * whose record is there but cannot be read, or is not one (a link, over its cap, `EACCES`, malformed):
 * nothing says its run is over. Records are written atomically, so none is left half-written.
 *
 * A leader started in an **earlier boot** of this machine (`linux:<boot>:<ticks>`, its boot not this
 * one's, as `earlierBoot` judges a lock's) ended with that boot: stale, whatever now holds its group's
 * number.
 *
 * Run it under the orchestrator's lock, before any run starts: a run of this orchestrator still
 * starting, with no process recorded yet, would read as stale.
 */

/** A run left running: its group alive, and the run's or possibly the run's. */
export interface RunOrphan {
  readonly taskId: string;
  /** The run's id, `bpng-12`. */
  readonly id: string;
  /** Its process group; absent when the record names none — a process was starting. */
  readonly pgid?: number;
  /** Its `run.json`, absolute. */
  readonly record: string;
  /** `false` when the group could not be shown to be the run's, and is assumed to be. */
  readonly confirmed: boolean;
  /** Why it could not be confirmed, in words; absent when confirmed. */
  readonly why?: string;
}

/** A run folder whose record is there but cannot be read, or is not one: its run may still run. */
export interface UnreadOrphan {
  /** The run folder's name, as listed: the run's id. */
  readonly id: string;
  /** Its `run.json`, absolute. */
  readonly record: string;
  /** Why it cannot be read, as the end of a sentence naming it: `is a symbolic link`. */
  readonly unread: string;
  /** Never shown to be the run's. */
  readonly confirmed: false;
}

/** A run that refuses the start: one left running, or one whose record cannot tell. */
export type Orphan = RunOrphan | UnreadOrphan;

/** Why a running record is taken to be over. */
export type StaleReason =
  | "no process recorded"
  | "process group ended"
  | "leader differs"
  | "earlier boot";

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
  /** This process's PID space, for a leader from an earlier boot; `readPidSpace` by default. */
  readonly space?: () => Promise<PidSpace>;
}

/** How one running record is classified. */
export type Classification =
  | { readonly kind: "orphan"; readonly pgid: number; readonly confirmed: true }
  | {
      readonly kind: "orphan";
      /** Absent when the record names no group: a process was starting. */
      readonly pgid?: number;
      readonly confirmed: false;
      readonly why: string;
    }
  | { readonly kind: "stale"; readonly reason: StaleReason };

/**
 * Classifies one running record; see this module's description for each case.
 *
 * @param record - the record, as read back.
 * @param deps - `kill`, the start reader, and this process's PID space.
 * @returns orphan (confirmed, or not and why) or stale, and why.
 */
export async function classifyRunning(
  record: Pick<RunningRecordRead, "process" | "starting">,
  deps: Pick<OrphanCheckDeps, "kill" | "readLeaderStart" | "space">,
): Promise<Classification> {
  if (record.starting !== undefined)
    return {
      kind: "orphan",
      confirmed: false,
      why: `its orchestrator stopped while starting its ${record.starting} process, before recording the process's group`,
    };
  const { process } = record;
  if (process === undefined)
    return { kind: "stale", reason: "no process recorded" };
  // Before the group is asked: after a reboot its number may be any process's.
  if (await fromEarlierBoot(process.leaderStart, deps.space ?? readPidSpace))
    return { kind: "stale", reason: "earlier boot" };
  const { pgid } = process;
  /** An orphan of this group that could not be confirmed, and why (`why`). */
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
  if (now.kind === "unknown")
    return unconfirmed(`its leader's start cannot be read now (${now.why})`);
  return unconfirmed(
    group === "unsignallable"
      ? `its ${process.name} process has exited, and only processes of another user remain in its group — a command the run ran as that user (sudo), or that user's own group; ending them needs that user`
      : `its ${process.name} process has exited, and the rest of its group still runs`,
  );
}

/** A Linux leader start as `readLeaderStart` writes it: `linux:<boot id>:<ticks>`. */
const LINUX_START = /^linux:([^:]+):[0-9]+$/;

/**
 * Whether a recorded leader start is from an earlier boot of this machine: {@link earlierBoot} of this
 * process's space and the same space at the recorded boot — every run is judged in this process's PID
 * space (its group is asked here), so the run's space is this one but for its boot. A container, a
 * machine with no id, a start that is not Linux's or names no boot id: never so judged.
 *
 * @param recorded - the leader's start, as recorded at spawn.
 * @param space - reads this process's PID space; read only for a Linux start.
 * @returns `true` only when the recorded boot is shown to be an earlier one.
 */
async function fromEarlierBoot(
  recorded: string | undefined,
  space: () => Promise<PidSpace>,
): Promise<boolean> {
  const boot =
    recorded === undefined ? undefined : LINUX_START.exec(recorded)?.[1];
  if (boot === undefined || !BOOT_TEXT.test(boot)) return false;
  const now = await space();
  return earlierBoot({ ...now, boot }, now);
}

/**
 * Checks every run folder under `<stateDir>/runs/`. A record that is there but cannot be read, or is
 * not one, is an unconfirmed orphan ({@link UnreadOrphan}); an entry that is no folder is a warning;
 * a run folder with no record yet is passed over in silence.
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
  const orphans: Orphan[] = [];
  const stale: StaleRun[] = [];
  const folders = await readRunningFolders(stateDir);
  const warnings: string[] = [];
  for (const warning of folders.warnings) {
    const orphan = unreadOrphan(warning);
    if (orphan === undefined) warnings.push(warning.text);
    else orphans.push(orphan);
  }
  for (const { record, path } of folders.running) {
    const verdict = await classifyRunning(record, deps);
    if (verdict.kind === "orphan") {
      orphans.push({
        taskId: record.taskId,
        id: record.id,
        ...(verdict.pgid === undefined ? {} : { pgid: verdict.pgid }),
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
  return { orphans: orphans.sort(byId), stale, warnings };
}

/**
 * The orphan a run folder's warning makes when its record is there but unread.
 *
 * @param warning - the run folder's warning.
 * @returns the orphan; `undefined` for an entry that is no folder.
 */
export function unreadOrphan(
  warning: RunFolderWarning,
): UnreadOrphan | undefined {
  if (warning.unread === undefined) return undefined;
  return {
    id: warning.name,
    record: warning.unread.path,
    unread: warning.unread.why,
    confirmed: false,
  };
}

/**
 * Orders orphans as their run folders are listed: by id, code unit by code unit.
 *
 * @param a - one orphan.
 * @param b - another.
 * @returns their order.
 */
function byId(a: Orphan, b: Orphan): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The refusal an orphan makes: the task, the run, its group, and the way out. A confirmed one names
 * the command that ends it; an unconfirmed one first says how to look at the group — `ps -g` selects
 * a process group on macOS and a session on Linux, the same thing for a run, which is spawned in a
 * session of its own — and how to mark the run over when the group is not its. One with no group
 * recorded, or whose record cannot be read, says how to find the run's processes: each the run spawned
 * writes its output to the run's log, so `lsof` on the log lists them while they run.
 *
 * @param orphan - the orphan.
 * @returns one line for the terminal and the log.
 */
export function orphanRefusal(orphan: Orphan): string {
  if ("unread" in orphan) return unreadRefusal(orphan);
  const markLost = `mark the run over: in ${safeLine(shellWord(orphan.record), MAX_QUOTED_PATH)}, set "state" to "lost".`;
  if (orphan.pgid === undefined) return groupUnknownRefusal(orphan, markLost);
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
    `processes, end them with: ${end}. If not, ${markLost}`
  );
}

/**
 * The refusal of an orphan whose record names no group: how to find the run's processes by its log,
 * which each of them writes its output to.
 *
 * @param orphan - the orphan, without a group.
 * @param markLost - how to mark the run over, as the sentence's end.
 * @returns one line for the terminal and the log.
 */
function groupUnknownRefusal(orphan: RunOrphan, markLost: string): string {
  return (
    `Task ${orphan.taskId} may still have run ${orphan.id} running — unconfirmed: ` +
    `${orphan.why ?? "it could not be checked"}. A second run would share its sites. ` +
    `${lookByLog(orphan.record)} If there are none, ${markLost}`
  );
}

/**
 * The refusal of a run whose record is there but cannot be read: nothing says it is over. How to find
 * its processes by its log, and — none found — how to set the record aside, after which its folder is
 * one with no record: passed over by the orphan check, and kept by the retention, as any other.
 *
 * @param orphan - the unread run.
 * @returns one line for the terminal and the log.
 */
function unreadRefusal(orphan: UnreadOrphan): string {
  const record = safeLine(shellWord(orphan.record), MAX_QUOTED_PATH);
  const aside = safeLine(shellWord(`${orphan.record}.unread`), MAX_QUOTED_PATH);
  return (
    `Run ${safeLine(orphan.id, 80)} may still be running — unconfirmed: its record ${orphan.unread}, ` +
    `so nothing says it is over. A second run would share its sites. ${lookByLog(orphan.record)} ` +
    `If there are none, repair its record, or set it aside: mv ${record} ${aside}`
  );
}

/**
 * How to find and end a run's processes by its log, which each of them writes its output to.
 *
 * @param record - the run's `run.json`, beside its log.
 * @returns two sentences.
 */
function lookByLog(record: string): string {
  const log = safeLine(
    shellWord(join(dirname(record), RUN_FILES.log)),
    MAX_QUOTED_PATH,
  );
  return (
    `Look for its processes first: lsof -- ${log} lists those writing its log. End each one's group ` +
    `with: kill -KILL -<PGID>, its PGID from: ps -o pgid= -p <PID>.`
  );
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
