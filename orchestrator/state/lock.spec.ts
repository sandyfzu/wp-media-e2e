import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { execInChildNode } from "../../src/common/__fixtures__/child-node";
import type { KillFn } from "../runs/process-group";
import { StateError } from "./errors";
import {
  acquireLock,
  claimPath,
  formatLock,
  LOCK_FILE,
  ownerAlive,
  parseLock,
  takeOverStaleLock,
  type LockOwner,
} from "./lock";

/** A fresh state directory per test, removed after it. */
let dir: string;
let lockPath: string;
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "e2e-lock-"));
  lockPath = join(dir, LOCK_FILE);
});
test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A dead owner's PID, as the fake `kill`s below see it. */
const DEAD_PID = 4242;

/** A token of `n` repeated: valid, and easy to tell apart. */
function token(n: number): string {
  return n.toString(16).padStart(32, "0");
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
 * Writes a lock file as another orchestrator would have.
 *
 * @param owner - its owner.
 */
async function plantLock(owner: LockOwner): Promise<void> {
  await writeFile(lockPath, formatLock(owner), { mode: 0o600 });
}

test.describe("formatLock / parseLock", () => {
  test("round-trips a lock: the PID on the first line, the token on the second", () => {
    const owner = { pid: 123, token: token(7) };
    expect(formatLock(owner)).toBe(`123\n${token(7)}\n`);
    expect(parseLock(formatLock(owner))).toEqual(owner);
  });

  for (const [why, text] of [
    ["empty", ""],
    ["no trailing newline", `123\n${token(1)}`],
    ["a PID of 0", `0\n${token(1)}\n`],
    ["a leading zero", `0123\n${token(1)}\n`],
    ["a PID past 2^31 - 1", `2147483648\n${token(1)}\n`],
    ["a negative PID", `-5\n${token(1)}\n`],
    [
      "an uppercase token",
      `123\n${token(1).toUpperCase().replace(/0/g, "A")}\n`,
    ],
    ["a short token", `123\nabc\n`],
    ["a third line", `123\n${token(1)}\nmore\n`],
    ["a bare PID", "123\n"],
  ] as const)
    test(`refuses ${why}`, () => {
      expect(parseLock(text)).toBeUndefined();
    });

  test("takes the largest PID process.kill accepts", () => {
    expect(parseLock(`2147483647\n${token(1)}\n`)?.pid).toBe(2147483647);
  });
});

test.describe("ownerAlive", () => {
  test("is alive when kill(pid, 0) succeeds, asking with signal 0", () => {
    const calls: [number, NodeJS.Signals | 0][] = [];
    expect(
      ownerAlive(5, 1, (pid, signal) => {
        calls.push([pid, signal]);
      }),
    ).toBe(true);
    expect(calls).toEqual([[5, 0]]);
  });

  test("reads EPERM as alive: another user's process is still a process", () => {
    expect(
      ownerAlive(5, 1, () => {
        throw systemError("EPERM");
      }),
    ).toBe(true);
  });

  test("reads ESRCH as dead", () => {
    expect(ownerAlive(5, 1, killWithDead(5))).toBe(false);
  });

  test("reads its own PID as dead without asking: an earlier process of that PID left it", () => {
    expect(
      ownerAlive(9, 9, () => {
        throw new Error("never asked");
      }),
    ).toBe(false);
  });

  test("passes on any other error", () => {
    expect(() =>
      ownerAlive(5, 1, () => {
        throw systemError("EINVAL");
      }),
    ).toThrow("kill EINVAL");
  });
});

test.describe("acquireLock", () => {
  test("creates the lock with this PID and its token, owner-only under umask 0, leaving nothing else", async () => {
    const previous = process.umask(0);
    try {
      const lock = await acquireLock(dir, { pid: 77, token: () => token(1) });
      expect(lock.path).toBe(lockPath);
      expect(lock.owner).toEqual({ pid: 77, token: token(1) });
      expect(await readFile(lockPath, "utf8")).toBe(`77\n${token(1)}\n`);
      expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
      expect(await readdir(dir)).toEqual([LOCK_FILE]);
    } finally {
      process.umask(previous);
    }
  });

  test("uses the real PID and a fresh random token by default", async () => {
    const first = await acquireLock(dir);
    expect(first.owner.pid).toBe(process.pid);
    expect(first.owner.token).toMatch(/^[0-9a-f]{32}$/);
    await first.release();
    const second = await acquireLock(dir);
    expect(second.owner.token).not.toBe(first.owner.token);
  });

  test("refuses a live owner, naming its PID and the lock, and leaves the lock alone", async () => {
    await plantLock({ pid: 500, token: token(9) });
    const refusal = acquireLock(dir, { pid: 77, kill: killWithDead() });
    await expect(refusal).rejects.toThrow(StateError);
    await expect(refusal).rejects.toThrow(
      /pid 500\) holds .*orchestrator\.lock.*rm /,
    );
    expect(await readFile(lockPath, "utf8")).toBe(
      formatLock({ pid: 500, token: token(9) }),
    );
  });

  test("refuses an owner kill answers EPERM for", async () => {
    await plantLock({ pid: 500, token: token(9) });
    await expect(
      acquireLock(dir, {
        pid: 77,
        kill: () => {
          throw systemError("EPERM");
        },
      }),
    ).rejects.toThrow(/pid 500/);
    expect(parseLock(await readFile(lockPath, "utf8"))?.token).toBe(token(9));
  });

  test("takes over a dead owner's lock, leaving no claim behind", async () => {
    await plantLock({ pid: DEAD_PID, token: token(9) });
    const lock = await acquireLock(dir, {
      pid: 77,
      kill: killWithDead(DEAD_PID),
      token: () => token(1),
    });
    expect(lock.owner.token).toBe(token(1));
    expect(await readFile(lockPath, "utf8")).toBe(`77\n${token(1)}\n`);
    expect(await readdir(dir)).toEqual([LOCK_FILE]);
  });

  test("takes over a lock naming its own PID", async () => {
    await plantLock({ pid: 77, token: token(9) });
    const lock = await acquireLock(dir, {
      pid: 77,
      kill: killWithDead(),
      token: () => token(1),
    });
    expect(parseLock(await readFile(lockPath, "utf8"))).toEqual(lock.owner);
  });

  for (const [why, text] of [
    ["empty", ""],
    ["garbage", "not a lock"],
    ["a PID alone", `${String(DEAD_PID)}\n`],
  ] as const)
    test(`refuses a lock that is ${why}, naming the file and how to remove it, and keeps it`, async () => {
      await writeFile(lockPath, text);
      await expect(
        acquireLock(dir, { pid: 77, kill: killWithDead(DEAD_PID) }),
      ).rejects.toThrow(/is not a lock this orchestrator wrote.*rm /);
      expect(await readFile(lockPath, "utf8")).toBe(text);
    });

  test("refuses a symbolic link at the lock's path, even to a dead owner's lock, and follows it nowhere", async () => {
    const elsewhere = join(dir, "elsewhere");
    await writeFile(elsewhere, formatLock({ pid: DEAD_PID, token: token(9) }));
    await symlink(elsewhere, lockPath);
    await expect(
      acquireLock(dir, { pid: 77, kill: killWithDead(DEAD_PID) }),
    ).rejects.toThrow(/is a symbolic link/);
    expect(await readlink(lockPath)).toBe(elsewhere);
    expect(await readFile(elsewhere, "utf8")).toBe(
      formatLock({ pid: DEAD_PID, token: token(9) }),
    );
  });

  test("refuses a dangling symbolic link at the lock's path, creating nothing through it", async () => {
    const target = join(dir, "target");
    await symlink(target, lockPath);
    await expect(acquireLock(dir, { pid: 77 })).rejects.toThrow(
      /is a symbolic link/,
    );
    expect(await readdir(dir)).toEqual([LOCK_FILE]);
  });

  test("refuses a folder at the lock's path", async () => {
    await mkdir(lockPath);
    await expect(acquireLock(dir, { pid: 77 })).rejects.toThrow(
      /is not a regular file/,
    );
  });

  test("refuses while another start holds the claim on a stale lock, naming the claim", async () => {
    const stale = { pid: DEAD_PID, token: token(9) };
    await plantLock(stale);
    await writeFile(
      claimPath(lockPath, stale),
      formatLock({ pid: 88, token: token(8) }),
    );
    await expect(
      acquireLock(dir, { pid: 77, kill: killWithDead(DEAD_PID) }),
    ).rejects.toThrow(/Another start is taking over .*\.claim/);
    expect(await readFile(lockPath, "utf8")).toBe(formatLock(stale));
  });

  test("refuses an injected PID or token a lock cannot hold", async () => {
    await expect(acquireLock(dir, { pid: 0 })).rejects.toThrow(RangeError);
    await expect(acquireLock(dir, { token: () => "short" })).rejects.toThrow(
      RangeError,
    );
    expect(await readdir(dir)).toEqual([]);
  });

  // In one process the starts' file operations interleave finely, so this is the race that fails
  // without the claim; across processes (below) each take-over's `fsync` spaces them further apart.
  test("lets exactly one of many concurrent starts take one stale lock", async () => {
    for (let round = 0; round < 25; round += 1) {
      await plantLock({ pid: DEAD_PID, token: token(999) });
      const starts = Array.from({ length: 12 }, (_, i) =>
        acquireLock(dir, {
          pid: 100 + i,
          kill: killWithDead(DEAD_PID),
          token: () => token(i + 1),
        }),
      );
      const results = await Promise.allSettled(starts);
      const won = results.flatMap((r) =>
        r.status === "fulfilled" ? [r.value] : [],
      );
      const refused = results.flatMap((r): unknown[] =>
        r.status === "rejected" ? [r.reason] : [],
      );
      expect(won).toHaveLength(1);
      for (const reason of refused) expect(reason).toBeInstanceOf(StateError);
      expect(parseLock(await readFile(lockPath, "utf8"))).toEqual(
        won[0]?.owner,
      );
      expect(await readdir(dir)).toEqual([LOCK_FILE]);
      await rm(lockPath);
    }
  });

  test("lets exactly one of many concurrent starts create a missing lock", async () => {
    for (let round = 0; round < 25; round += 1) {
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) =>
          acquireLock(dir, {
            pid: 100 + i,
            kill: killWithDead(),
            token: () => token(i + 1),
          }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      await rm(lockPath);
    }
  });
});

