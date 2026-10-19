import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { errorCode } from "../error-code";
import {
  checkOwnFolder,
  describeFolderProblem,
  ownFolderRemedy,
  PRIVATE_FOLDER,
} from "../folders";
import { readLeaderStart } from "../runs/leader";
import { readRunRecordFile } from "../runs/record";
import { shellWord } from "../text";
import { StateError } from "./errors";
import { lockLeftoverPattern, sweepFolder } from "./leftovers";
import {
  acquireLockAt,
  inspectLockAt,
  type HeldLock,
  type LockDeps,
  type LockInspection,
  type LockPlace,
  type RunNaming,
} from "./lock";
import type { LockOwner } from "./lock-owner";
import { classifyRunning, orphanRefusal } from "./orphans";
import { siteKey } from "../config/site-key";

export { siteKey } from "../config/site-key";

/**
 * The locks that keep a cell's **sites** to one orchestrator at a time — every orchestrator of this
 * user on this machine, whatever its config, state directory or checkout. A run binds to its cell's
 * sites, so a lock is a site's, not a cell name's: two cells naming one site exclude each other, and
 * one name reused for other sites does not. A site is keyed by its `baseURL`'s host, port (none for
 * 80 or 443) and path, normalised ({@link siteKey}); its lock is named after the key's hash and holds
 * the key, the cell holding it and its latest run. Two tasks of one config on one site are refused by
 * the config's check before either runs; a lock this process already holds is a backstop.
 *
 * A task's loop takes its cell's sites' locks as it starts — every one, in the keys' order, or none —
 * names each run in them before it is launched, and gives them back as it ends: two orchestrators
 * never take turns on a site, through each other's cooldowns. They are kept when a run's processes
 * may still live. Each is the state directory's lock in another place (`lock.ts`: written whole,
 * judged in its PID space, a dead holder's taken over under a claim, never through a link), with one
 * rule more: a dead holder's lock is taken over only once the run it names is over, missing, or stale
 * as the orphan check judges — so a run an orchestrator killed by SIGKILL left behind keeps its sites
 * from every other orchestrator, until it is ended as the refusal says.
 *
 * The locks live in `$XDG_STATE_HOME/wp-media-e2e/site-locks/` (`~/.local/state/…` without it):
 * `wp-media-e2e` and `site-locks` are made `0700` and judged ({@link PRIVATE_FOLDER}), any missing
 * folder above them made with the default mode. **Limits:** they are this user's — another user's
 * orchestrator, another machine's, or a run started by hand (`npm run test:backwpup`) takes no lock and
 * is not seen; nor is an orchestrator of this user run with another `XDG_STATE_HOME` or `HOME`; and one
 * site reached by two addresses — a host and its IP, two names for one server, a path differing only in
 * case — is two sites to them.
 */

/** The folder under the state home that holds every site's lock. */
export const SITE_LOCKS_PATH = join("wp-media-e2e", "site-locks");

/** A cell, as its locks name it: its product, its name, and its sites' `baseURL`s. */
export interface CellUnit {
  readonly product: string;
  readonly cell: string;
  readonly sites: readonly string[];
}

/**
 * A selected task's cell as its locks name it.
 *
 * @param checked - the task, its cell and its sites, as the config's check gives them.
 * @returns the unit: the task's product and cell, its sites' `baseURL`s.
 */
export function unitOf(checked: {
  readonly task: { readonly product: string; readonly cell: string };
  readonly cell: { readonly sites: readonly { readonly baseURL: string }[] };
}): CellUnit {
  return {
    product: checked.task.product,
    cell: checked.task.cell,
    sites: checked.cell.sites.map(({ baseURL }) => baseURL),
  };
}

/** A cell's sites' locks, held together. */
export interface HeldCell {
  /** Each site's lock, in the keys' order. */
  readonly locks: readonly HeldLock[];
  /**
   * Names a run in every lock, before it is launched.
   *
   * @param run - the run's `run.json`, absolute.
   * @returns `named` once every lock names it; else the first lock's `lost` or `failed`.
   */
  setRun(run: string): Promise<RunNaming>;
  /**
   * Gives every lock back. Never rejects.
   *
   * @returns whether each was removed.
   */
  release(): Promise<boolean>;
}

