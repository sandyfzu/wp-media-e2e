import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, open, realpath, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { errorCode } from "../error-code";
import {
  checkOwnFolder,
  describeFolderProblem,
  ownFolderRemedy,
  STATE_FOLDER,
  type OwnFolderCheck,
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
  MAX_OWNER_BYTES,
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
 * cell's sites. The same lock, in another place ({@link LockPlace}), keeps each cell to one run across
 * orchestrators (`cell-lock.ts`). The lock holds its owner's PID, that process's start, the PID space the PID means
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

/** A lock's size: no owner {@link isWritableOwner} accepts is larger. */
const MAX_LOCK_BYTES = MAX_OWNER_BYTES;

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
  /** Its owner, as last written. */
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
  /**
   * Names another run in the lock — a site's lock, held for a task's whole loop, names each of its
   * runs in turn. The lock is rewritten whole (a temporary file renamed over it), its token unchanged,
   * and only while it is still this holder's. Never rejects.
   *
   * @param run - the run's `run.json`, absolute.
   * @returns `named` once written; `lost` when the lock is gone or another's; `failed`, and why, when
   *   it is still this holder's but could not be rewritten — a path no lock can hold, or the file
   *   system's refusal (`ENOSPC`, `EACCES`).
   */
  setRun(run: string): Promise<RunNaming>;
}

/** What naming a run in a lock came to. */
export type RunNaming =
  | { readonly kind: "named" }
  /** The lock is gone, or another's: this holder no longer holds it. */
  | { readonly kind: "lost" }
  /** Still this holder's, but not rewritten: why, in words. */
  | { readonly kind: "failed"; readonly why: string };

/**
 * One lock: where it is, how its folder is judged, how its messages name it, what is swept as it is
 * taken, and what keeps a dead holder's lock from being taken over. The state directory's
 * ({@link acquireLock}) and each cell's (`cell-lock.ts`) are two places of one lock.
 */
export interface LockPlace {
  /** The lock file, absolute when its folder is. */
  readonly path: string;
  /**
   * Checks the lock's folder before anything is written there.
   *
   * @throws {@link StateError} naming the folder and its repair when it may not hold the lock.
   */
  readonly checkFolder: () => Promise<void>;
  /** The lock in messages: `"The orchestrator's lock"`. */
  readonly what: string;
  /** A claim on it in messages: `"A claim on the orchestrator's lock"`. */
  readonly claimWhat: string;
  /** What runs while it is held, after "If no orchestrator": `runs on /srv/state`. */
  readonly runs: string;
  /** What a start taking it does, after "is another orchestrator": `starting on /srv/state`. */
  readonly starting: string;
  /** What runs there in another PID space, after "If no orchestrator runs": `on this state directory`. */
  readonly runsThere: string;
  /** The lock's folder in messages: `the state directory`. */
  readonly folderNoun: string;
  /**
   * Said of a live holder, after its PID: `` — running backwpup pro@nginx (run bpng-3)``; `""` for none.
   *
   * @param owner - the holder.
   */
  readonly holding: (owner: LockOwner) => string;
  /**
   * Removes what a crash leaves, once the lock is taken. Never rejects.
   *
   * @param now - the time, in milliseconds.
   */
  readonly sweep: (now: number) => Promise<LeftoverSweep>;
  /**
   * Judges a dead holder's work before its lock is taken over: a refusal when it may still run.
   *
   * @param owner - the dead holder.
   * @returns the refusal, or `undefined` to take the lock over.
   */
  readonly deadHolder?: (owner: LockOwner) => Promise<string | undefined>;
  /** Recorded in the owner: the run this lock is taken for (a site's). */
  readonly run?: string;
  /** Recorded in the owner: what its holder runs there, in words (a site's: `backwpup pro@nginx`). */
  readonly label?: string;
  /** Recorded in the owner: which site the lock is (a site's key, its file being named by a hash). */
  readonly key?: string;
  /**
   * The refusal of a lock this very process holds, when it means more than "a second start": a site
   * one of its other tasks holds.
   *
   * @param owner - the holder, this process.
   * @returns the sentence; the generic one when absent.
   */
  readonly heldBySelf?: (owner: LockOwner) => string;
}

