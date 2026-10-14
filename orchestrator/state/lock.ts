import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, open, realpath, rm, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { errorCode } from "../error-code";
import {
  checkOwnFolder,
  describeFolderProblem,
  ownFolderRemedy,
  STATE_FOLDER,
} from "../folders";
import { readLeaderStart, type LeaderStartReader } from "../runs/leader";
import type { KillFn } from "../runs/process-group";
import { shellWord } from "../text";
import { StateError } from "./errors";
import { sweepLeftovers, type LeftoverSweep } from "./leftovers";
import {
  formatOwner,
  isWritableOwner,
  LOCK_FILE,
  MAX_PID,
  parseOwner,
  TOKEN_TEXT,
  type LockOwner,
} from "./lock-owner";
import {
  describeSpace,
  earlierBoot,
  readPidSpace,
  sameSpace,
  type PidSpace,
} from "./pid-space";
import { readStateFile } from "./read";

export { LOCK_FILE, type LockOwner } from "./lock-owner";

/**
 * `orchestrator.lock`: one orchestrator per state directory, since two would start two runs on one
 * cell's sites. The lock holds its owner's PID, that process's start, the PID space the PID means
 * something in (`pid-space.ts`) and a random token, and appears whole or not at all — written to a
 * temporary file, then hard-linked into place, which fails when anything (a lock, a link, a folder)
 * is already there.
 *
 * An owner is judged only from its own PID space: a lock from another container, host or boot is
 * refused, naming where it was written — this process cannot see that PID — except one from an
 * earlier boot of this very machine, whose processes all ended with it. In its space, an owner is
 * dead when `kill(pid, 0)` says no such process, or that PID's process started at another time than
 * the lock says (a reused PID); `EPERM` is a live process. A lock naming this process's own PID was
 * left by an earlier process of that PID — unless this process holds it or is taking it, which its
 * token tells whatever this process's start, and a second start in one process is refused for.
 *
 * A dead owner's file is removed, race-free, under a **claim** named after its token: created
 * exclusively, so of every start racing over that one file only one gets it, which then checks the
 * file still holds that token, removes it, and drops the claim. The lock is then created as if there
 * had been none. A claim's holder is recorded in it, so a claim left by a start that died taking over
 * is itself a dead owner's file, removed the same way under a claim named after that start's token.
 * A lock or claim that cannot be read as one is refused, never removed: it may be a live owner's that
 * this code cannot read.
 */

/** The lock's mode: the owner's alone, like every state file. */
export const LOCK_MODE = 0o600;

/** A lock's size: an owner record with the longest host name fits well under this. */
const MAX_LOCK_BYTES = 1024;

/** How often the lock is looked at again — after it vanished or a dead owner's file went. */
const MAX_ATTEMPTS = 8;

/** How many dead claimants deep a take-over goes before it leaves the claim to the operator. */
const MAX_CLAIM_DEPTH = 3;

/** `link`'s codes for a file system that makes no hard links: macOS's FAT (`ENOTSUP`), Linux's vfat (`EPERM`) — both measured — and a FUSE file system without the call (`ENOSYS`). */
const NO_HARD_LINKS = new Set(["ENOTSUP", "EOPNOTSUPP", "EPERM", "ENOSYS"]);

/**
 * The locks this process holds or is taking, by real lock path and token — a lock or claim holding
 * one is this process's own, judged `self` whatever its start, so a second start in it is refused. An
 * acquisition's token is entered before anything is written under it: between linking the lock and
 * returning there are awaits in which another start in this process may read that lock, and judging
 * it by PID and start would read it as an earlier process's when this one's start is unknown.
 */
const OURS = new Set<string>();

/** How an owner is judged. */
export type OwnerVerdict =
  | { readonly kind: "alive" }
  | { readonly kind: "dead" }
  /** Written in another PID space, where this process cannot judge its PID. */
  | { readonly kind: "foreign" }
  /** This very process. */
  | { readonly kind: "self" };

/** What {@link acquireLock} is given instead of the real process, for the specs. */
export interface LockDeps {
  /** This process's PID; `process.pid` by default. */
  readonly pid?: number;
  /** `process.kill` by default. */
  readonly kill?: KillFn;
  /** A fresh token; 16 random bytes in hex by default. */
  readonly token?: () => string;
  /** This process's PID space; {@link readPidSpace} by default. */
  readonly space?: () => Promise<PidSpace>;
  /** A process's start; `readLeaderStart` by default. */
  readonly readStart?: LeaderStartReader;
  /** `link` from `node:fs/promises` by default. */
  readonly link?: (existing: string, path: string) => Promise<void>;
  /** The time, for the leftovers' age; `Date.now` by default. */
  readonly now?: () => number;
  /**
   * Called holding a claim, after the file it removes was checked to still be the dead owner's and
   * before it goes: a spec parks a take-over here to race another against it.
   */
  readonly afterRecheck?: (file: string) => Promise<void>;
}