/** Every site's lock, in one folder: what a loop takes and a start or a dry run judges. */
export interface CellLocks {
  /** The folder they are in. */
  readonly folder: string;
  /**
   * Takes every one of a cell's sites' locks, in the keys' order, or none: one refused gives back
   * those already taken. Makes the locks' folders when missing.
   *
   * @param unit - the cell and its sites.
   * @param run - a run to name in them; none until the first run.
   * @returns the locks held.
   * @throws {@link StateError} naming the site, its holder and the way out when another orchestrator
   *   holds one — or another task of this one —, or its dead holder's run may still run; or naming a
   *   folder that is not this user's alone.
   * @throws {@link RangeError} for a site whose `baseURL` is no http(s) URL, or whose key a lock cannot
   *   hold (over 2,048 characters).
   */
  acquire(unit: CellUnit, run?: string): Promise<HeldCell>;
  /**
   * Judges a cell's sites' locks as {@link CellLocks.acquire} would, writing nothing — no folder made either.
   *
   * @param unit - the cell and its sites.
   * @returns `free` when every one may be taken; otherwise the first refusal, in the keys' order.
   */
  inspect(unit: CellUnit): Promise<LockInspection>;
}

/**
 * The site locks' folder for an environment: `$XDG_STATE_HOME/wp-media-e2e/site-locks`, else
 * `$HOME/.local/state/wp-media-e2e/site-locks` — a relative `XDG_STATE_HOME` is ignored, as the XDG
 * base directory specification says.
 *
 * @param env - the orchestrator's environment.
 * @returns the folder, absolute.
 * @throws {@link StateError} when neither variable is an absolute path.
 */
export function cellLocksFolder(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const { XDG_STATE_HOME: stateHome, HOME: home } = env;
  if (stateHome !== undefined && isAbsolute(stateHome))
    return join(stateHome, SITE_LOCKS_PATH);
  if (home !== undefined && isAbsolute(home))
    return join(home, ".local", "state", SITE_LOCKS_PATH);
  throw new StateError(
    "The site locks have no folder: neither XDG_STATE_HOME nor HOME is an absolute path in the orchestrator's environment. Set HOME.",
  );
}

/**
 * A site's lock file: named after its key's SHA-256, so any key is a safe file name.
 *
 * @param folder - the site locks' folder.
 * @param key - the site's key ({@link siteKey}).
 * @returns `<folder>/<32 hex>.lock`.
 */
export function siteLockPath(folder: string, key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return join(folder, `${hash}.lock`);
}

/**
 * The keys of a cell's sites, each once, sorted: the order every lock is taken in, so two takers never
 * hold one each of two sites while waiting for the other's.
 *
 * @param unit - the cell.
 * @returns the keys.
 */
export function siteKeys(unit: Pick<CellUnit, "sites">): string[] {
  return [...new Set(unit.sites.map(siteKey))].sort();
}

/**
 * Every site's lock in `folder`.
 *
 * @param folder - the site locks' folder ({@link cellLocksFolder}), absolute.
 * @param deps - the lock's stand-ins; its `kill` and `readStart` also judge a dead holder's run.
 * @returns the locks.
 * @throws {@link RangeError} for a relative folder.
 */
export function cellLocks(folder: string, deps: LockDeps = {}): CellLocks {
  if (!isAbsolute(folder))
    throw new RangeError("The site locks' folder must be absolute.");
  return {
    folder,
    acquire: (unit, run) => acquireAll(folder, unit, deps, run),
    inspect: async (unit) => {
      const keys = siteKeys(unit);
      const problem = await folderProblem(folder, false);
      if (problem === "missing") return { kind: "free" };
      if (problem !== undefined) return { kind: "refused", message: problem };
      for (const key of keys) {
        const found = await inspectLockAt(
          sitePlace(folder, key, unit, deps),
          deps,
        );
        if (found.kind === "refused") return found;
      }
      return { kind: "free" };
    },
  };
}

