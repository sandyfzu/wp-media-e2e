import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { formatRunId } from "../../src/common/config/run-id";
import { finishedEvent } from "../__fixtures__/run-finished";
import type { LeaderStartReader } from "../runs/leader";
import type { KillFn } from "../runs/process-group";
import { endedRecord, runningRecord, writeRunRecord } from "../runs/record";
import {
  cellLocks,
  cellLocksFolder,
  SITE_LOCKS_PATH,
  siteKey,
  siteKeys,
  siteLockPath,
  unitOf,
  type CellUnit,
  type HeldCell,
} from "./cell-lock";
import { StateError } from "./errors";
import { LEFTOVER_AGE_MS } from "./leftovers";
import { replaceLockFile, type LockDeps } from "./lock";
import { formatOwner, parseOwner, type LockOwner } from "./lock-owner";
import type { PidSpace } from "./pid-space";

/** The cell every test locks: two sites. */
const UNIT: CellUnit = {
  product: "backwpup",
  cell: "pro@nginx",
  sites: ["https://b.qa.test/", "https://a.qa.test"],
};

/** Its sites' keys, in the order they are taken. */
const KEYS = ["a.qa.test", "b.qa.test"];

/** The PID space every fake process lives in. */
const SPACE: PidSpace = {
  platform: "linux",
  host: "box",
  boot: "f6fb3842-61ea-4a8e-8577-4be12500a66e",
  pidns: "pid:[4026532829]",
  machine: null,
};

/** A holder that has ended: `kill` says no such process. */
const DEAD_PID = 4242;

/** The process group of the dead holder's run, alive in the tests that say so. */
const RUN_PGID = 5151;

/** When the dead holder's run started. */
const STARTED = new Date("2026-10-13T10:15:31.042Z");

/** One test's folder; the site locks' folder in it; another state directory's runs; locks taken. */
let root: string;
let folder: string;
let otherRuns: string;
let taken: HeldCell[];

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "e2e-cell-lock-"));
  folder = join(root, "state-home", SITE_LOCKS_PATH);
  otherRuns = join(root, "other-state", "runs");
  taken = [];
});

