import { errorCode } from "../error-code";
import { checkOwnFolder, STATE_FOLDER } from "../folders";
import { failureLine } from "../text";
import { inspectLock, stateFolderProblem, type LockDeps } from "./lock";

/**
 * The state directory as a start would find it, judged without writing anything — for `--dry-run`,
 * which may run beside an orchestrator holding it: the folder by the lock's own rule
 * (`checkOwnFolder` with `STATE_FOLDER`), then the lock by the lock's own judgement (`inspectLock`).
 */

/** The longest failure a warning quotes, in code points. */
const MAX_FAILURE = 1_000;

/**
 * What would stop a start on `stateDir`, each as a warning naming its repair: a folder others may
 * write in or that is not this user's, a lock a live orchestrator holds, one from another PID space,
 * one that cannot be read. A dead orchestrator's lock is no warning: a start takes it over. The lock
 * is judged only once the folder passes, as a start judges it.
 *
 * @param stateDir - the state directory (the config's folder).
 * @param deps - the lock's stand-ins: this process's PID, `kill`, start reader and PID space.
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
  deps: Pick<LockDeps, "pid" | "kill" | "space" | "readStart"> = {},
): Promise<string[]> {
  // A start refuses the folder before it reads the lock: so is the lock judged only in a sound one.
  const folder = await folderWarnings(stateDir);
  return folder.length > 0 ? folder : lockWarnings(stateDir, deps);
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