/**
 * Takes every site's lock in the keys' order; on a refusal, gives back what was taken, then throws it.
 *
 * @param folder - the site locks' folder.
 * @param unit - the cell.
 * @param deps - the lock's stand-ins.
 * @param run - the run to name, if any.
 * @returns the locks held.
 * @throws as {@link CellLocks.acquire} does.
 */
async function acquireAll(
  folder: string,
  unit: CellUnit,
  deps: LockDeps,
  run: string | undefined,
): Promise<HeldCell> {
  const keys = siteKeys(unit);
  const locks: HeldLock[] = [];
  try {
    for (const key of keys)
      locks.push(
        await acquireLockAt(sitePlace(folder, key, unit, deps, run), deps),
      );
  } catch (error) {
    for (const lock of locks.reverse()) await lock.release();
    throw error;
  }
  return heldCell(locks);
}

/**
 * Locks held together.
 *
 * @param locks - the locks, in the keys' order.
 * @returns them, renamed or released as one.
 */
function heldCell(locks: readonly HeldLock[]): HeldCell {
  return {
    locks,
    setRun: async (run) => {
      let first: RunNaming = { kind: "named" };
      for (const lock of locks) {
        const naming = await lock.setRun(run);
        if (first.kind === "named") first = naming;
      }
      return first;
    },
    release: async () => {
      // Every lock released, whatever one before it answered.
      const released: boolean[] = [];
      for (const lock of [...locks].reverse())
        released.push(await lock.release());
      return released.every(Boolean);
    },
  };
}

/**
 * A site's lock as a {@link LockPlace}.
 *
 * @param folder - the site locks' folder.
 * @param key - the site's key.
 * @param unit - the cell taking it, named in it.
 * @param deps - how a dead holder's run is judged.
 * @param run - the run to name in it, if any.
 * @returns the place.
 */
function sitePlace(
  folder: string,
  key: string,
  unit: CellUnit,
  deps: LockDeps,
  run?: string,
): LockPlace {
  const path = siteLockPath(folder, key);
  const site = `site ${key}`;
  const leftover = lockLeftoverPattern(basename(path));
  return {
    path,
    checkFolder: async () => {
      const problem = await folderProblem(folder, true);
      if (problem !== undefined) throw new StateError(problem);
    },
    what: `The lock of ${site}`,
    claimWhat: `A claim on the lock of ${site}`,
    runs: `runs on ${site}`,
    starting: `starting a run on ${site}`,
    runsThere: `on ${site}`,
    folderNoun: "the site locks' folder",
    holding: (owner) => ` — running ${heldBy(owner)} on ${site}${runOf(owner)}`,
    heldBySelf: (owner) =>
      `This orchestrator already holds ${path} for another of its tasks — running ${heldBy(owner)} on ${site}: two of its tasks on one site are refused.`,
    sweep: (now) => sweepFolder(folder, (file) => leftover.test(file), now),
    deadHolder: (owner) => deadHolderRefusal(path, site, owner, deps),
    label: `${unit.product} ${unit.cell}`,
    // In the file too: its name is only the key's hash.
    key,
    ...(run === undefined ? {} : { run }),
  };
}

/**
 * What a holder runs on a site, in words: its label, else `a cell`.
 *
 * @param owner - the holder.
 * @returns `backwpup pro@nginx`.
 */
function heldBy(owner: LockOwner): string {
  return owner.label ?? "a cell";
}

/**
 * Judges the site locks' folder and its parent `wp-media-e2e` — each made first when asked, `0700`, any
 * folder above with the default mode — by {@link PRIVATE_FOLDER}: the parent first, so nothing is made or
 * read through a link in its place, and since whoever may write in it may rename `site-locks` away and
 * put another in its place, letting two orchestrators on one site. The state home and above are the
 * operator's, never judged.
 *
 * @param folder - the site locks' folder.
 * @param make - whether a missing one is made.
 * @returns `undefined` when both pass; `missing` when one is not there and not made; else the refusal.
 * @throws what `mkdir` and `lstat` throw besides `ENOENT` and `EEXIST`.
 */
