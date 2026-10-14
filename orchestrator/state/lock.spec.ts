import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { execInChildNode } from "../../src/common/__fixtures__/child-node";
import { withHandleMethod } from "../__fixtures__/file-handle";
import type { LeaderStartReader } from "../runs/leader";
import type { KillFn } from "../runs/process-group";
import { StateError } from "./errors";
import { LEFTOVER_AGE_MS } from "./leftovers";
import {
  acquireLock,
  claimPath,
  judgeOwner,
  LOCK_FILE,
  type HeldLock,
  type LockDeps,
  type LockOwner,
} from "./lock";
import { formatOwner, parseOwner } from "./lock-owner";
import { INIT_PID_NAMESPACE, readPidSpace, type PidSpace } from "./pid-space";

/** A fresh state directory per test, removed after it. */
let dir: string;
let lockPath: string;
/** Locks a test took, released after it so none outlives its test in this process. */
let taken: HeldLock[];
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "e2e-lock-"));
  lockPath = join(dir, LOCK_FILE);
  taken = [];
});
test.afterEach(async () => {
  for (const lock of taken) await lock.release();
  await chmod(dir, 0o700).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

/** A dead owner's PID, as the fake `kill`s below see it. */
const DEAD_PID = 4242;

/** The PID space every fake process below lives in: one container's. */
const SPACE: PidSpace = {
  platform: "linux",
  host: "box",
  boot: "f6fb3842-61ea-4a8e-8577-4be12500a66e",
  pidns: "pid:[4026532829]",
  machine: null,
};

/** Another container's, on the same boot. */
const OTHER_CONTAINER: PidSpace = {
  ...SPACE,
  host: "other",
  pidns: "pid:[4026532965]",
};

/** A token of `n` repeated: valid, and easy to tell apart. */
function token(n: number): string {
  return n.toString(16).padStart(32, "0");
}

/** A process's start, as the fake reader below gives it: one per PID. */
function startOf(pid: number): string {
  return `test:${String(pid)}`;
}

/** Reads each live PID's start as {@link startOf} gives it. */
const readStart: LeaderStartReader = (pid) =>
  Promise.resolve({ kind: "start", value: startOf(pid) });

/**
 * An owner in {@link SPACE}, its start the one its PID has now.
 *
 * @param pid - its PID.
 * @param n - its token's number.
 * @param changes - anything else.
 */
function owner(
  pid: number,
  n: number,
  changes: Partial<LockOwner> = {},
): LockOwner {
  return {
    pid,
    token: token(n),
    start: startOf(pid),
    space: SPACE,
    ...changes,
  };
}

/**
 * A system error with a code, as `process.kill` throws.
 *
 * @param code - its code.
 */
function systemError(code: string): Error {
  return Object.assign(new Error(`kill ${code}`), { code });
}

/**
 * A `kill` for which `dead` PIDs are gone (`ESRCH`) and every other is alive.
 *
 * @param dead - the dead PIDs.
 */
function killWithDead(...dead: number[]): KillFn {
  return (pid) => {
    if (dead.includes(pid)) throw systemError("ESRCH");
  };
}

/**
 * A fake process for {@link acquireLock}: in {@link SPACE}, `DEAD_PID` dead, every other alive.
 *
 * @param pid - its PID.
 * @param n - its token's number.
 * @param changes - anything else.
 */
function deps(pid: number, n: number, changes: LockDeps = {}): LockDeps {
  return {
    pid,
    token: () => token(n),
    kill: killWithDead(DEAD_PID),
    space: () => Promise.resolve(SPACE),
    readStart,
    ...changes,
  };
}

/**
 * Takes the lock, to be released after the test.
 *
 * @param lockDeps - the fake process.
 */
async function take(lockDeps: LockDeps): Promise<HeldLock> {
  const lock = await acquireLock(dir, lockDeps);
  taken.push(lock);
  return lock;
}

/**
 * Writes a lock file as another orchestrator would have.
 *
 * @param lockOwner - its owner.
 */
async function plantLock(lockOwner: LockOwner): Promise<void> {
  await writeFile(lockPath, formatOwner(lockOwner), { mode: 0o600 });
}

/** The lock's owner, as on disk. */
async function lockOnDisk(): Promise<LockOwner | undefined> {
  const parsed = parseOwner(await readFile(lockPath, "utf8"));
  return parsed.kind === "owner" ? parsed.owner : undefined;
}

/**
 * Why `promise` rejected.
 *
 * @param promise - a promise that must reject.
 */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  const error: unknown = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

/** How {@link judgeOwner} is called for the fake process `me`. */
function judge(
  found: LockOwner,
  me: LockOwner,
  kill: KillFn = killWithDead(DEAD_PID),
  reader = readStart,
) {
  return judgeOwner(found, { me, realLock: lockPath, kill, readStart: reader });
}

test.describe("judgeOwner", () => {
  const me = owner(77, 1);

  test("is alive when kill(pid, 0) succeeds and the PID's start is the recorded one, asking with signal 0", async () => {
    const calls: [number, NodeJS.Signals | 0][] = [];
    expect(
      await judge(owner(5, 2), me, (pid, signal) => {
        calls.push([pid, signal]);
      }),
    ).toEqual({ kind: "alive" });
    expect(calls).toEqual([[5, 0]]);
  });

  test("reads EPERM as alive: another user's process is still a process", async () => {
    expect(
      await judge(owner(5, 2), me, () => {
        throw systemError("EPERM");
      }),
    ).toEqual({ kind: "alive" });
  });

  test("reads ESRCH as dead", async () => {
    expect(await judge(owner(DEAD_PID, 2), me)).toEqual({ kind: "dead" });
  });

  test("reads a reused PID — alive, but started at another time — as dead", async () => {
    expect(await judge(owner(5, 2, { start: "test:earlier" }), me)).toEqual({
      kind: "dead",
    });
  });

  test("reads a PID gone by the time its start is read as dead", async () => {
    expect(
      await judge(owner(5, 2), me, killWithDead(), () =>
        Promise.resolve({ kind: "gone" }),
      ),
    ).toEqual({ kind: "dead" });
  });

  test("reads an alive PID as alive when either start is unknown", async () => {
    expect(await judge(owner(5, 2, { start: null }), me)).toEqual({
      kind: "alive",
    });
    expect(
      await judge(owner(5, 2), me, killWithDead(), () =>
        Promise.resolve({ kind: "unknown", why: "EACCES" }),
      ),
    ).toEqual({ kind: "alive" });
  });

  test("reads its own PID with another start as dead without asking: an earlier process of that PID left it", async () => {
    expect(
      await judge(owner(77, 2, { start: "test:earlier" }), me, () => {
        throw new Error("never asked");
      }),
    ).toEqual({ kind: "dead" });
  });

  test("reads its own PID and start as itself", async () => {
    expect(await judge(owner(77, 2), me)).toEqual({ kind: "self" });
  });

  test("reads its own PID as dead when its own start is unknown", async () => {
    expect(await judge(owner(77, 2), { ...me, start: null })).toEqual({
      kind: "dead",
    });
  });

  test("never judges a PID from another PID space: the other container's PID 1 is not this one's", async () => {
    const calls: number[] = [];
    for (const found of [
      owner(77, 2, { space: OTHER_CONTAINER }),
      owner(DEAD_PID, 2, { space: OTHER_CONTAINER }),
      owner(5, 2, {
        space: { ...SPACE, boot: "0e1d2c3b-4a59-6877-8695-a4b3c2d1e0f9" },
      }),
      owner(5, 2, { space: { ...SPACE, boot: null } }),
    ])
      expect(
        await judge(found, me, (pid) => {
          calls.push(pid);
          throw systemError("ESRCH");
        }),
      ).toEqual({ kind: "foreign" });
    expect(calls).toEqual([]);
  });

  test("reads a lock from an earlier boot of this machine as dead", async () => {
    const host: PidSpace = {
      ...SPACE,
      pidns: INIT_PID_NAMESPACE,
      machine: "0123456789abcdef0123456789abcdef",
    };
    expect(
      await judge(
        owner(5, 2, {
          space: { ...host, boot: "0e1d2c3b-4a59-6877-8695-a4b3c2d1e0f9" },
        }),
        { ...me, space: host },
      ),
    ).toEqual({ kind: "dead" });
  });

  test("passes on any other error", async () => {
    await expect(
      judge(owner(5, 2), me, () => {
        throw systemError("EINVAL");
      }),
    ).rejects.toThrow("kill EINVAL");
  });
});

test.describe("acquireLock", () => {
  test("creates the lock with this process's owner record, owner-only under umask 0, leaving nothing else", async () => {
    const previous = process.umask(0);
    try {
      const lock = await take(deps(77, 1));
      expect(lock.path).toBe(lockPath);
      expect(lock.owner).toEqual(owner(77, 1));
      expect(await readFile(lockPath, "utf8")).toBe(formatOwner(owner(77, 1)));
      expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
      expect(await readdir(dir)).toEqual([LOCK_FILE]);
      expect(lock.leftovers).toEqual({ removed: [], failed: [] });
    } finally {
      process.umask(previous);
    }
  });

  test("uses the real PID, start, PID space and a fresh random token by default", async () => {
    const first = await acquireLock(dir);
    expect(first.owner.pid).toBe(process.pid);
    expect(first.owner.token).toMatch(/^[0-9a-f]{32}$/);
    expect(first.owner.start).not.toBeNull();
    expect(first.owner.space).toEqual(await readPidSpace());
    expect(await first.release()).toBe(true);
    const second = await take({});
    expect(second.owner.token).not.toBe(first.owner.token);
  });

  test("refuses a live owner, naming its PID, its host and the lock, and leaves the lock alone", async () => {
    await plantLock(owner(500, 9));
    const error = await rejectionOf(acquireLock(dir, deps(77, 1)));
    expect(error).toBeInstanceOf(StateError);
    expect(error.message).toBe(
      `Another orchestrator (pid 500 on box) holds ${lockPath}. Stop it first; if pid 500 is no orchestrator, remove the lock: rm ${lockPath}`,
    );
    expect(await lockOnDisk()).toEqual(owner(500, 9));
  });

  test("refuses an owner kill answers EPERM for", async () => {
    await plantLock(owner(500, 9));
    await expect(
      acquireLock(dir, {
        ...deps(77, 1),
        kill: () => {
          throw systemError("EPERM");
        },
      }),
    ).rejects.toThrow(/pid 500/);
    expect((await lockOnDisk())?.token).toBe(token(9));
  });

  test("takes over a dead owner's lock, leaving no claim behind", async () => {
    await plantLock(owner(DEAD_PID, 9));
    const lock = await take(deps(77, 1));
    expect(lock.owner.token).toBe(token(1));
    expect(await lockOnDisk()).toEqual(owner(77, 1));
    expect(await readdir(dir)).toEqual([LOCK_FILE]);
  });

  test("takes over a live PID's lock when that PID's process started at another time: a reused PID", async () => {
    await plantLock(owner(500, 9, { start: "test:long-ago" }));
    expect((await take(deps(77, 1))).owner.token).toBe(token(1));
  });

  test("takes over a lock naming its own PID, left by an earlier process of that PID", async () => {
    await plantLock(owner(77, 9, { start: "test:earlier" }));
    const lock = await take(deps(77, 1));
    expect(await lockOnDisk()).toEqual(lock.owner);
  });

  test("refuses a lock from another PID space — another container's PID 1 — naming where it was written, and leaves it", async () => {
    // Both PID 1, as two containers sharing a state volume are; and in this one's namespace PID 1 is
    // this very process, so judging the PID here would take a live lock over.
    const theirs = owner(1, 9, { space: OTHER_CONTAINER });
    await plantLock(theirs);
    const error = await rejectionOf(
      acquireLock(dir, { ...deps(1, 1), kill: killWithDead(1, DEAD_PID) }),
    );
    expect(error).toBeInstanceOf(StateError);
    expect(error.message).toBe(
      `${lockPath} was written by pid 1 in another PID space (linux boot ${SPACE.boot ?? ""}, pid:[4026532965]; this process: linux boot ${SPACE.boot ?? ""}, pid:[4026532829]) — another container, host or boot, where this process cannot tell whether it still runs. If no orchestrator runs on this state directory there, remove the lock: rm ${lockPath}`,
    );
    expect(await lockOnDisk()).toEqual(theirs);
  });

  test("refuses every lock when this process's own PID space cannot be read", async () => {
    await plantLock(owner(DEAD_PID, 9));
    const unknown: PidSpace = { ...SPACE, pidns: null };
    await expect(
      acquireLock(dir, {
        ...deps(77, 1),
        space: () => Promise.resolve(unknown),
      }),
    ).rejects.toThrow(/another PID space/);
  });

  test("takes over a lock from an earlier boot of this machine", async () => {
    const host: PidSpace = {
      ...SPACE,
      pidns: INIT_PID_NAMESPACE,
      machine: "0123456789abcdef0123456789abcdef",
    };
    await plantLock(
      owner(500, 9, {
        space: { ...host, boot: "0e1d2c3b-4a59-6877-8695-a4b3c2d1e0f9" },
      }),
    );
    const lock = await take({
      ...deps(77, 1),
      space: () => Promise.resolve(host),
    });
    expect(await lockOnDisk()).toEqual(lock.owner);
  });

  test("refuses a second start in this process, even with its own PID and another token, until the first releases", async () => {
    const first = await take(deps(77, 1));
    // The fake start reader cannot tell the two starts apart; only the held lock does.
    const error = await rejectionOf(
      acquireLock(dir, {
        ...deps(77, 2),
        readStart: () => Promise.resolve({ kind: "unknown", why: "x" }),
      }),
    );
    expect(error.message).toBe(
      `This process already holds ${lockPath}: a second start in one process is refused. Release the lock it holds first.`,
    );
    expect(await lockOnDisk()).toEqual(first.owner);
    expect(await first.release()).toBe(true);
    expect((await take(deps(77, 2))).owner.token).toBe(token(2));
  });

  test("refuses a second start in this process with the real defaults", async () => {
    await take({});
    await expect(acquireLock(dir)).rejects.toThrow(
      /This process already holds/,
    );
  });

  test("refuses a lock the first orchestrators wrote, naming its PID and how to remove it", async () => {
    await writeFile(lockPath, `${String(DEAD_PID)}\n${token(9)}\n`);
    await expect(acquireLock(dir, deps(77, 1))).rejects.toThrow(
      `The orchestrator's lock ${lockPath} was written by an earlier orchestrator (pid ${String(DEAD_PID)}), without the PID space this one judges it by. If no orchestrator runs on ${dir}, remove it: rm ${lockPath}`,
    );
  });

  for (const [why, text] of [
    ["empty", ""],
    ["garbage", "not a lock"],
    ["a PID alone", `${String(DEAD_PID)}\n`],
  ] as const)
    test(`refuses a lock that is ${why}, naming the file and how to remove it, and keeps it`, async () => {
      await writeFile(lockPath, text);
      await expect(acquireLock(dir, deps(77, 1))).rejects.toThrow(
        `The orchestrator's lock ${lockPath} is not one this orchestrator wrote. If no orchestrator runs on ${dir}, remove it: rm ${lockPath}`,
      );
      expect(await readFile(lockPath, "utf8")).toBe(text);
    });

  test("refuses a symbolic link at the lock's path, even to a dead owner's lock, follows it nowhere, and says how to remove it", async () => {
    const elsewhere = join(dir, "elsewhere");
    await writeFile(elsewhere, formatOwner(owner(DEAD_PID, 9)));
    await symlink(elsewhere, lockPath);
    await expect(acquireLock(dir, deps(77, 1))).rejects.toThrow(
      `${lockPath} is a symbolic link: state files are never followed through one. If no orchestrator runs on ${dir}, remove it: rm ${lockPath}`,
    );
    expect(await readlink(lockPath)).toBe(elsewhere);
    expect(await readFile(elsewhere, "utf8")).toBe(
      formatOwner(owner(DEAD_PID, 9)),
    );
  });

  test("refuses a dangling symbolic link at the lock's path, creating nothing through it", async () => {
    await symlink(join(dir, "target"), lockPath);
    await expect(acquireLock(dir, deps(77, 1))).rejects.toThrow(
      /is a symbolic link/,
    );
    expect(await readdir(dir)).toEqual([LOCK_FILE]);
  });

  test("refuses a folder at the lock's path", async () => {
    await mkdir(lockPath);
    await expect(acquireLock(dir, deps(77, 1))).rejects.toThrow(
      /is not a regular file\. If no orchestrator runs/,
    );
  });

  test("refuses while another live start holds the claim on a stale lock, naming that start's PID and the claim", async () => {
    const stale = owner(DEAD_PID, 9);
    await plantLock(stale);
    const claim = claimPath(lockPath, stale);
    await writeFile(claim, formatOwner(owner(88, 8)));
    await expect(acquireLock(dir, deps(77, 1))).rejects.toThrow(
      `Another start (pid 88 on box) is taking over ${lockPath}. If pid 88 is no orchestrator starting, remove its claim: rm ${claim}`,
    );
    expect(await lockOnDisk()).toEqual(stale);
    expect(await readFile(claim, "utf8")).toBe(formatOwner(owner(88, 8)));
  });

  test("clears a claim a start left when it died taking over, then takes the lock", async () => {
    const stale = owner(DEAD_PID, 9);
    await plantLock(stale);
    const deadClaimant = 4343;
    await writeFile(
      claimPath(lockPath, stale),
      formatOwner(owner(deadClaimant, 8)),
    );
    const lock = await take({
      ...deps(77, 1),
      kill: killWithDead(DEAD_PID, deadClaimant),
    });
    expect(await lockOnDisk()).toEqual(lock.owner);
    expect(await readdir(dir)).toEqual([LOCK_FILE]);
  });

  test("refuses a dead start's claim while a live start is clearing it, naming the live one", async () => {
    const stale = owner(DEAD_PID, 9);
    const deadClaimant = owner(4343, 8);
    await plantLock(stale);
    await writeFile(claimPath(lockPath, stale), formatOwner(deadClaimant));
    const clearing = claimPath(lockPath, deadClaimant);
    await writeFile(clearing, formatOwner(owner(88, 7)));
    await expect(
      acquireLock(dir, { ...deps(77, 1), kill: killWithDead(DEAD_PID, 4343) }),
    ).rejects.toThrow(
      `Another start (pid 88 on box) is taking over ${lockPath}. If pid 88 is no orchestrator starting, remove its claim: rm ${clearing}`,
    );
    expect(await lockOnDisk()).toEqual(stale);
  });

  test("leaves claims to the operator once starts kept dying taking over", async () => {
    const stale = owner(DEAD_PID, 9);
    await plantLock(stale);
    // A chain of dead claimants: each died clearing the one before.
    const chain = [owner(4001, 11), owner(4002, 12), owner(4003, 13)];
    let claimed: LockOwner = stale;
    for (const claimant of chain) {
      await writeFile(claimPath(lockPath, claimed), formatOwner(claimant));
      claimed = claimant;
    }
    const last = claimPath(lockPath, chain[1] ?? stale);
    await expect(
      acquireLock(dir, {
        ...deps(77, 1),
        kill: killWithDead(DEAD_PID, 4001, 4002, 4003),
      }),
    ).rejects.toThrow(
      `Starts kept dying while taking over ${lockPath}: the last, pid 4003 on box, left ${last}. If no orchestrator is starting, remove its claim: rm ${last}`,
    );
    expect(await lockOnDisk()).toEqual(stale);
  });

  test("refuses a claim the first orchestrators wrote, saying how to remove it", async () => {
    const stale = owner(DEAD_PID, 9);
    await plantLock(stale);
    const claim = claimPath(lockPath, stale);
    await writeFile(claim, `88\n${token(8)}\n`);
    await expect(acquireLock(dir, deps(77, 1))).rejects.toThrow(
      `A claim on the orchestrator's lock ${claim} was written by an earlier orchestrator (pid 88), without the PID space this one judges it by. If no orchestrator is starting on ${dir}, remove it: rm ${claim}`,
    );
  });

  test("refuses an injected PID or token a lock cannot hold, before touching the disk", async () => {
    await expect(acquireLock(dir, { pid: 0 })).rejects.toThrow(RangeError);
    await expect(acquireLock(dir, { pid: 2 ** 31 })).rejects.toThrow(
      RangeError,
    );
    await expect(acquireLock(dir, { token: () => "short" })).rejects.toThrow(
      RangeError,
    );
    expect(await readdir(dir)).toEqual([]);
  });

  for (const code of ["ENOTSUP", "EPERM", "ENOSYS"])
    test(`says a file system whose link fails ${code} makes no hard links, removing its temporary file`, async () => {
      await expect(
        acquireLock(dir, {
          ...deps(77, 1),
          link: () => Promise.reject(systemError(code)),
        }),
      ).rejects.toThrow(
        `The state directory ${dir} cannot hold the orchestrator's lock: its file system makes no hard links (${code}). Put the state directory on a local file system that does (not FAT or exFAT).`,
      );
      expect(await readdir(dir)).toEqual([]);
    });

  test("passes on any other link failure as it is", async () => {
    const error = await rejectionOf(
      acquireLock(dir, {
        ...deps(77, 1),
        link: () => Promise.reject(systemError("EIO")),
      }),
    );
    expect(error).not.toBeInstanceOf(StateError);
    expect(error.message).toBe("kill EIO");
  });

  for (const mode of [0o777, 0o775, 0o757])
    test(`refuses a state directory of mode ${mode.toString(8)}, which others may write in, creating nothing`, async () => {
      await chmod(dir, mode);
      await expect(acquireLock(dir, deps(77, 1))).rejects.toThrow(
        `The state directory ${dir} is mode ${mode.toString(8)}: it must be this user's, and no one else may write in it (chmod go-w ${dir}).`,
      );
      expect(await readdir(dir)).toEqual([]);
    });

  test("takes a state directory others may read", async () => {
    await chmod(dir, 0o755);
    await take(deps(77, 1));
  });

  test("removes the leftovers of crashes it finds once it holds the lock, and keeps young ones", async () => {
    const tasks = join(dir, "tasks");
    await mkdir(tasks, { mode: 0o700 });
    const now = Date.now();
    const old = new Date(now - LEFTOVER_AGE_MS - 1000);
    const gone = [
      join(dir, ".orchestrator.lock.0123456789ab.tmp"),
      join(dir, `.orchestrator.lock.${token(5)}.claim`),
      join(tasks, ".bpng.json.0123456789ab.tmp"),
    ];
    for (const path of gone) {
      await writeFile(path, "x");
      await utimes(path, old, old);
    }
    const young = join(dir, ".orchestrator.lock.ba9876543210.tmp");
    await writeFile(young, "x");
    const lock = await take({ ...deps(77, 1), now: () => now });
    expect(lock.leftovers).toEqual({ removed: [...gone].sort(), failed: [] });
    expect((await readdir(dir)).sort()).toEqual(
      [LOCK_FILE, ".orchestrator.lock.ba9876543210.tmp", "tasks"].sort(),
    );
  });

  // Many starts in one process interleave finely: a smoke test of the whole, not the proof of the
  // claim — that is the deterministic race below.
  test("smoke: lets exactly one of many concurrent starts take one stale lock", async () => {
    for (let round = 0; round < 25; round += 1) {
      await plantLock(owner(DEAD_PID, 999));
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) =>
          acquireLock(dir, deps(100 + i, i + 1)),
        ),
      );
      const won = results.flatMap((r) =>
        r.status === "fulfilled" ? [r.value] : [],
      );
      const refused = results.flatMap((r): unknown[] =>
        r.status === "rejected" ? [r.reason] : [],
      );
      expect(won).toHaveLength(1);
      for (const reason of refused) expect(reason).toBeInstanceOf(StateError);
      expect(await lockOnDisk()).toEqual(won[0]?.owner);
      expect(await readdir(dir)).toEqual([LOCK_FILE]);
      expect(await won[0]?.release()).toBe(true);
    }
  });

  test("smoke: lets exactly one of many concurrent starts create a missing lock", async () => {
    for (let round = 0; round < 25; round += 1) {
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) =>
          acquireLock(dir, deps(100 + i, i + 1)),
        ),
      );
      const won = results.flatMap((r) =>
        r.status === "fulfilled" ? [r.value] : [],
      );
      expect(won).toHaveLength(1);
      expect(await won[0]?.release()).toBe(true);
    }
  });

  test("refuses a start that races a take-over parked between its re-check and its removal", async () => {
    await plantLock(owner(DEAD_PID, 9));
    let resume = (): void => undefined;
    const parked = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let reached = (): void => undefined;
    const atRecheck = new Promise<void>((resolve) => {
      reached = resolve;
    });
    // A: judges the lock dead, claims it, re-checks it — and waits there.
    const a = acquireLock(dir, {
      ...deps(100, 1),
      afterRecheck: async () => {
        reached();
        await parked;
      },
    });
    await atRecheck;
    // B: judges the same stale lock dead meanwhile. Without A's claim it would take it over, then A
    // would remove B's lock and create its own: two holders.
    const b = await rejectionOf(acquireLock(dir, deps(101, 2)));
    expect(b).toBeInstanceOf(StateError);
    expect(b.message).toMatch(
      /^Another start \(pid 100 on box\) is taking over /,
    );
    resume();
    const lock = await a;
    taken.push(lock);
    expect(await lockOnDisk()).toEqual(owner(100, 1));
    expect(await readdir(dir)).toEqual([LOCK_FILE]);
  });
});