/** A lock held. */
export interface HeldLock {
  /** The lock file, absolute when the state directory was. */
  readonly path: string;
  readonly owner: LockOwner;
  /** The crash leftovers removed as the lock was taken, and those that could not be. */
  readonly leftovers: LeftoverSweep;
  /**
   * Removes the lock if it is still this holder's — by its token, never by its PID. Never rejects:
   * it runs as the process ends.
   *
   * @returns whether it was removed: `false` once released, when it is gone or another's, or when it
   *   could not be removed.
   */
  release(): Promise<boolean>;
}

/** One acquisition's view: who takes the lock, and how it judges and writes. */
interface Taker {
  readonly lockPath: string;
  readonly me: LockOwner;
  /** The real lock path, which keys {@link OURS}. */
  readonly realLock: string;
  readonly kill: KillFn;
  readonly readStart: LeaderStartReader;
  readonly link: (existing: string, path: string) => Promise<void>;
  readonly afterRecheck: ((file: string) => Promise<void>) | undefined;
}

/**
 * Takes the state directory's lock, then removes the crash leftovers it finds.
 *
 * @param stateDir - the state directory; it must exist, be this user's, and be writable by no one
 *   else.
 * @param deps - stand-ins for the process and the system, for the specs.
 * @returns the lock held.
 * @throws {@link StateError} naming the lock — and what to do — when another live orchestrator holds
 *   it, when it was written in another PID space, when this process holds it already, when it or a
 *   claim on it is not a regular file or not what this code writes, when another start is taking it
 *   over, when it keeps changing; and naming the state directory when it is not this user's, others
 *   may write in it, or its file system makes no hard links.
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
  const lockPath = join(stateDir, LOCK_FILE);
  const taker = await takerOf(stateDir, lockPath, deps);
  const key = heldKey(taker.realLock, taker.me.token);
  // Only an injected token can be in use already: refused, since dropping it on failure below would
  // take it from the start that holds it.
  if (OURS.has(key)) throw lockRefusal(lockPath, taker.me, taker.me, "self");
  OURS.add(key);
  try {
    const leftovers = await takeLock(stateDir, taker, deps.now ?? Date.now);
    return held(lockPath, taker, leftovers);
  } catch (error) {
    // Not taken: no lock holds the token, and every claim under it is dropped as it is left.
    OURS.delete(key);
    throw error;
  }
}

/**
 * Creates the lock — removing a dead owner's first — then sweeps the leftovers. The taker's token is
 * in {@link OURS} throughout.
 *
 * @param stateDir - the state directory.
 * @param taker - who takes it.
 * @param now - the time, for the leftovers' age.
 * @returns what the sweep did.
 * @throws as {@link acquireLock} does.
 */
async function takeLock(
  stateDir: string,
  taker: Taker,
  now: () => number,
): Promise<LeftoverSweep> {
  const { lockPath } = taker;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (await createExclusive(lockPath, formatOwner(taker.me), taker.link))
      return sweepLeftovers(stateDir, now());
    const found = await readOwnerFile(
      lockPath,
      LOCK_WHAT,
      lockRemedy(lockPath),
    );
    // Released between the two looks: try again.
    if (found === undefined) continue;
    const verdict = await judgeOwner(found, taker);
    if (verdict.kind !== "dead")
      throw lockRefusal(lockPath, found, taker.me, verdict.kind);
    await removeDeadOwnerFile(lockPath, LOCK_WHAT, found, taker, 0);
  }
  throw new StateError(
    `${lockPath} kept changing while this start tried to take it: is another orchestrator starting on ${stateDir}?`,
  );
}

/**
 * Who takes the lock: checks the state directory, reads this process's PID space and start, and
 * checks what was injected.
 *
 * @param stateDir - the state directory.
 * @param lockPath - the lock in it.
 * @param deps - the stand-ins.
 * @throws {@link StateError} for a state directory that is not this user's, or that others may write.
 * @throws {@link RangeError} for an injected PID or token a lock cannot hold.
 */