test.afterEach(async () => {
  for (const cell of taken) await cell.release();
  await chmod(folder, 0o700).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

/** A process's start, one per PID. */
const readStart: LeaderStartReader = (pid) =>
  Promise.resolve({ kind: "start", value: `test:${String(pid)}` });

/**
 * A fake process: in {@link SPACE}, `DEAD_PID` gone, the groups in `liveGroups` alive, every other
 * process alive and every other group empty.
 *
 * @param pid - its PID.
 * @param n - its token's number.
 * @param liveGroups - the groups with members.
 * @returns the lock's stand-ins.
 */
function deps(pid: number, n: number, liveGroups: number[] = []): LockDeps {
  let next = n;
  const kill: KillFn = (target) => {
    const gone =
      target < 0 ? !liveGroups.includes(-target) : target === DEAD_PID;
    if (gone)
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
  };
  return {
    pid,
    // A token per lock taken: one cell's sites are several locks.
    token: () => (next++).toString(16).padStart(32, "0"),
    kill,
    space: () => Promise.resolve(SPACE),
    readStart,
  };
}

/**
 * A run's record path in the other state directory.
 *
 * @param id - the run's id.
 * @returns its `run.json`.
 */
function recordOf(id: string): string {
  return join(otherRuns, id, "run.json");
}

/**
 * Writes the other state directory's record of a run still running, in group {@link RUN_PGID}.
 *
 * @param id - the run's id.
 * @returns its path.
 */
async function runningRun(id: string): Promise<string> {
  const path = recordOf(id);
  await mkdir(join(otherRuns, id), { recursive: true, mode: 0o700 });
  await writeRunRecord(
    path,
    runningRecord(
      { id, runId: formatRunId(STARTED, id), startedAt: STARTED },
      "bpng",
      {
        name: "playwright",
        pgid: RUN_PGID,
        leaderStart: `test:${String(RUN_PGID)}`,
      },
    ),
  );
  return path;
}

/**
 * Plants a site's lock another orchestrator wrote — dead ({@link DEAD_PID}) by default.
 *
 * @param key - the site's key.
 * @param run - the run's record it names, if any.
 * @param pid - its holder's PID.
 * @param label - what its holder runs there.
 */
async function plantHolder(
  key: string,
  run: string | undefined,
  pid = DEAD_PID,
  label = "backwpup other@cell",
): Promise<void> {
  const owner: LockOwner = {
    pid,
    token: "d".repeat(32),
    start: `test:${String(pid)}`,
    space: SPACE,
    label,
    ...(run === undefined ? {} : { run }),
  };
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(siteLockPath(folder, key), formatOwner(owner), {
    mode: 0o600,
  });
}

/**
 * Takes the cell's site locks, released after the test.
 *
 * @param lockDeps - the fake process.
 * @param unit - the cell.
 * @param run - a run to name.
 * @returns the locks.
 */
async function take(
  lockDeps: LockDeps,
  unit: CellUnit = UNIT,
  run?: string,
): Promise<HeldCell> {
  const cell = await cellLocks(folder, lockDeps).acquire(unit, run);
  taken.push(cell);
  return cell;
}

/**
 * A lock's owner, as on disk.
 *
 * @param key - the site's key.
 * @returns the owner, or `undefined`.
 */
async function ownerOn(key: string): Promise<LockOwner | undefined> {
  const parsed = parseOwner(await readFile(siteLockPath(folder, key), "utf8"));
  return parsed.kind === "owner" ? parsed.owner : undefined;
}

/**
 * Why a promise rejected.
 *
 * @param promise - a promise that must reject.
 * @returns the error.
 */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  const error: unknown = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

test.describe("cellLocksFolder", () => {
  test("is under XDG_STATE_HOME when it is absolute, else under HOME's .local/state", () => {
    expect(cellLocksFolder({ XDG_STATE_HOME: "/x", HOME: "/h" })).toBe(
      join("/x", SITE_LOCKS_PATH),
    );
    // A relative XDG_STATE_HOME is ignored, as the XDG specification says.
    expect(cellLocksFolder({ XDG_STATE_HOME: "x", HOME: "/h" })).toBe(
      "/h/.local/state/wp-media-e2e/site-locks",
    );
  });

  test("refuses an environment with no absolute HOME nor XDG_STATE_HOME", () => {
    for (const env of [{}, { HOME: "h" }, { XDG_STATE_HOME: "", HOME: "" }])
      expect(() => cellLocksFolder(env)).toThrow(StateError);
  });
});

test.describe("siteKey / siteKeys / siteLockPath / unitOf", () => {
  test("keys a site by host, written port and path: no scheme, credentials, query, fragment or trailing slash", () => {
    expect(siteKey("https://user:pw@Simple.QA.test/")).toBe("simple.qa.test");
    expect(siteKey("http://simple.qa.test")).toBe("simple.qa.test");
    expect(siteKey("https://simple.qa.test:443/")).toBe("simple.qa.test");
    expect(siteKey("http://localhost:8100/wp//?a=1#b")).toBe(
      "localhost:8100/wp",
    );
    expect(siteKey("https://a.test/WP")).not.toBe(siteKey("https://a.test/wp"));
  });

  // The reviewer's table: each row, what it keys to.
  for (const [url, key] of [
    ["https://x.test", "x.test"],
    ["https://x.test:443", "x.test"],
    ["http://x.test:443", "x.test"],
    ["https://x.test:80", "x.test"],
    ["http://x.test", "x.test"],
    ["http://X.TEST/", "x.test"],
    ["https://x.test.", "x.test"],
    ["https://x.test/wp/", "x.test/wp"],
    ["https://x.test/WP", "x.test/WP"],
    ["https://x.test/a%2fb", "x.test/a%2Fb"],
    ["https://x.test/a/b", "x.test/a/b"],
    ["https://x.test//", "x.test"],
    ["https://x.test/./wp/../wp", "x.test/wp"],
    ["http://[::1]:8100", "[::1]:8100"],
    ["http://[0:0:0:0:0:0:0:1]:8100", "[::1]:8100"],
    ["http://bücher.test", "xn--bcher-kva.test"],
    ["http://xn--bcher-kva.test", "xn--bcher-kva.test"],
    ["http://127.0.0.1", "127.0.0.1"],
    ["http://2130706433", "127.0.0.1"],
    ["http://0x7f.1", "127.0.0.1"],
    ["https://x.test/wp?x=1#f", "x.test/wp"],
    ["https://u:p@x.test/wp/index.php", "x.test/wp/index.php"],
    ["https://x.test/%7Euser", "x.test/~user"],
    ["https://x.test/%7euser", "x.test/~user"],
    ["https://x.test/~user", "x.test/~user"],
    ["https://x.test/wp%20x", "x.test/wp%20x"],
    ["https://x.test/wp\\sub", "x.test/wp/sub"],
    ["https://x.test:8443/wp", "x.test:8443/wp"],
  ] as const)
    test(`keys ${url} as ${key}`, () => {
      expect(siteKey(url)).toBe(key);
    });

  test("refuses anything but an http(s) URL", () => {
    for (const url of ["ftp://a.test", "not a url", "", "file:///etc"])
      expect(() => siteKey(url)).toThrow(RangeError);
  });

  test("sorts a cell's keys, each once", () => {
    expect(
      siteKeys({
        sites: [...UNIT.sites, "http://a.qa.test/", "https://a.qa.test/"],
      }),
    ).toEqual(KEYS);
  });

  test("names a site's lock by its key's hash: a safe file name for any key", () => {
    const path = siteLockPath("/l", "a.qa.test:8100/../x");
    expect(path).toMatch(/^\/l\/[0-9a-f]{32}\.lock$/);
    expect(siteLockPath("/l", "a.qa.test")).not.toBe(path);
  });

  test("unitOf: every site of a pool, in its order", () => {
    expect(
      unitOf({
        task: { product: "backwpup", cell: "pro@nginx" },
        cell: {
          sites: [
            { baseURL: "https://b.qa.test" },
            { baseURL: "https://a.qa.test/wp" },
          ],
        },
      }).sites,
    ).toEqual(["https://b.qa.test", "https://a.qa.test/wp"]);
  });

  test("unitOf: a selected task's product, cell and sites' baseURLs", () => {
    expect(
      unitOf({
        task: { product: "backwpup", cell: "pro@nginx" },
        cell: { sites: [{ baseURL: "https://a.qa.test" }] },
      }),
    ).toEqual({
      product: "backwpup",
      cell: "pro@nginx",
      sites: ["https://a.qa.test"],
    });
  });

  test("refuses a relative folder", () => {
    expect(() => cellLocks("site-locks")).toThrow(RangeError);
  });
});

test.describe("CellLocks.acquire", () => {
  test("makes its folders — ours 0700, those above with the default mode —, takes every site in key order, labelled", async () => {
    const cell = await take(deps(100, 1));
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect((await stat(join(folder, ".."))).mode & 0o777).toBe(0o700);
    // The state home was made by the default mode, never 0700 by us.
    await mkdir(join(root, "by-default"));
    const byDefault = (await stat(join(root, "by-default"))).mode & 0o777;
    expect((await stat(join(root, "state-home"))).mode & 0o777).toBe(byDefault);
    expect(cell.locks.map((lock) => lock.path)).toEqual(
      KEYS.map((key) => siteLockPath(folder, key)),
    );
    for (const key of KEYS)
      expect(await ownerOn(key)).toMatchObject({
        pid: 100,
        label: "backwpup pro@nginx",
        key,
      });
    expect(await cell.release()).toBe(true);
    expect(await readdir(folder)).toEqual([]);
  });

  test("names each run in every lock, its token unchanged, while the locks are held", async () => {
    const cell = await take(deps(100, 1));
    const before = await ownerOn(KEYS[0] ?? "");
    expect(await cell.setRun(recordOf("bpng-1"))).toEqual({ kind: "named" });
    expect(await cell.setRun(recordOf("bpng-2"))).toEqual({ kind: "named" });
    for (const key of KEYS)
      expect(await ownerOn(key)).toMatchObject({
        token: KEYS[0] === key ? before?.token : expect.any(String),
        run: recordOf("bpng-2"),
      });
    // No temporary file left by the rewrite.
    expect((await readdir(folder)).sort()).toEqual(
      KEYS.map((key) =>
        siteLockPath(folder, key).slice(folder.length + 1),
      ).sort(),
    );
  });

  test("a run cannot be named once a lock is another's: false, and the other's lock untouched", async () => {
    const cell = await take(deps(100, 1));
    await plantHolder(KEYS[1] ?? "", undefined, 300);
    expect(await cell.setRun(recordOf("bpng-1"))).toEqual({ kind: "lost" });
    expect(await ownerOn(KEYS[1] ?? "")).toMatchObject({ pid: 300 });
    expect((await ownerOn(KEYS[1] ?? ""))?.run).toBeUndefined();
  });

  test("a run path too long for a lock is never written: false, the lock as it was", async () => {
    const cell = await take(deps(100, 1));
    const long = `/${"é".repeat(4000)}/runs/bpng-1/run.json`;
    expect(await cell.setRun(long)).toEqual({
      kind: "failed",
      why: "its record's path is not one a lock can hold (too long, or a control character)",
    });
    expect((await ownerOn(KEYS[0] ?? ""))?.run).toBeUndefined();
  });

  test("refuses a site a live orchestrator holds, naming its cell, the site, its run and the way out — and gives back the sites it took", async () => {
    await plantHolder(KEYS[1] ?? "", recordOf("bpng-3"), 100);
    const error = await rejectionOf(take(deps(101, 2)));
    expect(error).toBeInstanceOf(StateError);
    const path = siteLockPath(folder, KEYS[1] ?? "");
    expect(error.message).toBe(
      `Another orchestrator (pid 100 on box — running backwpup other@cell on site b.qa.test, run bpng-3 (${recordOf("bpng-3")})) holds ${path}. Stop it first; if pid 100 is no orchestrator, remove the lock: rm ${path}`,
    );
    // All or nothing: the first site, taken, was given back.
    expect(await readdir(folder)).toEqual([path.slice(folder.length + 1)]);
  });

  test("two cells naming one site exclude each other; one name on other sites does not", async () => {
    await take(deps(100, 1));
    const sameSite = {
      ...UNIT,
      cell: "renamed",
      sites: ["https://a.qa.test:443/"],
    };
    const error = await rejectionOf(
      cellLocks(folder, deps(200, 50)).acquire(sameSite),
    );
    // In one process: the site another of its tasks holds.
    expect(error.message).toContain("already holds");
    expect(error.message).toContain(
      "running backwpup pro@nginx on site a.qa.test",
    );
    await take(deps(201, 60), { ...UNIT, sites: ["https://c.qa.test"] });
  });

  test("takes over a dead orchestrator's lock whose run is over, never named, or never recorded", async () => {
    const ended = recordOf("bpng-4");
    await mkdir(join(otherRuns, "bpng-4"), { recursive: true });
    await writeRunRecord(
      ended,
      endedRecord(
        {
          id: "bpng-4",
          runId: formatRunId(STARTED, "bpng-4"),
          startedAt: STARTED,
        },
        "bpng",
        { bddgen: { code: 0, signal: null }, stop: { level: "none" } },
        finishedEvent(),
      ),
    );
    for (const run of [ended, undefined, recordOf("bpng-never")]) {
      await plantHolder(KEYS[0] ?? "", run);
      const cell = await take(deps(100, 1));
      expect(await cell.release()).toBe(true);
    }
  });

  test("takes over a dead orchestrator's lock whose run's group has ended, leaving its record as it is", async () => {
    const run = await runningRun("bpng-5");
    await plantHolder(KEYS[0] ?? "", run);
    await take(deps(100, 1));
    // The other state directory's start marks it lost: this one is not its owner.
    expect(JSON.parse(await readFile(run, "utf8"))).toMatchObject({
      state: "running",
    });
  });

  test("refuses a dead orchestrator's lock whose run still runs: an orphan, with the command that ends it", async () => {
    const run = await runningRun("bpng-6");
    await plantHolder(KEYS[0] ?? "", run);
    const path = siteLockPath(folder, KEYS[0] ?? "");
    const error = await rejectionOf(take(deps(100, 1, [RUN_PGID])));
    expect(error).toBeInstanceOf(StateError);
    expect(error.message).toBe(
      `The lock of site a.qa.test (${path}) was left by an orchestrator that has ended (pid ${String(DEAD_PID)}), running backwpup other@cell, and its run may still run. ` +
        `Task bpng still has run bpng-6 running, in process group ${String(RUN_PGID)}: an orchestrator stopped without ending it, and a second run would share its sites. End it with: kill -KILL -${String(RUN_PGID)}`,
    );
    expect(await ownerOn(KEYS[0] ?? "")).toMatchObject({ pid: DEAD_PID });
  });

  test("refuses a dead orchestrator's lock whose run's record cannot be read: its run may still run", async () => {
    const run = recordOf("bpng-7");
    await mkdir(join(otherRuns, "bpng-7"), { recursive: true });
    await writeFile(run, "{");
    await plantHolder(KEYS[0] ?? "", run);
    const error = await rejectionOf(take(deps(100, 1)));
    expect(error.message).toContain(
      `the record of its run, ${run}, cannot be read`,
    );
    expect(error.message).toContain(
      `remove the lock: rm ${siteLockPath(folder, KEYS[0] ?? "")}`,
    );
  });

  test("refuses a site locks' folder that is open to others, or a link", async () => {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await chmod(folder, 0o755);
    expect((await rejectionOf(take(deps(100, 1)))).message).toBe(
      `The site locks' folder ${folder} is mode 755: it must be this user's alone (chmod 700 ${folder}).`,
    );
    await rm(folder, { recursive: true });
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere, { mode: 0o700 });
    await symlink(elsewhere, folder);
    expect((await rejectionOf(take(deps(100, 1)))).message).toContain(
      `The site locks' folder ${folder} is not a folder (a symbolic link is never followed).`,
    );
    expect(await readdir(elsewhere)).toEqual([]);
  });

  test("sweeps its own sites' old leftovers as they are taken, and no other site's", async () => {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const name = (key: string): string =>
      siteLockPath(folder, key).slice(folder.length + 1);
    const mine = join(folder, `.${name(KEYS[0] ?? "")}.0123456789ab.tmp`);
    const other = join(folder, `.${name("c.qa.test")}.0123456789ab.tmp`);
    const old = new Date(Date.now() - 2 * LEFTOVER_AGE_MS);
    for (const file of [mine, other]) {
      await writeFile(file, "");
      await utimes(file, old, old);
    }
    const cell = await take(deps(100, 1));
    expect(cell.locks[0]?.leftovers.removed).toEqual([mine]);
    expect(await readdir(folder)).toContain(other.slice(folder.length + 1));
  });
});

test.describe("CellLocks — rewriting and releasing", () => {
  test("a lock that cannot be rewritten for a file system refusal says so, apart from a lost one, and stays as it was", async () => {
    const cell = await take(deps(100, 1));
    const before = await readFile(siteLockPath(folder, KEYS[0] ?? ""), "utf8");
    await chmod(folder, 0o500);
    try {
      expect(await cell.setRun(recordOf("bpng-1"))).toEqual({
        kind: "failed",
        why: "EACCES",
      });
    } finally {
      await chmod(folder, 0o700);
    }
    expect(await readFile(siteLockPath(folder, KEYS[0] ?? ""), "utf8")).toBe(
      before,
    );
  });

  test("releases every lock even when one cannot be released", async () => {
    const cell = await take(deps(100, 1));
    // The lock released first (the keys' reverse order) is now another's: its release answers false.
    await plantHolder(KEYS[1] ?? "", undefined, 300);
    expect(await cell.release()).toBe(false);
    expect(await readdir(folder)).toEqual([
      siteLockPath(folder, KEYS[1] ?? "").slice(folder.length + 1),
    ]);
  });

  test("a reader racing setRun never sees a part of the lock: the old text or the new, whole", async () => {
    const cell = await take(deps(100, 1));
    const path = siteLockPath(folder, KEYS[0] ?? "");
    // A child reads the lock in a tight loop for 1.5 s and says how many reads were not an owner.
    const reader = spawn(
      process.execPath,
      [
        "-e",
        `const fs = require("node:fs"); let bad = 0, reads = 0; const end = Date.now() + 1500;
         while (Date.now() < end) { try { const t = fs.readFileSync(process.argv[1], "utf8"); reads++;
           try { JSON.parse(t); if (!t.endsWith("\\n")) bad++; } catch { bad++; } } catch {} }
         process.stdout.write(JSON.stringify({ bad, reads }));`,
        path,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    reader.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    const closed = new Promise<void>((resolve) =>
      reader.on("close", () => {
        resolve();
      }),
    );
    const deadline = Date.now() + 1400;
    for (let n = 0; Date.now() < deadline; n += 1)
      expect(
        await cell.setRun(recordOf(`bpng-${"9".repeat(1 + (n % 400))}`)),
      ).toEqual({ kind: "named" });
    await closed;
    const { bad, reads } = JSON.parse(out) as { bad: number; reads: number };
    expect(reads).toBeGreaterThan(0);
    expect(bad).toBe(0);
  });

  test("replaceLockFile removes its temporary file when the rename fails", async () => {
    await mkdir(join(folder, "taken", "inside"), { recursive: true });
    await expect(
      replaceLockFile(join(folder, "taken"), "text\n"),
    ).rejects.toThrow();
    expect(await readdir(folder)).toEqual(["taken"]);
  });
});

test.describe("CellLocks.inspect", () => {
  test("finds a cell free when nothing is there, and makes no folder", async () => {
    expect(await cellLocks(folder, deps(100, 1)).inspect(UNIT)).toEqual({
      kind: "free",
    });
    await expect(stat(folder)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("judges as the loop would: a live holder, a dead one's orphan and an open folder refused; writes nothing", async () => {
    const locks = cellLocks(folder, deps(101, 2, [RUN_PGID]));
    await plantHolder(KEYS[1] ?? "", recordOf("bpng-8"), 100);
    const live = await locks.inspect(UNIT);
    expect(live.kind === "refused" && live.message).toContain(
      "Another orchestrator (pid 100 on box — running backwpup other@cell on site b.qa.test",
    );
    await plantHolder(KEYS[1] ?? "", await runningRun("bpng-9"));
    const before = await readFile(siteLockPath(folder, KEYS[1] ?? ""), "utf8");
    const orphan = await locks.inspect(UNIT);
    expect(orphan.kind === "refused" && orphan.message).toContain(
      "kill -KILL -5151",
    );
    expect(await readFile(siteLockPath(folder, KEYS[1] ?? ""), "utf8")).toBe(
      before,
    );
    expect(await cellLocks(folder, deps(101, 2)).inspect(UNIT)).toEqual({
      kind: "free",
    });
    await chmod(folder, 0o777);
    expect(await locks.inspect(UNIT)).toEqual({
      kind: "refused",
      message: `The site locks' folder ${folder} is mode 777: it must be this user's alone (chmod 700 ${folder}).`,
    });
  });
});

test.describe("CellLocks across processes", () => {
  test("smoke: of 20 real processes racing for one cell's sites, exactly one takes them, the others all-or-nothing", async () => {
    const module = fileURLToPath(new URL("./cell-lock.ts", import.meta.url));
    // Each names the sites in its own order: the locks are still taken in the keys' order.
    const body = `
      import { readdirSync } from "node:fs";
      import { cellLocks } from ${JSON.stringify(module)};
      const sites = ["https://a.qa.test", "https://b.qa.test", "https://c.qa.test"];
      if (process.argv[2] === "1") sites.reverse();
      try {
        await cellLocks(process.argv[1]).acquire({ product: "backwpup", cell: "pro@nginx", sites }, "/s/runs/bpng-1/run.json");
        process.stdout.write("took");
        setTimeout(() => {}, 2500);
      } catch (error) {
        process.stdout.write("refused: " + error.message);
      }
    `;
    const outputs = await Promise.all(
      Array.from({ length: 20 }, (_, index) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "--eval",
            body,
            folder,
            String(index % 2),
          ],
          { stdio: ["ignore", "pipe", "inherit"] },
        );
        let out = "";
        child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
        return new Promise<string>((resolve) =>
          child.on("close", () => {
            resolve(out);
          }),
        );
      }),
    );
    expect(outputs.filter((out) => out === "took")).toHaveLength(1);
    for (const out of outputs.filter((o) => o !== "took"))
      expect(out).toMatch(
        /^refused: (Another orchestrator \(pid \d+.* — running backwpup pro@nginx on site [abc]\.qa\.test, run bpng-1|.*kept changing|Another start)/,
      );
  });
});
