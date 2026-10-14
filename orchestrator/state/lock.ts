import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, open, rm, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { errorCode } from "../error-code";
import type { KillFn } from "../runs/process-group";
import { shellWord } from "../text";
import { StateError } from "./errors";
import { readStateFile } from "./read";

/**
 * `orchestrator.lock`: one orchestrator per state directory, since two would start two runs on one
 * cell's sites. The lock holds its owner's PID and a random token, and appears whole or not at all —
 * written to a temporary file, then hard-linked into place, which fails when anything (a lock, a
 * link, a folder) is already there.
 *
 * A live owner refuses the start; `EPERM` from `kill(pid, 0)` is a live process too. A dead owner's
 * lock is taken over, race-free: the taker first creates a **claim** named after the stale lock's
 * token — exclusively, so of every start racing over that one stale lock only one gets it — then
 * checks the lock still holds that token, and only then replaces it. A lock that cannot be read as
 * one is refused, never taken over: it may be a live owner's that this code cannot read.
 *
 * The PID is not paired with its process's start time: a PID reused by another process reads as a
 * live owner, which refuses a start that could have gone on — never lets two run — and the message
 * names the PID and the file to remove. The one reuse that would refuse every start is handled: a
 * lock naming this very process's PID (a container restarting its orchestrator as PID 1 again).
 */

/** The lock's name in the state directory. */
export const LOCK_FILE = "orchestrator.lock";

/** The lock's mode: the owner's alone, like every state file. */
export const LOCK_MODE = 0o600;

/** A lock's size: a PID, a token and two newlines fit well under this. */
const MAX_LOCK_BYTES = 128;

/** The largest PID `process.kill` takes: a signed 32-bit integer. */
const MAX_PID = 2 ** 31 - 1;

/** How often a lock that vanished between two looks is tried again before giving up. */
const MAX_ATTEMPTS = 5;

/** A lock's text: `<pid>\n<token>\n`, the token 32 lowercase hex digits. */
const LOCK_TEXT = /^([1-9][0-9]{0,9})\n([0-9a-f]{32})\n$/;

/** Who holds a lock. */
export interface LockOwner {
  readonly pid: number;
  /** Tells this holder's lock from any other's, a reused PID's included. */
  readonly token: string;
}

/** What {@link acquireLock} is given instead of the real process, for the specs. */
export interface LockDeps {
  /** This process's PID; `process.pid` by default. */
  readonly pid?: number;
  /** `process.kill` by default. */
  readonly kill?: KillFn;
  /** A fresh token; 16 random bytes in hex by default. */
  readonly token?: () => string;
}

/** A lock held. */
export interface HeldLock {
  /** The lock file, absolute when the state directory was. */
  readonly path: string;
  readonly owner: LockOwner;
  /**
   * Removes the lock if it is still this holder's — by its token, never by its PID.
   *
   * @returns whether it was removed: `false` once released, or when it is gone or another's.
   */
  release(): Promise<boolean>;
}

/**
 * A lock's text.
 *
 * @param owner - its owner.
 * @returns `<pid>\n<token>\n`: the PID first, so `head -1` reads it.
 */
export function formatLock(owner: LockOwner): string {
  return `${String(owner.pid)}\n${owner.token}\n`;
}

/**
 * Reads a lock's text.
 *
 * @param text - the lock file's content.
 * @returns its owner, or `undefined` when it is not exactly what {@link formatLock} writes.
 */
export function parseLock(text: string): LockOwner | undefined {
  const match = LOCK_TEXT.exec(text);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const pid = Number(match[1]);
  return pid <= MAX_PID ? { pid, token: match[2] } : undefined;
}

/**
 * Whether a lock's owner is alive. `kill(pid, 0)` succeeds or fails with `EPERM` (another user's
 * process, still a process): alive. `ESRCH`: dead. A lock naming this process's own PID was left by
 * an earlier process of that PID — this one takes its lock once — so it is dead too.
 *
 * @param pid - the lock's PID.
 * @param ownPid - this process's PID.
 * @param kill - `process.kill`, or a stand-in.
 * @returns whether the owner is alive.
 * @throws what `kill` throws besides `ESRCH` and `EPERM`.
 */