test.describe("HeldLock.release", () => {
  test("removes its own lock once, then reports nothing to remove", async () => {
    const lock = await acquireLock(dir, deps(77, 1));
    expect(await lock.release()).toBe(true);
    expect(await readdir(dir)).toEqual([]);
    expect(await lock.release()).toBe(false);
  });

  test("never removes another holder's lock, even one of the same PID", async () => {
    const lock = await acquireLock(dir, deps(77, 1));
    const other = owner(77, 2);
    await plantLock(other);
    expect(await lock.release()).toBe(false);
    expect(await lockOnDisk()).toEqual(other);
  });

  test("never removes, nor follows, a symbolic link put in its place", async () => {
    const lock = await acquireLock(dir, deps(77, 1));
    const elsewhere = join(dir, "elsewhere");
    await writeFile(elsewhere, formatOwner(lock.owner));
    await rm(lockPath);
    await symlink(elsewhere, lockPath);
    expect(await lock.release()).toBe(false);
    expect(await readlink(lockPath)).toBe(elsewhere);
    expect(await readFile(elsewhere, "utf8")).toBe(formatOwner(lock.owner));
  });

  test("resolves false, never rejects, when its lock goes between the read and the removal", async () => {
    const lock = await acquireLock(dir, deps(77, 1));
    const released = await withHandleMethod(
      "stat",
      function (original, ...args) {
        // The lock is open for reading: removing its name now is a removal mid-release.
        unlinkSync(lockPath);
        return original(...args);
      },
      () => lock.release(),
    );
    expect(released).toBe(false);
    // No longer held: this process may take the lock again.
    await take(deps(77, 2));
  });

  test("resolves false, never rejects, when the lock cannot be removed — and still holds it", async () => {
    const lock = await acquireLock(dir, deps(77, 1));
    taken.push(lock);
    await chmod(dir, 0o500);
    expect(await lock.release()).toBe(false);
    await chmod(dir, 0o700);
    await expect(acquireLock(dir, deps(77, 2))).rejects.toThrow(
      /This process already holds/,
    );
    expect(await lock.release()).toBe(true);
  });
});