/** One acquisition's view: who takes the lock, and how it judges and writes. */
interface Taker {
  readonly place: LockPlace;
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
  return acquireLockAt(statePlace(stateDir), deps);
}

/**
 * The state directory's lock as a {@link LockPlace}: its folder judged by `STATE_FOLDER`, its crash
 * leftovers — and the counters' — swept as it is taken.
 *
 * @param stateDir - the state directory.
 * @returns the place.
 */
export function statePlace(stateDir: string): LockPlace {
  return {
    path: join(stateDir, LOCK_FILE),
    checkFolder: async () => {
      const check = await checkOwnFolder(stateDir, STATE_FOLDER);
      if (check.kind !== "ok")
        throw new StateError(stateFolderProblem(stateDir, check));
    },
    what: LOCK_WHAT,
    claimWhat: CLAIM_WHAT,
    runs: `runs on ${stateDir}`,
    starting: `starting on ${stateDir}`,
    runsThere: "on this state directory",
    folderNoun: "the state directory",
    holding: () => "",
    sweep: (now) => sweepLeftovers(stateDir, now),
  };
}

/**
 * Takes a lock — any {@link LockPlace}'s — then sweeps its place's leftovers.
 *
 * @param place - the lock.
 * @param deps - stand-ins for the process and the system, for the specs.
 * @returns the lock held.
 * @throws as {@link acquireLock} does, and the place's `deadHolder` refusal as a {@link StateError}.
 */
export async function acquireLockAt(
  place: LockPlace,
  deps: LockDeps = {},
): Promise<HeldLock> {
  const taker = await takerOf(place, deps);
  const lockPath = place.path;
  const key = heldKey(taker.realLock, taker.me.token);
  // Only an injected token can be in use already: refused, since dropping it on failure below would
  // take it from the start that holds it.
  if (OURS.has(key)) throw lockRefusal(place, taker.me, taker.me, "self");
  OURS.add(key);
  try {
    const leftovers = await takeLock(taker, deps.now ?? Date.now);
    return held(lockPath, taker, leftovers);
  } catch (error) {
    // Not taken: no lock holds the token, and every claim under it is dropped as it is left.
    OURS.delete(key);
    throw error;
  }
}

/**
 * Creates the lock — removing a dead owner's first, unless the place's `deadHolder` refuses — then
 * sweeps the leftovers. The taker's token is in {@link OURS} throughout.
 *
 * @param taker - who takes it, and where.
 * @param now - the time, for the leftovers' age.
 * @returns what the sweep did.
 * @throws as {@link acquireLockAt} does.
 */
async function takeLock(
  taker: Taker,
  now: () => number,
): Promise<LeftoverSweep> {
  const { lockPath, place } = taker;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (
      await createExclusive(place, lockPath, formatOwner(taker.me), taker.link)
    )
      return place.sweep(now());
    const found = await readOwnerFile(
      lockPath,
      place.what,
      lockRemedy(place, lockPath),
    );
    // Released between the two looks: try again.
    if (found === undefined) continue;
    const verdict = await judgeOwner(found, taker);
    if (verdict.kind !== "dead")
      throw lockRefusal(place, found, taker.me, verdict.kind);
    const refusal = await place.deadHolder?.(found);
    if (refusal !== undefined) throw new StateError(refusal);
    await removeDeadOwnerFile(lockPath, place.what, found, taker, 0);
  }
  throw new StateError(
    `${lockPath} kept changing while this start tried to take it: is another orchestrator ${place.starting}?`,
  );
}