export function ownerAlive(pid: number, ownPid: number, kill: KillFn): boolean {
  if (pid === ownPid) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

/**
 * Takes the state directory's lock.
 *
 * @param stateDir - the state directory; it must exist.
 * @param deps - this process's PID, `kill` and token source, for the specs.
 * @returns the lock held.
 * @throws {@link StateError} naming the lock when another live orchestrator holds it, when it is not
 *   a regular file or not a lock's text, when another start is taking it over, or when it keeps
 *   changing under this one.
 * @throws {@link RangeError} for an injected PID or token a lock cannot hold.
 * @throws what the file system throws creating it.
 *
 * @example
 * ```ts
 * const lock = await acquireLock(stateDir);
 * try { await runEverything(); } finally { await lock.release(); }
 * ```
 */
export async function acquireLock(
  stateDir: string,
  deps: LockDeps = {},
): Promise<HeldLock> {
  const path = join(stateDir, LOCK_FILE);
  const ownPid = deps.pid ?? process.pid;
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const me: LockOwner = {
    pid: ownPid,
    token: (deps.token ?? newToken)(),
  };
  if (parseLock(formatLock(me)) === undefined)
    throw new RangeError(
      "A lock's PID must be a process's and its token 32 lowercase hex digits.",
    );
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (await createExclusive(path, formatLock(me))) return held(path, me);
    const found = await readLock(path);
    // Released between the two looks: try again.
    if (found === undefined) continue;
    if (ownerAlive(found.pid, ownPid, kill))
      throw new StateError(
        `Another orchestrator (pid ${String(found.pid)}) holds ${path}. Stop it first; if pid ${String(found.pid)} is no orchestrator, remove the lock: rm ${shellWord(path)}`,
      );
    if (await takeOverStaleLock(path, found, me)) return held(path, me);
  }
  throw new StateError(
    `${path} kept changing while this start tried to take it: is another orchestrator starting on ${stateDir}?`,
  );
}

/**
 * Replaces a dead owner's lock with `me`'s — or, when another start got there first, nothing. Under
 * the claim on `stale`'s token, no other start can remove that lock; checking it still holds the
 * token closes the gap between judging it stale and claiming it, in which another start may have
 * taken it over and dropped its claim.
 *
 * @param path - the lock.
 * @param stale - the dead owner, as read.
 * @param me - who takes it.
 * @returns `true` when `me` holds the lock; `false` when it changed, so the caller judges it again.
 * @throws {@link StateError} naming the claim when another start holds it — or held it and died, the
 *   one case left to the operator.
 */
export async function takeOverStaleLock(
  path: string,
  stale: LockOwner,
  me: LockOwner,
): Promise<boolean> {
  const claim = claimPath(path, stale);
  if (!(await createExclusive(claim, formatLock(me))))
    throw new StateError(
      `Another start is taking over ${path}, left by pid ${String(stale.pid)}. If no orchestrator is starting, remove its claim: rm ${shellWord(claim)}`,
    );
  try {
    const current = await readLock(path);
    if (current?.token !== stale.token) return false;
    await unlink(path);
    // A start that found no lock at all may have created one since: it wins, and this one re-judges.
    return await createExclusive(path, formatLock(me));
  } finally {
    await rm(claim, { force: true });
  }
}

/**
 * The claim on a stale lock: a hidden file beside it, named after its token.
 *
 * @param path - the lock.
 * @param stale - its dead owner.
 */
export function claimPath(path: string, stale: LockOwner): string {
  return join(dirname(path), `.${basename(path)}.${stale.token}.claim`);
}

/**
 * Reads the lock.
 *
 * @param path - the lock.
 * @returns its owner, or `undefined` when there is no lock.
 * @throws {@link StateError} when it is not a regular file or not a lock's text — refused rather than
 *   taken over, since a lock that cannot be read cannot be judged dead.
 */
async function readLock(path: string): Promise<LockOwner | undefined> {
  const text = await readStateFile(
    path,
    "The orchestrator's lock",
    MAX_LOCK_BYTES,
  );
  if (text === undefined) return undefined;
  const owner = parseLock(text);
  if (owner === undefined)
    throw new StateError(
      `The orchestrator's lock ${path} is not a lock this orchestrator wrote. If no orchestrator is running on this state directory, remove it: rm ${shellWord(path)}`,
    );
  return owner;
}

/**
 * Creates `path` holding `text`, whole, unless something is already there: the text goes to a new
 * temporary file first, which is then hard-linked to `path` — `link` never replaces, nor follows a
 * link at `path`.
 *
 * @param path - the file to create.
 * @param text - its content.
 * @returns `true` when created, `false` when `path` was taken.
 * @throws what the file system throws besides `EEXIST` at `path`.
 */
async function createExclusive(path: string, text: string): Promise<boolean> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  // Opened before the `try`, so a name already taken is never removed as if it were ours.
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    LOCK_MODE,
  );
  try {
    try {
      await handle.writeFile(text);
      // On disk before it is visible: a crash then never leaves an empty lock that refuses every start.
      await handle.datasync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, path);
      return true;
    } catch (error) {
      if (errorCode(error) === "EEXIST") return false;
      throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * The lock, held.
 *
 * @param path - the lock.
 * @param owner - its holder.
 */
function held(path: string, owner: LockOwner): HeldLock {
  return {
    path,
    owner,
    release: async () => {
      let current: LockOwner | undefined;
      try {
        current = await readLock(path);
      } catch {
        // Not a lock any more, so not this holder's.
        return false;
      }
      if (current?.token !== owner.token) return false;
      // While this process lives no other start takes its lock over, so it is still ours here.
      await unlink(path);
      return true;
    },
  };
}

/** A fresh token: 16 random bytes, in hex. */
function newToken(): string {
  return randomBytes(16).toString("hex");
}