async function folderProblem(
  folder: string,
  make: boolean,
): Promise<string | undefined> {
  // The state home and above: made only when missing, with the default mode.
  if (make) await mkdir(dirname(dirname(folder)), { recursive: true });
  const ours = [
    { path: dirname(folder), noun: "The site locks' parent folder" },
    { path: folder, noun: "The site locks' folder" },
  ];
  for (const { path, noun } of ours) {
    if (make)
      await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
        if (errorCode(error) !== "EEXIST") throw error;
      });
    const problem = await privateFolderProblem(path, noun);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/**
 * Judges one of the site locks' folders by {@link PRIVATE_FOLDER}.
 *
 * @param path - the folder.
 * @param noun - what it is, opening the refusal: `The site locks' folder`.
 * @returns `undefined` when it passes; `missing` when it is not there; else the refusal and its remedy.
 * @throws what `lstat` throws besides `ENOENT`.
 */
async function privateFolderProblem(
  path: string,
  noun: string,
): Promise<string | undefined> {
  let check;
  try {
    check = await checkOwnFolder(path, PRIVATE_FOLDER);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "missing";
    throw error;
  }
  if (check.kind === "ok") return undefined;
  if (check.kind === "notFolder")
    return `${noun} ${path} is not a folder (a symbolic link is never followed). Move it away: mv ${shellWord(path)} ${shellWord(`${path}.moved`)}`;
  return `${noun} ${path} ${describeFolderProblem(check)}: it must be this user's alone (${ownFolderRemedy(path, check, PRIVATE_FOLDER)}).`;
}

/**
 * `, run bpng-3 (<its record>)` for a holder that names its run; `""` otherwise.
 *
 * @param owner - the holder.
 * @returns the words.
 */
function runOf(owner: LockOwner): string {
  return owner.run === undefined
    ? ""
    : `, run ${basename(dirname(owner.run))} (${owner.run})`;
}

/**
 * Whether a dead holder's run keeps its site: its record read where the lock says, never through a
 * link. Over, missing, or found stale as the orphan check finds one, it does not; still running, or
 * its record unreadable, it does — a refusal can be retried, a site run twice cannot be undone.
 *
 * @param path - the lock.
 * @param site - the site, in words.
 * @param owner - the dead holder.
 * @param deps - `kill`, the start reader and this process's PID space.
 * @returns the refusal, or `undefined` to take the lock over.
 */
async function deadHolderRefusal(
  path: string,
  site: string,
  owner: LockOwner,
  deps: LockDeps,
): Promise<string | undefined> {
  const { run } = owner;
  if (run === undefined) return undefined;
  const dead = `The lock of ${site} (${path}) was left by an orchestrator that has ended (pid ${String(owner.pid)}), running ${heldBy(owner)}`;
  const read = await readRunRecordFile(run, basename(dirname(run)));
  switch (read.kind) {
    case "missing":
    case "over":
      return undefined;
    case "running": {
      const verdict = await classifyRunning(read.record, {
        kill: deps.kill ?? ((target, signal) => process.kill(target, signal)),
        readLeaderStart: deps.readStart ?? readLeaderStart,
        ...(deps.space === undefined ? {} : { space: deps.space }),
      });
      if (verdict.kind === "stale") return undefined;
      const refusal = orphanRefusal({
        taskId: read.record.taskId,
        id: read.record.id,
        ...(verdict.pgid === undefined ? {} : { pgid: verdict.pgid }),
        record: run,
        confirmed: verdict.confirmed,
        ...(verdict.confirmed ? {} : { why: verdict.why }),
      });
      return `${dead}, and its run may still run. ${refusal}`;
    }
    default: {
      const why =
        read.kind === "malformed"
          ? read.why
          : read.kind === "tooLarge"
            ? "too large"
            : `unreadable, ${read.code}`;
      return `${dead}, and the record of its run, ${run}, cannot be read (${why}): its run may still run. If it does not, remove the lock: rm ${shellWord(path)}`;
    }
  }
}