/**
 * Who takes the lock: checks its folder, reads this process's PID space and start, and checks what was
 * injected.
 *
 * @param place - the lock.
 * @param deps - the stand-ins.
 * @returns the taker.
 * @throws {@link StateError} for a folder the place refuses.
 * @throws {@link RangeError} for an injected PID or token a lock cannot hold, or an owner it cannot
 *   read back — a start or PID space unlike the system's, a run, cell or site key too long or not one
 *   line.
 */
async function takerOf(place: LockPlace, deps: LockDeps): Promise<Taker> {
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
  await place.checkFolder();
  const me = {
    ...(await ownerOf(pid, token, readStart, deps)),
    ...(place.run === undefined ? {} : { run: place.run }),
    ...(place.label === undefined ? {} : { label: place.label }),
    ...(place.key === undefined ? {} : { key: place.key }),
  };
  if (!isWritableOwner(me))
    throw new RangeError(
      "This process's start, PID space, run, cell or site key cannot be written in a lock.",
    );
  return {
    place,
    lockPath: place.path,
    me,
    realLock: await realLockOf(place.path),
    kill: deps.kill ?? ((target, signal) => process.kill(target, signal)),
    readStart,
    link: deps.link ?? link,
    afterRecheck: deps.afterRecheck,
  };
}

/**
 * This process as a lock's owner: its PID, the token, its start and its PID space.
 *
 * @param pid - its PID.
 * @param token - the token.
 * @param readStart - the start reader.
 * @param deps - the PID space's reader.
 * @returns the owner; its start `null` when it cannot be read.
 */
async function ownerOf(
  pid: number,
  token: string,
  readStart: LeaderStartReader,
  deps: Pick<LockDeps, "space">,
): Promise<LockOwner> {
  const [space, start] = await Promise.all([
    (deps.space ?? readPidSpace)(),
    readStart(pid),
  ]);
  return {
    pid,
    token,
    start: start.kind === "start" ? start.value : null,
    space,
  };
}

/**
 * Why a start refuses a state directory {@link checkOwnFolder} did not pass, and its repair — the
 * sentence {@link acquireLock} throws, and `--dry-run` warns with.
 *
 * @param stateDir - the state directory.
 * @param check - what was wrong with it.
 * @returns the sentence.
 */
export function stateFolderProblem(
  stateDir: string,
  check: Exclude<OwnFolderCheck, { kind: "ok" }>,
): string {
  return `The state directory ${stateDir} ${describeFolderProblem(check)}: it must be this user's, and no one else may write in it${check.kind === "notFolder" ? "" : ` (${ownFolderRemedy(stateDir, check, STATE_FOLDER)})`}.`;
}

/** The lock as a start would find it, judged without taking it. */
export type LockInspection =
  /** No lock: a start takes it. */
  | { readonly kind: "free" }
  /** A lock whose owner has ended: a start takes it over. */
  | { readonly kind: "dead"; readonly owner: LockOwner }
  /** A lock a start refuses — a live owner's, another PID space's, unreadable: the refusal. */
  | { readonly kind: "refused"; readonly message: string };

/**
 * Judges the state directory's lock as {@link acquireLock} would, writing nothing: no lock, no claim,
 * no take-over, no sweep. For `--dry-run`, which runs beside an orchestrator that may hold it.
 *
 * @param stateDir - the state directory.
 * @param deps - this process's PID, `kill`, start reader and PID space; the real ones by default.
 * @returns what a start would find.
 * @throws what `kill` throws besides `ESRCH` and `EPERM`, or the file system resolving the folder.
 */
export async function inspectLock(
  stateDir: string,
  deps: Pick<LockDeps, "pid" | "kill" | "space" | "readStart"> = {},
): Promise<LockInspection> {
  return inspectLockAt(statePlace(stateDir), deps);
}

/**
 * Judges any {@link LockPlace}'s lock as {@link acquireLockAt} would, writing nothing — a dead
 * holder's work judged by the place's `deadHolder` too. Its folder is not checked: see
 * {@link inspectLock}.
 *
 * @param place - the lock.
 * @param deps - this process's PID, `kill`, start reader and PID space; the real ones by default.
 * @returns what a start would find.
 * @throws as {@link inspectLock} does.
 */
