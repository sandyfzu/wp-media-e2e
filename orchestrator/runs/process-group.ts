import { errorCode } from "../error-code";

/**
 * A run's process group: whether anything in it is still alive, and waiting until nothing is. A run
 * has ended only when its group is empty — the runner exits while its workers still tear down, and
 * they still touch the site. `kill` is injected, so the specs judge every answer it can give.
 */

/** `process.kill`'s shape: a signal, or `0` to ask whether a process (or, negative, a group) exists. */
export type KillFn = (pid: number, signal: NodeJS.Signals | 0) => void;

/** Waits `ms` milliseconds. */
export type SleepFn = (ms: number) => Promise<void>;

/** How often an emptying group is asked again, in milliseconds. */
export const GROUP_POLL_MS = 250;

/**
 * Whether a process group still has a member: `kill(-pgid, 0)` succeeds, or fails with `EPERM` —
 * a member we may not signal is still a member. Only `ESRCH` means it is empty.
 *
 * @param pgid - the group's id: its leader's PID, a positive whole number.
 * @param kill - `process.kill`, or a stand-in.
 * @returns whether it has a member.
 * @throws {@link RangeError} for an id that is not a positive whole number — `kill(-0, 0)` would ask
 *   about the orchestrator's own group, and `kill(-1, 0)` about every process it may signal.
 * @throws what `kill` throws besides `ESRCH` and `EPERM`.
 */
export function groupAlive(pgid: number, kill: KillFn): boolean {
  return probeGroup(pgid, kill) !== "empty";
}

/**
 * What `kill(-pgid, 0)` says of a group: `members` when it succeeds — a member at least is this
 * user's to signal —, `unsignallable` on `EPERM` — members, none of them this user's to signal —,
 * `empty` on `ESRCH`.
 *
 * @param pgid - the group's id: a whole number above 1.
 * @param kill - `process.kill`, or a stand-in.
 * @returns what it says.
 * @throws {@link RangeError} for an id that is not a whole number above 1.
 * @throws what `kill` throws besides `ESRCH` and `EPERM`.
 */
export function probeGroup(
  pgid: number,
  kill: KillFn,
): "members" | "unsignallable" | "empty" {
  assertGroupId(pgid);
  try {
    kill(-pgid, 0);
    return "members";
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return "empty";
    if (code === "EPERM") return "unsignallable";
    throw error;
  }
}

/**
 * Sends a signal to every member of a group. A group already empty is no error: the signal had
 * nothing left to reach.
 *
 * @param pgid - the group's id.
 * @param signal - the signal.
 * @param kill - `process.kill`, or a stand-in.
 * @returns whether the group had a member to signal.
 * @throws {@link RangeError} for an id that is not a positive whole number.
 * @throws what `kill` throws besides `ESRCH`.
 */
export function signalGroup(
  pgid: number,
  signal: NodeJS.Signals,
  kill: KillFn,
): boolean {
  assertGroupId(pgid);
  try {
    kill(-pgid, signal);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    throw error;
  }
}

/** How {@link waitForEmptyGroup} waits. */
export interface WaitForEmptyGroupOptions {
  readonly kill: KillFn;
  readonly sleep: SleepFn;
  /** Between two asks; {@link GROUP_POLL_MS} by default. */
  readonly pollMs?: number;
  /** How long to wait at most; for ever by default. */
  readonly timeoutMs?: number;
}

/**
 * Waits until a group is empty, asking every `pollMs`.
 *
 * @param pgid - the group's id.
 * @param options - `kill`, `sleep`, and how often and how long to ask.
 * @returns `true` once it is empty, `false` when `timeoutMs` passed first.
 */
export async function waitForEmptyGroup(
  pgid: number,
  options: WaitForEmptyGroupOptions,
): Promise<boolean> {
  const pollMs = options.pollMs ?? GROUP_POLL_MS;
  let waited = 0;
  while (groupAlive(pgid, options.kill)) {
    if (options.timeoutMs !== undefined && waited >= options.timeoutMs)
      return false;
    await options.sleep(pollMs);
    waited += pollMs;
  }
  return true;
}

/**
 * Refuses a group id that would reach more than one run's group.
 *
 * @param pgid - the id.
 * @throws {@link RangeError} unless it is a whole number above 1.
 */
function assertGroupId(pgid: number): void {
  if (!Number.isSafeInteger(pgid) || pgid < 2)
    throw new RangeError(
      `A run's process group id must be a whole number above 1, got ${String(pgid)}.`,
    );
}