test.describe("takeOverStaleLock", () => {
  test("gives up, keeping the lock and dropping its claim, when the lock no longer holds the stale token", async () => {
    // Another start judged the same stale lock first, took it over and dropped its claim.
    const stale = { pid: DEAD_PID, token: token(9) };
    const winner = { pid: 88, token: token(8) };
    await plantLock(winner);
    expect(
      await takeOverStaleLock(lockPath, stale, { pid: 77, token: token(1) }),
    ).toBe(false);
    expect(await readFile(lockPath, "utf8")).toBe(formatLock(winner));
    expect(await readdir(dir)).toEqual([LOCK_FILE]);
  });

  test("gives up, creating nothing, when the stale lock is gone by the time it is claimed", async () => {
    const stale = { pid: DEAD_PID, token: token(9) };
    // Judged stale, then taken over and released by another start before this one's claim.
    expect(
      await takeOverStaleLock(lockPath, stale, { pid: 77, token: token(1) }),
    ).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });
});

test.describe("HeldLock.release", () => {
  test("removes its own lock once, then reports nothing to remove", async () => {
    const lock = await acquireLock(dir, { pid: 77 });
    expect(await lock.release()).toBe(true);
    expect(await readdir(dir)).toEqual([]);
    expect(await lock.release()).toBe(false);
  });

  test("never removes another holder's lock, even one of the same PID", async () => {
    const lock = await acquireLock(dir, { pid: 77, token: () => token(1) });
    const other = { pid: 77, token: token(2) };
    await plantLock(other);
    expect(await lock.release()).toBe(false);
    expect(await readFile(lockPath, "utf8")).toBe(formatLock(other));
  });

  test("never removes, nor follows, a symbolic link put in its place", async () => {
    const lock = await acquireLock(dir, { pid: 77, token: () => token(1) });
    const elsewhere = join(dir, "elsewhere");
    await writeFile(elsewhere, formatLock(lock.owner));
    await rm(lockPath);
    await symlink(elsewhere, lockPath);
    expect(await lock.release()).toBe(false);
    expect(await readlink(lockPath)).toBe(elsewhere);
    expect(await readFile(elsewhere, "utf8")).toBe(formatLock(lock.owner));
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

  test("lets exactly one of several real processes take one stale lock", async () => {
    test.setTimeout(60_000);
    const CHILDREN = 8;
    // A PID that is certainly dead: a process that has already exited.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    await plantLock({ pid: dead, token: token(999) });
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
      expect(parseLock(await readFile(lockPath, "utf8"))?.token).toBe(
        won[0]?.slice(4),
      );
    } finally {
      await writeFile(join(sync, "done"), "").catch(() => undefined);
      await rm(sync, { recursive: true, force: true });
    }
  });
});

/**
 * Waits until `dir` holds `count` files named `prefix…`.
 *
 * @param dir - the folder.
 * @param prefix - their names' start.
 * @param count - how many.
 */
async function waitForFiles(
  dir: string,
  prefix: string,
  count: number,
): Promise<void> {
  while (
    (await readdir(dir)).filter((name) => name.startsWith(prefix)).length <
    count
  )
    await sleep(10);
}