export async function inspectLockAt(
  place: LockPlace,
  deps: Pick<LockDeps, "pid" | "kill" | "space" | "readStart"> = {},
): Promise<LockInspection> {
  const lockPath = place.path;
  let found: LockOwner | undefined;
  try {
    found = await readOwnerFile(
      lockPath,
      place.what,
      lockRemedy(place, lockPath),
    );
  } catch (error) {
    if (error instanceof StateError)
      return { kind: "refused", message: error.message };
    throw error;
  }
  if (found === undefined) return { kind: "free" };
  const readStart = deps.readStart ?? readLeaderStart;
  const me = await ownerOf(
    deps.pid ?? process.pid,
    newToken(),
    readStart,
    deps,
  );
  const verdict = await judgeOwner(found, {
    me,
    realLock: await realLockOf(lockPath),
    kill: deps.kill ?? ((target, signal) => process.kill(target, signal)),
    readStart,
  });
  if (verdict.kind !== "dead")
    return {
      kind: "refused",
      message: lockRefusal(place, found, me, verdict.kind).message,
    };
  const refusal = await place.deadHolder?.(found);
  return refusal === undefined
    ? { kind: "dead", owner: found }
    : { kind: "refused", message: refusal };
}

/**
 * A lock's real path — its folder's, resolved — which keys {@link OURS}.
 *
 * @param lockPath - the lock.
 * @returns the real path.
 * @throws what `realpath` throws for its folder.
 */