async function takerOf(
  stateDir: string,
  lockPath: string,
  deps: LockDeps,
): Promise<Taker> {
  const pid = deps.pid ?? process.pid;
  const readStart = deps.readStart ?? readLeaderStart;
  const token = (deps.token ?? newToken)();
  // Checked before anything runs: a PID `readStart` refuses must still be this error.
  if (
    !Number.isInteger(pid) ||
    pid < 1 ||
    pid > MAX_PID ||
    !TOKEN_TEXT.test(token)
  )
    throw new RangeError(
      "A lock's PID must be a process's and its token 32 lowercase hex digits.",
    );
  const check = await checkOwnFolder(stateDir, STATE_FOLDER);
  if (check.kind !== "ok")
    throw new StateError(
      `The state directory ${stateDir} ${describeFolderProblem(check)}: it must be this user's, and no one else may write in it${check.kind === "notFolder" ? "" : ` (${ownFolderRemedy(stateDir, check, STATE_FOLDER)})`}.`,
    );
  const [space, start] = await Promise.all([
    (deps.space ?? readPidSpace)(),
    readStart(pid),
  ]);
  const me: LockOwner = {
    pid,
    token,
    start: start.kind === "start" ? start.value : null,
    space,
  };
  if (!isWritableOwner(me))
    throw new RangeError(
      "This process's start or PID space cannot be written.",
    );
  return {
    lockPath,
    me,
    realLock: join(await realpath(stateDir), LOCK_FILE),
    kill: deps.kill ?? ((target, signal) => process.kill(target, signal)),
    readStart,
    link: deps.link ?? link,
    afterRecheck: deps.afterRecheck,
  };
}

/**
 * Judges the owner of the lock, or of a claim on it, from the taker's PID space.
 *
 * @param owner - the owner, as read.
 * @param taker - who judges: its PID, start and space, `kill` and start reader.
 * @returns `self` for this process's own: a token it holds or is taking the lock with, or its own
 *   PID and known start. From another space, `foreign` — `dead` when it is an
 *   earlier boot of this machine. In this space, `dead` when no process has that PID or it started
 *   at another time than recorded; `alive` otherwise, a start that cannot be read included.
 * @throws what `kill` throws besides `ESRCH` and `EPERM`.
 */
export async function judgeOwner(
  owner: LockOwner,
  taker: Pick<Taker, "me" | "realLock" | "kill" | "readStart">,
): Promise<OwnerVerdict> {
  const { me } = taker;
  if (OURS.has(heldKey(taker.realLock, owner.token))) return { kind: "self" };
  if (!sameSpace(owner.space, me.space))
    return earlierBoot(owner.space, me.space)
      ? { kind: "dead" }
      : { kind: "foreign" };
  if (owner.pid === me.pid)
    // This PID is this process: the same start is this process's own lock, another an earlier one's.
    return me.start !== null && owner.start === me.start
      ? { kind: "self" }
      : { kind: "dead" };
  try {
    taker.kill(owner.pid, 0);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return { kind: "dead" };
    if (code !== "EPERM") throw error;
  }
  if (owner.start === null) return { kind: "alive" };
  const now = await taker.readStart(owner.pid);
  if (now.kind === "gone") return { kind: "dead" };
  return now.kind === "start" && now.value !== owner.start
    ? { kind: "dead" }
    : { kind: "alive" };
}

/**
 * Removes `file` — the lock, or a claim — that a dead owner wrote, under the claim named after that
 * owner's token. Under it no other start removes that file, and checking the file still holds the
 * token closes the gap between judging it and claiming it, in which another start may have removed
 * it and something else taken its place. When the claim is held already, its holder is judged: a
 * dead one's claim is removed the same way, one level up.
 *
 * @param file - the file.
 * @param what - what it is, for the messages.
 * @param dead - its owner, judged dead.
 * @param taker - who removes it.
 * @param depth - how many dead claimants deep this is.
 * @throws {@link StateError} naming the claim when a live start holds it, one in another PID space
 *   does, or dead ones left more than {@link MAX_CLAIM_DEPTH} levels of claims.
 */