test.describe("acquireLock across processes", () => {
  /** The module, as a child imports it. */
  const LOCK_MODULE = pathToFileURL(
    fileURLToPath(new URL("./lock.ts", import.meta.url)),
  ).href;

  /**
   * A child that waits for `go`, tries the lock, writes what happened to `result-<i>`, and holds on
   * — a winner alive — until `done`.
   */
  const CHILD = `
    import { existsSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { setTimeout as sleep } from "node:timers/promises";
    const { acquireLock } = await import(process.env.LOCK_MODULE);
    const sync = process.env.SYNC_DIR;
    writeFileSync(join(sync, "ready-" + process.env.I), "");
    // Asked every millisecond: the children start within about one of each other, well inside the
    // tens of milliseconds a take-over lasts.
    while (!existsSync(join(sync, "go"))) await sleep(1);
    let result;
    try {
      const lock = await acquireLock(process.env.STATE_DIR);
      result = "won " + lock.owner.token;
    } catch (error) {
      result = "refused " + error.name;
    }
    writeFileSync(join(sync, "result-" + process.env.I), result);
    while (!existsSync(join(sync, "done"))) await sleep(10);
  `;

  // Real processes, real PIDs, real starts and PID space: a smoke test of the whole. Whether the
  // claim is what keeps it to one winner is the deterministic race above.
  test("smoke: lets exactly one of several real processes take one stale lock", async () => {
    test.setTimeout(60_000);
    const CHILDREN = 8;
    // A PID that is certainly dead: a process that has already exited.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    await plantLock({
      pid: dead,
      token: token(999),
      start: null,
      space: await readPidSpace(),
    });
    const sync = await mkdtemp(join(tmpdir(), "e2e-lock-sync-"));
    try {
      const children = Array.from({ length: CHILDREN }, (_, i) =>
        execInChildNode(CHILD, {
          cwd: dir,
          env: { LOCK_MODULE, SYNC_DIR: sync, STATE_DIR: dir, I: String(i) },
        }),
      );
      await waitForFiles(sync, "ready-", CHILDREN);
      await writeFile(join(sync, "go"), "");
      await waitForFiles(sync, "result-", CHILDREN);
      const results = await Promise.all(
        Array.from({ length: CHILDREN }, (_, i) =>
          readFile(join(sync, `result-${String(i)}`), "utf8"),
        ),
      );
      await writeFile(join(sync, "done"), "");
      await Promise.all(children);
      const won = results.filter((r) => r.startsWith("won "));
      expect(won).toHaveLength(1);
      expect(results.filter((r) => r === "refused StateError")).toHaveLength(
        CHILDREN - 1,
      );
      expect((await lockOnDisk())?.token).toBe(won[0]?.slice(4));
    } finally {
      await writeFile(join(sync, "done"), "").catch(() => undefined);
      await rm(sync, { recursive: true, force: true });
    }
  });
});

/**
 * Waits until `dir` holds `count` files named `prefix…`.
 *
 * @param folder - the folder.
 * @param prefix - their names' start.
 * @param count - how many.
 */
async function waitForFiles(
  folder: string,
  prefix: string,
  count: number,
): Promise<void> {
  while (
    (await readdir(folder)).filter((name) => name.startsWith(prefix)).length <
    count
  )
    await sleep(10);
}