async function realLockOf(lockPath: string): Promise<string> {
  return join(await realpath(dirname(lockPath)), basename(lockPath));
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
  const { place } = taker;
  const claim = claimPath(taker.lockPath, dead);
  if (
    !(await createExclusive(place, claim, formatOwner(taker.me), taker.link))
  ) {
    const claimant = await readOwnerFile(
      claim,
      place.claimWhat,
      claimRemedy(place, claim),
    );
    // Dropped since: the caller looks again.
    if (claimant === undefined) return;
    const verdict = await judgeOwner(claimant, taker);
    if (verdict.kind !== "dead" || depth + 1 >= MAX_CLAIM_DEPTH)
      throw claimRefusal(taker, claim, claimant, verdict.kind);
    await removeDeadOwnerFile(
      claim,
      place.claimWhat,
      claimant,
      taker,
      depth + 1,
    );
    return;
  }
  try {
    const current = await readOwnerFile(file, what, lockRemedy(place, file));
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
 * @returns `.<lock's name>.<token>.claim` in the lock's folder.
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
 * @param place - the lock.
 * @param path - the file.
 * @returns the sentence.
 */
function lockRemedy(place: LockPlace, path: string): string {
  return `If no orchestrator ${place.runs}, remove it: rm ${shellWord(path)}`;
}

/**
 * What to do about a claim this code refuses.
 *
 * @param place - the lock claimed.
 * @param claim - the claim.
 * @returns the sentence.
 */
function claimRemedy(place: LockPlace, claim: string): string {
  return `If no orchestrator is ${place.starting}, remove it: rm ${shellWord(claim)}`;
}

/**
 * The refusal of a lock whose owner is not dead.
 *
 * @param place - the lock.
 * @param owner - its owner.
 * @param me - who wanted it.
 * @param kind - how its owner was judged.
 * @returns the refusal.
 */
function lockRefusal(
  place: LockPlace,
  owner: LockOwner,
  me: LockOwner,
  kind: Exclude<OwnerVerdict["kind"], "dead">,
): StateError {
  const { path } = place;
  const pid = String(owner.pid);
  switch (kind) {
    case "self":
      return new StateError(
        place.heldBySelf?.(owner) ??
          `This process already holds ${path}: a second start in one process is refused. Release the lock it holds first.`,
      );
    case "foreign":
      return new StateError(
        `${path} was written by pid ${pid} in another PID space (${describeSpace(owner.space)}; this process: ${describeSpace(me.space)}) — another container, host or boot, where this process cannot tell whether it still runs.${containerHint(owner.space, me.space)} If no orchestrator runs ${place.runsThere} there, remove the lock: rm ${shellWord(path)}`,
      );
    case "alive":
      return new StateError(
        `Another orchestrator (pid ${pid}${onHost(owner)}${place.holding(owner)}) holds ${path}. Stop it first; if pid ${pid} is no orchestrator, remove the lock: rm ${shellWord(path)}`,
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
 * @returns the refusal, saying when it is safe to remove the claim, and how.
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
 * @returns the phrase, or `""`.
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
 * @param place - the lock, for the refusal.
 * @param path - the file to create.
 * @param text - its content.
 * @param makeLink - `link`.
 * @returns `true` when created, `false` when `path` was taken.
 * @throws {@link StateError} when the file system makes no hard links.
 * @throws what the file system throws besides `EEXIST` at `path`.
 */
async function createExclusive(
  place: LockPlace,
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
          `${upperFirst(place.folderNoun)} ${dirname(path)} cannot hold ${lowerFirst(place.what)}: its file system makes no hard links (${code}). Put ${place.folderNoun} on a local file system that does (not FAT or exFAT).`,
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
 * @returns the held lock; its `release` resolves `false` when the lock was no longer this holder's
 *   or could not be removed, never rejecting.
 */
function held(path: string, taker: Taker, leftovers: LeftoverSweep): HeldLock {
  const { me: owner } = taker;
  const key = heldKey(taker.realLock, owner.token);
  const state = { owner };
  return {
    path,
    get owner() {
      return state.owner;
    },
    leftovers,
    setRun: async (run): Promise<RunNaming> => {
      const next = { ...state.owner, run };
      if (!isWritableOwner(next))
        return {
          kind: "failed",
          why: "its record's path is not one a lock can hold (too long, or a control character)",
        };
      let current: LockOwner | undefined;
      try {
        current = await readOwnerFile(path, taker.place.what, "");
      } catch (error) {
        // Something else stands in the lock's place: not this holder's any more.
        if (error instanceof StateError) return { kind: "lost" };
        return { kind: "failed", why: errorCode(error) ?? "unknown error" };
      }
      if (current?.token !== owner.token) return { kind: "lost" };
      try {
        await replaceLockFile(path, formatOwner(next));
      } catch (error) {
        return { kind: "failed", why: errorCode(error) ?? "unknown error" };
      }
      state.owner = next;
      return { kind: "named" };
    },
    release: async () => {
      try {
        const current = await readOwnerFile(path, taker.place.what, "").catch(
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
 * Replaces a lock this process holds with `text`, whole: written to a new temporary file beside it
 * (exclusive, never through a link), on disk, then renamed over it — a reader sees the old or the new
 * text, never a part. Exported for its spec.
 *
 * @param path - the lock.
 * @param text - its new content.
 * @throws what the file system throws; the temporary file is removed then.
 */
export async function replaceLockFile(
  path: string,
  text: string,
): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`,
  );
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
      await handle.datasync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * {@link OURS}'s key.
 *
 * @param realLock - the lock's real path.
 * @param token - the holder's token.
 * @returns the two, a newline apart.
 */
function heldKey(realLock: string, token: string): string {
  return `${realLock}\n${token}`;
}

/**
 * A message's subject used mid-sentence: its first letter lowercase.
 *
 * @param text - the subject: `"The orchestrator's lock"`.
 * @returns `"the orchestrator's lock"`.
 */
function lowerFirst(text: string): string {
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

/**
 * A message's subject opening a sentence: its first letter uppercase.
 *
 * @param text - the subject: `"the state directory"`.
 * @returns `"The state directory"`.
 */
function upperFirst(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * A fresh token: 16 random bytes, in hex.
 *
 * @returns 32 lowercase hex digits.
 */
function newToken(): string {
  return randomBytes(16).toString("hex");
}