async function removeDeadOwnerFile(
  file: string,
  what: string,
  dead: LockOwner,
  taker: Taker,
  depth: number,
): Promise<void> {
  const claim = claimPath(taker.lockPath, dead);
  if (!(await createExclusive(claim, formatOwner(taker.me), taker.link))) {
    const claimant = await readOwnerFile(claim, CLAIM_WHAT, claimRemedy(claim));
    // Dropped since: the caller looks again.
    if (claimant === undefined) return;
    const verdict = await judgeOwner(claimant, taker);
    if (verdict.kind !== "dead" || depth + 1 >= MAX_CLAIM_DEPTH)
      throw claimRefusal(taker, claim, claimant, verdict.kind);
    await removeDeadOwnerFile(claim, CLAIM_WHAT, claimant, taker, depth + 1);
    return;
  }
  try {
    const current = await readOwnerFile(file, what, lockRemedy(file));
    if (current?.token !== dead.token) return;
    await taker.afterRecheck?.(file);
    await unlink(file).catch((error: unknown) => {
      // Removed by hand meanwhile: what was wanted.
      if (errorCode(error) !== "ENOENT") throw error;
    });
  } finally {
    await rm(claim, { force: true });
  }
}

/**
 * The claim on a dead owner's file: a hidden file beside the lock, named after the owner's token.
 *
 * @param lockPath - the lock.
 * @param owner - the dead owner.
 */
export function claimPath(
  lockPath: string,
  owner: Pick<LockOwner, "token">,
): string {
  return join(dirname(lockPath), `.${basename(lockPath)}.${owner.token}.claim`);
}

/** What the lock is called in messages. */
const LOCK_WHAT = "The orchestrator's lock";

/** What a claim is called in messages. */
const CLAIM_WHAT = "A claim on the orchestrator's lock";

/**
 * What to do about a lock, or a file in its place, this code refuses.
 *
 * @param path - the file.
 */
function lockRemedy(path: string): string {
  return `If no orchestrator runs on ${dirname(path)}, remove it: rm ${shellWord(path)}`;
}

/**
 * What to do about a claim this code refuses.
 *
 * @param claim - the claim.
 */
function claimRemedy(claim: string): string {
  return `If no orchestrator is starting on ${dirname(claim)}, remove it: rm ${shellWord(claim)}`;
}

/**
 * The refusal of a lock whose owner is not dead.
 *
 * @param path - the lock.
 * @param owner - its owner.
 * @param me - who wanted it.
 * @param kind - how its owner was judged.
 */
function lockRefusal(
  path: string,
  owner: LockOwner,
  me: LockOwner,
  kind: Exclude<OwnerVerdict["kind"], "dead">,
): StateError {
  const pid = String(owner.pid);
  switch (kind) {
    case "self":
      return new StateError(
        `This process already holds ${path}: a second start in one process is refused. Release the lock it holds first.`,
      );
    case "foreign":
      return new StateError(
        `${path} was written by pid ${pid} in another PID space (${describeSpace(owner.space)}; this process: ${describeSpace(me.space)}) — another container, host or boot, where this process cannot tell whether it still runs.${containerHint(owner.space, me.space)} If no orchestrator runs on this state directory there, remove the lock: rm ${shellWord(path)}`,
      );
    case "alive":
      return new StateError(
        `Another orchestrator (pid ${pid}${onHost(owner)}) holds ${path}. Stop it first; if pid ${pid} is no orchestrator, remove the lock: rm ${shellWord(path)}`,
      );
  }
}

/**
 * The refusal of a claim another start holds, or left.
 *
 * @param taker - who wanted it.
 * @param claim - the claim.
 * @param claimant - its holder.
 * @param kind - how the holder was judged; `dead` only past {@link MAX_CLAIM_DEPTH}.
 */
function claimRefusal(
  taker: Taker,
  claim: string,
  claimant: LockOwner,
  kind: OwnerVerdict["kind"],
): StateError {
  const pid = String(claimant.pid);
  const remove = `remove its claim: rm ${shellWord(claim)}`;
  switch (kind) {
    case "dead":
      return new StateError(
        `Starts kept dying while taking over ${taker.lockPath}: the last, pid ${pid}${onHost(claimant)}, left ${claim}. If no orchestrator is starting, ${remove}`,
      );
    case "foreign":
      return new StateError(
        `A start in another PID space (pid ${pid}, ${describeSpace(claimant.space)}) is taking over ${taker.lockPath}, or died doing so. If no orchestrator is starting there, ${remove}`,
      );
    case "self":
      return new StateError(
        `This process is already taking over ${taker.lockPath} (its claim ${claim}): a second start in one process is refused.`,
      );
    case "alive":
      return new StateError(
        `Another start (pid ${pid}${onHost(claimant)}) is taking over ${taker.lockPath}. If pid ${pid} is no orchestrator starting, ${remove}`,
      );
  }
}

