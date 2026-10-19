import { errorCode } from "../error-code";
import { checkOwnFolder, STATE_FOLDER } from "../folders";
import { readLeaderStart } from "../runs/leader";
import { failureLine } from "../text";
import {
  cellLocks,
  cellLocksFolder,
  type CellLocks,
  type CellUnit,
} from "./cell-lock";
import { inspectLock, stateFolderProblem, type LockDeps } from "./lock";
import { classifyRunning, orphanRefusal, unreadOrphan } from "./orphans";
import { readRunningFolders } from "./run-folders";

/**
 * The state directory as a start would find it, judged without writing anything — for `--dry-run`,
 * which may run beside an orchestrator holding it: the folder by the lock's own rule
 * (`checkOwnFolder` with `STATE_FOLDER`), then the lock by the lock's own judgement (`inspectLock`),
 * then — the lock free — the runs an earlier orchestrator left running, as the orphan check finds them
 * (`classifyRunning`; a stale record is left as it is, never marked `lost`), and each selected task's
 * cell's lock (`cell-lock.ts`).
 */

/** What {@link inspectState} judges: the selected cells; and with what: the lock's stand-ins, the cells' locks. */
export type InspectOptions = Pick<
  LockDeps,
  "pid" | "kill" | "space" | "readStart"
> & {
  /** The selected tasks' cells; none by default. */
  readonly units?: readonly CellUnit[];
  /** The cells' locks; those of `cellLocksFolder(process.env)` by default. */
  readonly cells?: Pick<CellLocks, "inspect">;
};

/** The longest failure a warning quotes, in code points. */
const MAX_FAILURE = 1_000;

/**
 * What would stop a start on `stateDir`, each as a warning naming its repair: a folder others may
 * write in or that is not this user's, a lock a live orchestrator holds, one from another PID space,
 * one that cannot be read; a run an earlier orchestrator left running; a selected cell another
 * orchestrator runs. A dead orchestrator's lock is no warning: a start takes it over. Each is judged
 * only once what a start judges before it passes — the lock in a sound folder, the runs and the
 * cells under a free lock (a live orchestrator's own runs and cells are its, not orphans).
 *
 * @param stateDir - the state directory (the config's folder).
 * @param options - the selected tasks' cells; the lock's stand-ins — this process's PID, `kill`,
 *   start reader and PID space — and the cells' locks.
 * @returns the warnings; none when a start would go ahead. Never rejects.
 *
 * @example
 * ```ts
 * const warnings = await inspectState(loaded.stateDir);
 * // ["a start would be refused: Another orchestrator (pid 4242) holds …/orchestrator.lock. …"]
 * ```
 */
export async function inspectState(
  stateDir: string,
  options: InspectOptions = {},
): Promise<string[]> {
  // A start refuses the folder before it reads the lock: so is the lock judged only in a sound one.
  const folder = await folderWarnings(stateDir);
  if (folder.length > 0) return folder;
  const lock = await lockWarnings(stateDir, options);
  if (lock.length > 0) return lock;
  return [
    ...(await orphanWarnings(stateDir, options)),
    ...(await cellWarnings(options.units ?? [], options)),
  ];
}

/**
 * The runs an earlier orchestrator left running, judged as the orphan check judges them, read only: a
 * record that is there but cannot be read refuses as it does.
 *
 * @param stateDir - the state directory.
 * @param deps - `kill`, the start reader and this process's PID space.
 * @returns a refusal per orphan, and each entry that is no run folder.
 */
async function orphanWarnings(
  stateDir: string,
  deps: InspectOptions,
): Promise<string[]> {
  const judge = {
    kill:
      deps.kill ??
      ((pid: number, signal: NodeJS.Signals | 0) => process.kill(pid, signal)),
    readLeaderStart: deps.readStart ?? readLeaderStart,
    ...(deps.space === undefined ? {} : { space: deps.space }),
  };
  const warnings: string[] = [];
  try {
    const folders = await readRunningFolders(stateDir);
    for (const warning of folders.warnings) {
      const unread = unreadOrphan(warning);
      warnings.push(
        unread === undefined ? warning.text : refused(orphanRefusal(unread)),
      );
    }
    for (const { record, path } of folders.running) {
      const verdict = await classifyRunning(record, judge);
      if (verdict.kind === "stale") continue;
      warnings.push(
        refused(
          orphanRefusal({
            taskId: record.taskId,
            id: record.id,
            ...(verdict.pgid === undefined ? {} : { pgid: verdict.pgid }),
            record: path,
            confirmed: verdict.confirmed,
            ...(verdict.confirmed ? {} : { why: verdict.why }),
          }),
        ),
      );
    }
  } catch (error) {
    warnings.push(
      refused(
        `the runs' records could not be checked for a run still running: ${failureLine(error, MAX_FAILURE)}`,
      ),
    );
  }
  return warnings;
}

/**
 * Each selected cell's lock, judged as a start would judge it.
 *
 * @param units - the cells.
 * @param deps - the cells' locks.
 * @returns a refusal per cell held elsewhere, or that cannot be checked.
 */
async function cellWarnings(
  units: readonly CellUnit[],
  deps: InspectOptions,
): Promise<string[]> {
  if (units.length === 0) return [];
  let cells: Pick<CellLocks, "inspect">;
  try {
    cells = deps.cells ?? cellLocks(cellLocksFolder(process.env), deps);
  } catch (error) {
    return [refused(failureLine(error, MAX_FAILURE))];
  }
  const warnings: string[] = [];
  for (const unit of units)
    try {
      const found = await cells.inspect(unit);
      if (found.kind === "refused") warnings.push(refused(found.message));
    } catch (error) {
      warnings.push(
        refused(
          `the site locks of cell ${unit.product} ${unit.cell} could not be checked: ${failureLine(error, MAX_FAILURE)}`,
        ),
      );
    }
  return warnings;
}

/**
 * The folder judged by the lock's own rule.
 *
 * @param stateDir - the state directory.
 * @returns its refusal, or none.
 */
async function folderWarnings(stateDir: string): Promise<string[]> {
  try {
    const check = await checkOwnFolder(stateDir, STATE_FOLDER);
    return check.kind === "ok"
      ? []
      : [refused(stateFolderProblem(stateDir, check))];
  } catch (error) {
    return [
      `the state directory ${stateDir} could not be checked (${errorCode(error) ?? failureLine(error, MAX_FAILURE)})`,
    ];
  }
}

/**
 * The lock judged as a start would judge it.
 *
 * @param stateDir - the state directory.
 * @param deps - the lock's stand-ins.
 * @returns its refusal, or none.
 */
async function lockWarnings(
  stateDir: string,
  deps: Pick<LockDeps, "pid" | "kill" | "space" | "readStart">,
): Promise<string[]> {
  try {
    const lock = await inspectLock(stateDir, deps);
    return lock.kind === "refused" ? [refused(lock.message)] : [];
  } catch (error) {
    return [
      `the state directory's lock could not be checked: ${failureLine(error, MAX_FAILURE)}`,
    ];
  }
}

/**
 * A start's refusal, as a warning.
 *
 * @param message - the refusal.
 * @returns the warning.
 */
function refused(message: string): string {
  return `a start would be refused: ${message}`;
}