/**
 * What avoids a refusal between two PID namespaces of one boot — most often this orchestrator's own
 * container, restarted after a crash into a new namespace, its lock left behind.
 *
 * @param theirs - the space the lock was written in.
 * @param mine - this process's.
 * @returns a sentence to end the refusal with, or `""` when the spaces are not one boot's.
 */
function containerHint(theirs: PidSpace, mine: PidSpace): string {
  const oneBoot =
    theirs.platform === "linux" &&
    mine.platform === "linux" &&
    theirs.boot !== null &&
    theirs.boot === mine.boot;
  return oneBoot
    ? " A container restarts into a new PID namespace, so its own lock reads as another's: running the orchestrator on the host, or its container with --pid=host, keeps one namespace across restarts."
    : "";
}

/**
 * `, on <host>` when the owner's host is known.
 *
 * @param owner - the owner.
 */
function onHost(owner: LockOwner): string {
  return owner.space.host === null ? "" : ` on ${owner.space.host}`;
}

/**
 * Reads the lock or a claim.
 *
 * @param path - the file.
 * @param what - what it is, for the messages.
 * @param remedy - what to do about one that is refused.
 * @returns its owner, or `undefined` when there is none.
 * @throws {@link StateError} when it is not a regular file or not what this code writes — refused
 *   rather than removed, since a file that cannot be read cannot be judged dead.
 */
async function readOwnerFile(
  path: string,
  what: string,
  remedy: string,
): Promise<LockOwner | undefined> {
  const text = await readStateFile(path, MAX_LOCK_BYTES, { what, remedy });
  if (text === undefined) return undefined;
  const parsed = parseOwner(text);
  switch (parsed.kind) {
    case "owner":
      return parsed.owner;
    case "legacy":
      throw new StateError(
        `${what} ${path} was written by an earlier orchestrator (pid ${String(parsed.pid)}), without the PID space this one judges it by. ${remedy}`,
      );
    case "invalid":
      throw new StateError(
        `${what} ${path} is not one this orchestrator wrote. ${remedy}`,
      );
  }
}

/**
 * Creates `path` holding `text`, whole, unless something is already there: the text goes to a new
 * temporary file first, which is then hard-linked to `path` — `link` never replaces, nor follows a
 * link at `path`.
 *
 * @param path - the file to create.
 * @param text - its content.
 * @param makeLink - `link`.
 * @returns `true` when created, `false` when `path` was taken.
 * @throws {@link StateError} when the file system makes no hard links.
 * @throws what the file system throws besides `EEXIST` at `path`.
 */
async function createExclusive(
  path: string,
  text: string,
  makeLink: (existing: string, path: string) => Promise<void>,
): Promise<boolean> {
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
      await makeLink(temporary, path);
      return true;
    } catch (error) {
      const code = errorCode(error);
      if (code === "EEXIST") return false;
      if (code !== undefined && NO_HARD_LINKS.has(code))
        throw new StateError(
          `The state directory ${dirname(path)} cannot hold the orchestrator's lock: its file system makes no hard links (${code}). Put the state directory on a local file system that does (not FAT or exFAT).`,
        );
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
 * @param taker - its holder.
 * @param leftovers - what the sweep did.
 */
function held(path: string, taker: Taker, leftovers: LeftoverSweep): HeldLock {
  const { me: owner } = taker;
  const key = heldKey(taker.realLock, owner.token);
  return {
    path,
    owner,
    leftovers,
    release: async () => {
      try {
        const current = await readOwnerFile(path, LOCK_WHAT, "").catch(
          // Not a lock any more, so not this holder's.
          () => undefined,
        );
        if (current?.token !== owner.token) {
          OURS.delete(key);
          return false;
        }
        // While this process lives no other start takes its lock over, so it is still ours here.
        await unlink(path);
        OURS.delete(key);
        return true;
      } catch (error) {
        // Gone meanwhile: no longer held. Any other failure leaves it held, and this process's own.
        if (errorCode(error) === "ENOENT") OURS.delete(key);
        return false;
      }
    },
  };
}

/**
 * {@link OURS}'s key.
 *
 * @param realLock - the lock's real path.
 * @param token - the holder's token.
 */
function heldKey(realLock: string, token: string): string {
  return `${realLock}\n${token}`;
}

/** A fresh token: 16 random bytes, in hex. */
function newToken(): string {
  return randomBytes(16).toString("hex");
}
