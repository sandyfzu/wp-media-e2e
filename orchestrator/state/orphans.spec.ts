import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { formatRunId } from "../../src/common/config/run-id";
import { finishedEvent } from "../__fixtures__/run-finished";
import type { LeaderStart, LeaderStartReader } from "../runs/leader";
import { readLeaderStart } from "../runs/leader";
import { waitForEmptyGroup, type KillFn } from "../runs/process-group";
import {
  endedRecord,
  leaderProcess,
  runningRecord,
  startingRecord,
  writeRunRecord,
  type RunningProcess,
} from "../runs/record";
import {
  checkOrphans,
  classifyRunning,
  orphanRefusal,
  type OrphanCheckDeps,
} from "./orphans";
import { INIT_PID_NAMESPACE, type PidSpace } from "./pid-space";

const STARTED = new Date("2026-10-13T10:15:31.042Z");
const FOUND = new Date("2026-10-13T12:00:00.000Z");
const START = "ps:Tue Oct 13 10:15:31 2026";

/** This boot, on a host whose PID space shows an earlier boot as one. */
const HOST_SPACE: PidSpace = {
  platform: "linux",
  host: "qa-lnmp",
  boot: "f6fb3842-61ea-4a8e-8577-4be12500a66e",
  pidns: INIT_PID_NAMESPACE,
  machine: "0123456789abcdef0123456789abcdef",
};

/** A leader start recorded in an earlier boot than {@link HOST_SPACE}'s. */
const EARLIER_BOOT_START = "linux:0b5c2d7e-1111-4222-8333-944455566677:1347811";

/**
 * A run's identity.
 *
 * @param id - its id, `bpng-12`.
 */
function identity(id: string) {
  return { id, runId: formatRunId(STARTED, id), startedAt: STARTED };
}

/**
 * A `kill` stand-in: groups in `alive` have members we may signal, groups in `foreign` members we
 * may not; any other is empty.
 *
 * @param alive - the live groups.
 * @param foreign - the live groups of another user.
 */
function killWith(
  alive: readonly number[],
  foreign: readonly number[] = [],
): KillFn {
  return (pid) => {
    if (foreign.includes(-pid))
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    if (!alive.includes(-pid))
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
  };
}

/**
 * A start reader answering from a table, `gone` for any other PID.
 *
 * @param starts - PID → its start now.
 */
function startsOf(
  starts: Readonly<Record<number, LeaderStart>>,
): LeaderStartReader {
  return (pid) => Promise.resolve(starts[pid] ?? { kind: "gone" });
}

/**
 * The check's dependencies.
 *
 * @param overrides - what differs from no live group at all.
 */
function deps(overrides: Partial<OrphanCheckDeps> = {}): OrphanCheckDeps {
  return {
    kill: killWith([]),
    readLeaderStart: startsOf({}),
    now: () => FOUND,
    ...overrides,
  };
}

/** Whether `lsof` runs here: macOS and Ubuntu have it, a slim container may not. */
function hasLsof(): boolean {
  try {
    execFileSync("lsof", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** A real process group whose leader has exited while a member lives on. */
interface LeaderlessGroup {
  /** The group's id: its exited leader's PID. */
  readonly pgid: number;
  /** The member's PID. */
  readonly member: number;
}

/**
 * Starts a detached group (as a run is) whose leader starts a member in its own group, says its PID,
 * and exits — as Playwright's runner, killed, leaves its workers running for a while.
 *
 * @param beforeExit - called with the group's id while its leader still lives.
 * @returns the group, once its leader has exited and been reaped. Kill it with `-pgid`.
 */
async function leaderlessGroup(
  beforeExit: (pgid: number) => Promise<void> = () => Promise.resolve(),
): Promise<LeaderlessGroup> {
  const leader = spawn(
    process.execPath,
    [
      "-e",
      `process.stdin.once("data", () => {
         const member = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
         member.unref();
         process.stdout.write(String(member.pid), () => process.exit(0));
       });`,
    ],
    { detached: true, stdio: ["pipe", "pipe", "ignore"] },
  );
  await once(leader, "spawn");
  const pgid = leader.pid ?? 0;
  let said = "";
  leader.stdout.on("data", (chunk: Buffer) => (said += chunk.toString()));
  const closed = once(leader, "close");
  try {
    await beforeExit(pgid);
  } finally {
    leader.stdin.end("go");
  }
  await closed;
  return { pgid, member: Number(said) };
}

/**
 * Kills a group, if anything is left in it, and waits until it is empty.
 *
 * @param pgid - the group.
 */
async function killGroup(pgid: number): Promise<void> {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    return;
  }
  await waitForEmptyGroup(pgid, {
    kill: process.kill.bind(process),
    sleep: delay,
    pollMs: 20,
    timeoutMs: 10_000,
  });
}

/** A state directory of its own, removed after the test. */
let stateDir: string;

test.beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "e2e-orphans-"));
});

test.afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

/**
 * A run's folder, made.
 *
 * @param id - the run's id.
 * @returns its folder.
 */
async function runFolder(id: string): Promise<string> {
  const dir = join(stateDir, "runs", id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Writes a running record in its run's folder.
 *
 * @param id - the run's id.
 * @param process - its process, when one started.
 * @returns the record's path.
 */
async function running(id: string, process?: RunningProcess): Promise<string> {
  const path = join(await runFolder(id), "run.json");
  await writeRunRecord(path, runningRecord(identity(id), "bpng", process));
  return path;
}

/**
 * A record read back as JSON.
 *
 * @param path - its path.
 */
async function recordAt(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

test.describe("classifyRunning", () => {
  const recorded = {
    process: { name: "playwright", pgid: 4242, leaderStart: START },
  } as const;

  test("an orphan: its group alive, led by the process that started when recorded", async () => {
    expect(
      await classifyRunning(recorded, {
        kill: killWith([4242]),
        readLeaderStart: startsOf({ 4242: { kind: "start", value: START } }),
      }),
    ).toEqual({ kind: "orphan", pgid: 4242, confirmed: true });
  });

  test("a group alive but its number reused — another start — is stale", async () => {
    expect(
      await classifyRunning(recorded, {
        kill: killWith([4242]),
        readLeaderStart: startsOf({
          4242: { kind: "start", value: "ps:Tue Oct 13 11:40:02 2026" },
        }),
      }),
    ).toEqual({ kind: "stale", reason: "leader differs" });
  });

  test("a group alive with its leader gone is an unconfirmed orphan: the runner died, its workers live on", async () => {
    expect(
      await classifyRunning(recorded, {
        kill: killWith([4242]),
        readLeaderStart: startsOf({}),
      }),
    ).toEqual({
      kind: "orphan",
      pgid: 4242,
      confirmed: false,
      why: "its playwright process has exited, and the rest of its group still runs",
    });
  });

  test("a group ended is stale, whoever has the PID now", async () => {
    expect(
      await classifyRunning(recorded, {
        kill: killWith([]),
        readLeaderStart: startsOf({ 4242: { kind: "start", value: START } }),
      }),
    ).toEqual({ kind: "stale", reason: "process group ended" });
  });

  test("a group with no member ours to signal, its leader gone, is an unconfirmed orphan: a run's sudo command may still work", async () => {
    const eperm: KillFn = () => {
      throw Object.assign(new Error(), { code: "EPERM" });
    };
    expect(
      await classifyRunning(recorded, {
        kill: eperm,
        readLeaderStart: startsOf({}),
      }),
    ).toEqual({
      kind: "orphan",
      pgid: 4242,
      confirmed: false,
      why: "its playwright process has exited, and only processes of another user remain in its group — a command the run ran as that user (sudo), or that user's own group; ending them needs that user",
    });
    // Judged by its leader like any live group: the recorded one is the run's, another start a stranger's.
    expect(
      await classifyRunning(recorded, {
        kill: eperm,
        readLeaderStart: startsOf({ 4242: { kind: "start", value: START } }),
      }),
    ).toEqual({ kind: "orphan", pgid: 4242, confirmed: true });
    expect(
      await classifyRunning(recorded, {
        kill: eperm,
        readLeaderStart: startsOf({
          4242: { kind: "start", value: "ps:Tue Oct 13 11:40:02 2026" },
        }),
      }),
    ).toEqual({ kind: "stale", reason: "leader differs" });
  });

  test("a process starting, its group never recorded, is an unconfirmed orphan, without asking anything", async () => {
    const asked: number[] = [];
    const ask = {
      kill: (pid: number) => {
        asked.push(pid);
      },
      readLeaderStart: (pid: number) => {
        asked.push(pid);
        return Promise.resolve({ kind: "gone" } as const);
      },
    };
    for (const name of ["bddgen", "playwright"] as const)
      expect(await classifyRunning({ starting: name }, ask)).toEqual({
        kind: "orphan",
        confirmed: false,
        why: `its orchestrator stopped while starting its ${name} process, before recording the process's group`,
      });
    // Whatever else the record says: the previous process's ended group does not make it over.
    expect(
      await classifyRunning(
        { ...recorded, starting: "playwright" },
        { ...ask, kill: killWith([]) },
      ),
    ).toMatchObject({ kind: "orphan", confirmed: false });
    expect(asked).toEqual([]);
  });

  test("no process recorded is stale, without asking anything", async () => {
    const asked: number[] = [];
    expect(
      await classifyRunning(
        {},
        {
          kill: (pid) => {
            asked.push(pid);
          },
          readLeaderStart: (pid) => {
            asked.push(pid);
            return Promise.resolve({ kind: "start", value: START });
          },
        },
      ),
    ).toEqual({ kind: "stale", reason: "no process recorded" });
    expect(asked).toEqual([]);
  });

  test("a live group whose leader's start was never read is an unconfirmed orphan, and says why", async () => {
    const alive = {
      kill: killWith([4242]),
      readLeaderStart: startsOf({ 4242: { kind: "start", value: START } }),
    };
    expect(
      await classifyRunning(
        {
          process: {
            name: "bddgen",
            pgid: 4242,
            leaderStartUnread: "EACCES",
          },
        },
        alive,
      ),
    ).toEqual({
      kind: "orphan",
      pgid: 4242,
      confirmed: false,
      why: "its leader's start could not be read at spawn (EACCES)",
    });
    // A record written before the start was recorded at all.
    expect(
      await classifyRunning({ process: { name: "bddgen", pgid: 4242 } }, alive),
    ).toEqual({
      kind: "orphan",
      pgid: 4242,
      confirmed: false,
      why: "its leader's start was not recorded",
    });
    // Its group gone, it is stale all the same.
    expect(
      await classifyRunning(
        { process: { name: "bddgen", pgid: 4242, leaderStartUnread: "gone" } },
        { ...alive, kill: killWith([]) },
      ),
    ).toEqual({ kind: "stale", reason: "process group ended" });
  });

  test("what cannot be checked now is an unconfirmed orphan, never stale", async () => {
    expect(
      await classifyRunning(recorded, {
        kill: killWith([4242]),
        readLeaderStart: startsOf({
          4242: { kind: "unknown", why: "timed out" },
        }),
      }),
    ).toEqual({
      kind: "orphan",
      pgid: 4242,
      confirmed: false,
      why: "its leader's start cannot be read now (timed out)",
    });
    expect(
      await classifyRunning(recorded, {
        kill: () => {
          throw Object.assign(new Error(), { code: "EINVAL" });
        },
        readLeaderStart: startsOf({ 4242: { kind: "start", value: START } }),
      }),
    ).toEqual({
      kind: "orphan",
      pgid: 4242,
      confirmed: false,
      why: "its group could not be asked (EINVAL)",
    });
  });

  test("a leader from an earlier boot of this machine is stale, without asking its group: the number is any process's now", async () => {
    const asked: number[] = [];
    expect(
      await classifyRunning(
        {
          process: {
            name: "playwright",
            pgid: 4242,
            leaderStart: EARLIER_BOOT_START,
          },
        },
        {
          kill: (pid) => {
            asked.push(pid);
          },
          readLeaderStart: startsOf({}),
          space: () => Promise.resolve(HOST_SPACE),
        },
      ),
    ).toEqual({ kind: "stale", reason: "earlier boot" });
    expect(asked).toEqual([]);
  });

  test("a leader from another boot is judged by its group when the boot cannot be shown an earlier one of this machine", async () => {
    const leaderless = {
      kind: "orphan",
      pgid: 4242,
      confirmed: false,
      why: "its playwright process has exited, and the rest of its group still runs",
    };
    const judge = (leaderStart: string, space: PidSpace) =>
      classifyRunning(
        { process: { name: "playwright", pgid: 4242, leaderStart } },
        {
          kill: killWith([4242]),
          readLeaderStart: startsOf({}),
          space: () => Promise.resolve(space),
        },
      );
    // This very boot; a container's namespace; no machine id; a boot unread; a start that is no boot's.
    const cases: [string, PidSpace][] = [
      [`linux:${HOST_SPACE.boot ?? ""}:1347811`, HOST_SPACE],
      [EARLIER_BOOT_START, { ...HOST_SPACE, pidns: "pid:[4026532829]" }],
      [EARLIER_BOOT_START, { ...HOST_SPACE, machine: null }],
      [EARLIER_BOOT_START, { ...HOST_SPACE, boot: null }],
      ["linux:not-a-boot-id:1347811", HOST_SPACE],
      [START, HOST_SPACE],
    ];
    for (const [start, space] of cases)
      expect(await judge(start, space), start).toEqual(leaderless);
  });
});

test.describe("checkOrphans", () => {
  test("finds nothing when there is no runs' folder yet", async () => {
    expect(await checkOrphans(stateDir, deps())).toEqual({
      orphans: [],
      stale: [],
      warnings: [],
    });
  });

  test("reports an orphan and leaves its record as it is", async () => {
    const path = await running("bpng-12", {
      name: "playwright",
      pgid: 4242,
      leaderStart: START,
    });
    const before = await readFile(path, "utf8");
    const check = await checkOrphans(
      stateDir,
      deps({
        kill: killWith([4242]),
        readLeaderStart: startsOf({ 4242: { kind: "start", value: START } }),
      }),
    );
    expect(check).toEqual({
      orphans: [
        {
          taskId: "bpng",
          id: "bpng-12",
          pgid: 4242,
          record: path,
          confirmed: true,
        },
      ],
      stale: [],
      warnings: [],
    });
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("reports an unconfirmed orphan with why, and leaves its record as it is", async () => {
    const path = await running("bpng-12", {
      name: "playwright",
      pgid: 4242,
      leaderStart: START,
    });
    const before = await readFile(path, "utf8");
    const check = await checkOrphans(
      stateDir,
      deps({ kill: killWith([4242]), readLeaderStart: startsOf({}) }),
    );
    expect(check.orphans).toEqual([
      {
        taskId: "bpng",
        id: "bpng-12",
        pgid: 4242,
        record: path,
        confirmed: false,
        why: "its playwright process has exited, and the rest of its group still runs",
      },
    ]);
    expect(check.stale).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("refuses on a group holding only another user's processes, its leader gone, and keeps the record", async () => {
    // As a run's `sudo rm` left working once the group's SIGKILL ended everything of ours.
    const path = await running("bpng-12", {
      name: "playwright",
      pgid: 4242,
      leaderStart: START,
    });
    const before = await readFile(path, "utf8");
    const check = await checkOrphans(
      stateDir,
      deps({ kill: killWith([], [4242]), readLeaderStart: startsOf({}) }),
    );
    expect(check.stale).toEqual([]);
    const [orphan, ...more] = check.orphans;
    if (orphan === undefined) throw new Error("no orphan reported");
    expect(more).toEqual([]);
    expect(orphan).toMatchObject({
      id: "bpng-12",
      pgid: 4242,
      confirmed: false,
    });
    expect(orphanRefusal(orphan)).toBe(
      "Task bpng may still have run bpng-12 running, in process group 4242 — unconfirmed: its " +
        "playwright process has exited, and only processes of another user remain in its group — a " +
        "command the run ran as that user (sudo), or that user's own group; ending them needs that " +
        "user. A second run would share its sites. Check the group first: ps -o " +
        "pid,user,lstart,command -g 4242. If those are the run's processes, end them with: kill " +
        `-KILL -4242. If not, mark the run over: in ${path}, set "state" to "lost".`,
    );
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("refuses on a run whose process was starting, naming no group, and keeps its record", async () => {
    const dir = await runFolder("bpng-12");
    const path = join(dir, "run.json");
    await writeRunRecord(
      path,
      startingRecord(identity("bpng-12"), "bpng", "playwright"),
    );
    const before = await readFile(path, "utf8");
    const check = await checkOrphans(stateDir, deps());
    expect(check).toEqual({
      orphans: [
        {
          taskId: "bpng",
          id: "bpng-12",
          record: path,
          confirmed: false,
          why: "its orchestrator stopped while starting its playwright process, before recording the process's group",
        },
      ],
      stale: [],
      warnings: [],
    });
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("rewrites each stale record as lost, so the next check does not read it", async () => {
    const noProcess = await running("bpng-1");
    const ended = await running("bpng-2", {
      name: "bddgen",
      pgid: 501,
      leaderStart: START,
    });
    const reused = await running("bpng-3", {
      name: "playwright",
      pgid: 502,
      leaderStart: START,
    });
    const foreign = await running("bpng-4", {
      name: "bddgen",
      pgid: 503,
      leaderStart: START,
    });
    const system = deps({
      kill: killWith([502], [503]),
      readLeaderStart: startsOf({
        502: { kind: "start", value: "ps:Wed Oct 14 01:00:00 2026" },
        503: { kind: "start", value: "ps:Wed Oct 14 02:00:00 2026" },
      }),
    });
    const check = await checkOrphans(stateDir, system);
    expect(check).toEqual({
      orphans: [],
      stale: [
        { id: "bpng-1", reason: "no process recorded", rewritten: true },
        { id: "bpng-2", reason: "process group ended", rewritten: true },
        { id: "bpng-3", reason: "leader differs", rewritten: true },
        { id: "bpng-4", reason: "leader differs", rewritten: true },
      ],
      warnings: [],
    });
    expect(await recordAt(ended)).toEqual({
      v: 1,
      state: "lost",
      id: "bpng-2",
      runId: formatRunId(STARTED, "bpng-2"),
      taskId: "bpng",
      startedAt: STARTED.toISOString(),
      process: { name: "bddgen", pgid: 501, leaderStart: START },
      foundAt: FOUND.toISOString(),
      reason: "process group ended",
    });
    for (const path of [noProcess, reused, foreign])
      expect(await recordAt(path)).toMatchObject({ state: "lost" });
    expect(await checkOrphans(stateDir, system)).toEqual({
      orphans: [],
      stale: [],
      warnings: [],
    });
  });

  test("passes over an ended run, a folder without a record yet, and a hidden folder", async () => {
    const dir = await runFolder("bpng-5");
    const event = finishedEvent();
    const ended = endedRecord(
      identity("bpng-5"),
      "bpng",
      { bddgen: { code: 0, signal: null }, stop: { level: "none" } },
      event,
    );
    await writeRunRecord(join(dir, "run.json"), ended);
    await runFolder("bpng-6");
    await mkdir(join(stateDir, "runs", ".pruning-bpng-1"));
    await writeFile(join(stateDir, "runs", ".pruning-bpng-1", "run.json"), "{");
    expect(await checkOrphans(stateDir, deps())).toEqual({
      orphans: [],
      stale: [],
      warnings: [],
    });
  });

  test("a malformed record is an unconfirmed orphan, left as it is, never a crash: nothing says its run is over", async () => {
    const texts = {
      "bpng-7": "{not json",
      "bpng-8": JSON.stringify({ v: 2, state: "running", id: "bpng-8" }),
      "bpng-9": "",
    };
    for (const [id, text] of Object.entries(texts))
      await writeFile(join(await runFolder(id), "run.json"), text);
    // A record that names another run than its folder.
    const elsewhere = join(await runFolder("bpng-10"), "run.json");
    await writeRunRecord(elsewhere, runningRecord(identity("bpng-11"), "bpng"));
    const check = await checkOrphans(stateDir, deps());
    expect(check.orphans).toEqual(
      [
        ["bpng-10", "another run's record"],
        ["bpng-7", "not JSON"],
        ["bpng-8", "not a run record this orchestrator reads"],
        ["bpng-9", "not JSON"],
      ].map(([id, why]) => ({
        id,
        record: join(stateDir, "runs", id ?? "", "run.json"),
        unread: `is not one this orchestrator reads (${why ?? ""})`,
        confirmed: false,
      })),
    );
    expect(check.stale).toEqual([]);
    expect(check.warnings).toEqual([]);
    expect(await recordAt(elsewhere)).toMatchObject({ state: "running" });
    expect(
      await readFile(join(stateDir, "runs", "bpng-7", "run.json"), "utf8"),
    ).toBe("{not json");
  });

  test("never reads through a link, nor waits on a FIFO, nor reads a huge file: each such record an unconfirmed orphan", async () => {
    // A link to a running record elsewhere: neither read nor rewritten.
    const outside = join(stateDir, "outside.json");
    await writeRunRecord(outside, runningRecord(identity("bpng-12"), "bpng"));
    await symlink(outside, join(await runFolder("bpng-12"), "run.json"));
    execFileSync("mkfifo", [join(await runFolder("bpng-13"), "run.json")]);
    await writeFile(
      join(await runFolder("bpng-14"), "run.json"),
      // 1 MiB and a byte: a literal, so a cap raised by mistake fails here.
      Buffer.alloc(1024 * 1024 + 1, 0x20),
    );
    // A link to a run folder, and a stray file.
    await symlink(
      join(stateDir, "runs", "bpng-14"),
      join(stateDir, "runs", "bpng-15"),
    );
    await writeFile(join(stateDir, "runs", "stray"), "");
    const check = await checkOrphans(stateDir, deps());
    expect(check.orphans).toEqual(
      [
        ["bpng-12", "is a symbolic link"],
        ["bpng-13", "could not be read (not a file)"],
        ["bpng-14", "is over 1048576 bytes"],
      ].map(([id, unread]) => ({
        id,
        record: join(stateDir, "runs", id ?? "", "run.json"),
        unread,
        confirmed: false,
      })),
    );
    expect(check.stale).toEqual([]);
    expect(check.warnings).toEqual([
      "bpng-15 in the runs' folder is not a folder: passed over",
      "stray in the runs' folder is not a folder: passed over",
    ]);
    expect(await recordAt(outside)).toMatchObject({ state: "running" });
  });

  test("a record it may not read is an unconfirmed orphan, listed in run-folder order among the others", async () => {
    test.skip(process.getuid?.() === 0, "root reads a file of mode 000");
    await running("bpng-1", {
      name: "playwright",
      pgid: 4242,
      leaderStart: START,
    });
    const path = join(await runFolder("bpng-2"), "run.json");
    await writeFile(path, "{}");
    await chmod(path, 0o000);
    await running("bpng-3", {
      name: "playwright",
      pgid: 4343,
      leaderStart: START,
    });
    const check = await checkOrphans(
      stateDir,
      deps({
        kill: killWith([4242, 4343]),
        readLeaderStart: startsOf({
          4242: { kind: "start", value: START },
          4343: { kind: "start", value: START },
        }),
      }),
    );
    expect(check.orphans.map(({ id }) => id)).toEqual([
      "bpng-1",
      "bpng-2",
      "bpng-3",
    ]);
    expect(check.orphans[1]).toEqual({
      id: "bpng-2",
      record: path,
      unread: "could not be read (EACCES)",
      confirmed: false,
    });
    expect(check.warnings).toEqual([]);
  });

  test("marks a record whose leader started in an earlier boot lost, whatever holds its group's number now", async () => {
    const path = await running("bpng-4", {
      name: "playwright",
      pgid: 4242,
      leaderStart: EARLIER_BOOT_START,
    });
    const check = await checkOrphans(
      stateDir,
      deps({
        kill: killWith([4242]),
        space: () => Promise.resolve(HOST_SPACE),
      }),
    );
    expect(check).toEqual({
      orphans: [],
      stale: [{ id: "bpng-4", reason: "earlier boot", rewritten: true }],
      warnings: [],
    });
    expect(await recordAt(path)).toMatchObject({
      state: "lost",
      reason: "earlier boot",
    });
  });

  test("names a folder safely in a warning", async () => {
    await mkdir(join(stateDir, "runs"));
    // A terminal code removed, a line break made a space.
    await writeFile(join(stateDir, "runs", "a\u001b[2Jb\nc"), "");
    expect((await checkOrphans(stateDir, deps())).warnings).toEqual([
      "ab c in the runs' folder is not a folder: passed over",
    ]);
  });

  test("a record that cannot be marked lost is a warning, and still reported stale", async () => {
    await running("bpng-16");
    const check = await checkOrphans(
      stateDir,
      deps({
        writeRecord: () =>
          Promise.reject(Object.assign(new Error(), { code: "ENOSPC" })),
      }),
    );
    expect(check.stale).toEqual([
      { id: "bpng-16", reason: "no process recorded", rewritten: false },
    ]);
    expect(check.warnings).toEqual([
      "run bpng-16's record could not be marked lost (ENOSPC): it is read again at the next start",
    ]);
  });

  test("throws when the runs' folder cannot be listed: no run can be shown over", async () => {
    await writeFile(join(stateDir, "runs"), "");
    await expect(checkOrphans(stateDir, deps())).rejects.toMatchObject({
      code: "ENOTDIR",
    });
  });

  test("never follows a runs' folder that is a link, nor rewrites a record through it", async () => {
    const elsewhere = join(stateDir, "elsewhere");
    await mkdir(join(elsewhere, "bpng-1"), { recursive: true });
    const path = join(elsewhere, "bpng-1", "run.json");
    await writeRunRecord(path, runningRecord(identity("bpng-1"), "bpng"));
    await symlink(elsewhere, join(stateDir, "runs"));
    await expect(checkOrphans(stateDir, deps())).rejects.toMatchObject({
      code: "ELOOP",
    });
    expect(await recordAt(path)).toMatchObject({ state: "running" });
  });

  test("passes over a running record a person marked lost, as the refusal says to", async () => {
    const path = await running("bpng-17", {
      name: "playwright",
      pgid: 4242,
      leaderStart: START,
    });
    const marked = (await readFile(path, "utf8")).replace(
      '"state": "running"',
      '"state": "lost"',
    );
    await writeFile(path, marked);
    expect(
      await checkOrphans(
        stateDir,
        deps({ kill: killWith([4242]), readLeaderStart: startsOf({}) }),
      ),
    ).toEqual({ orphans: [], stale: [], warnings: [] });
  });
});

test.describe("against real processes", () => {
  test("a live group led by its recorded process is an orphan; once it ends, stale", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000)"],
      { detached: true, stdio: "ignore" },
    );
    await once(child, "spawn");
    const pgid = child.pid ?? 0;
    try {
      const path = await running(
        "bpng-20",
        await leaderProcess("playwright", pgid, readLeaderStart),
      );
      const real = deps({
        kill: process.kill.bind(process),
        readLeaderStart,
      });
      expect((await checkOrphans(stateDir, real)).orphans).toEqual([
        { taskId: "bpng", id: "bpng-20", pgid, record: path, confirmed: true },
      ]);
      // The same group, as a record written for another process that had its number.
      const reused = await running("bpng-21", {
        name: "playwright",
        pgid,
        leaderStart: "ps:Thu Jan  1 00:00:00 1970",
      });
      const check = await checkOrphans(stateDir, real);
      expect(check.orphans.map((orphan) => orphan.id)).toEqual(["bpng-20"]);
      expect(check.stale).toEqual([
        { id: "bpng-21", reason: "leader differs", rewritten: true },
      ]);
      expect(await recordAt(reused)).toMatchObject({ state: "lost" });
      const exited = once(child, "exit");
      process.kill(-pgid, "SIGKILL");
      await exited;
      expect(await checkOrphans(stateDir, real)).toEqual({
        orphans: [],
        stale: [
          { id: "bpng-20", reason: "process group ended", rewritten: true },
        ],
        warnings: [],
      });
      expect(await recordAt(path)).toMatchObject({ state: "lost" });
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        process.kill(-pgid, "SIGKILL");
    }
  });

  test("a group whose leader exited while a member lives on is an unconfirmed orphan, never stale", async () => {
    const real = deps({ kill: process.kill.bind(process), readLeaderStart });
    let path = "";
    const { pgid, member } = await leaderlessGroup(async (id) => {
      path = await running(
        "bpng-22",
        await leaderProcess("playwright", id, readLeaderStart),
      );
    });
    try {
      expect(member).toBeGreaterThan(1);
      expect(await recordAt(path)).toMatchObject({
        process: { leaderStart: expect.any(String) },
      });
      expect(await readLeaderStart(pgid)).toEqual({ kind: "gone" });
      const before = await readFile(path, "utf8");
      expect(await checkOrphans(stateDir, real)).toEqual({
        orphans: [
          {
            taskId: "bpng",
            id: "bpng-22",
            pgid,
            record: path,
            confirmed: false,
            why: "its playwright process has exited, and the rest of its group still runs",
          },
        ],
        stale: [],
        warnings: [],
      });
      expect(await readFile(path, "utf8")).toBe(before);
      // Once the member is gone too, the run is over.
      await killGroup(pgid);
      expect((await checkOrphans(stateDir, real)).stale).toEqual([
        { id: "bpng-22", reason: "process group ended", rewritten: true },
      ]);
    } finally {
      await killGroup(pgid);
    }
  });
});

test.describe("orphanRefusal", () => {
  test("names the task, the run, its group and the command that ends it", () => {
    expect(
      orphanRefusal({
        taskId: "bpng",
        id: "bpng-12",
        pgid: 4242,
        record: "/srv/state/runs/bpng-12/run.json",
        confirmed: true,
      }),
    ).toBe(
      "Task bpng still has run bpng-12 running, in process group 4242: an orchestrator stopped " +
        "without ending it, and a second run would share its sites. End it with: kill -KILL -4242",
    );
  });

  test("an unconfirmed one says why, how to check first, and how to mark the run over", () => {
    expect(
      orphanRefusal({
        taskId: "bpng",
        id: "bpng-12",
        pgid: 4242,
        record: "/srv/my state/runs/bpng-12/run.json",
        confirmed: false,
        why: "its playwright process has exited, and the rest of its group still runs",
      }),
    ).toBe(
      "Task bpng may still have run bpng-12 running, in process group 4242 — unconfirmed: its " +
        "playwright process has exited, and the rest of its group still runs. A second run would " +
        "share its sites. Check the group first: ps -o pid,user,lstart,command -g 4242. If those " +
        "are the run's processes, end them with: kill -KILL -4242. If not, mark the run over: in " +
        `'/srv/my state/runs/bpng-12/run.json', set "state" to "lost".`,
    );
  });

  test("one with no group recorded says how to find the run's processes by its log, and how to mark it over", () => {
    expect(
      orphanRefusal({
        taskId: "bpng",
        id: "bpng-12",
        record: "/srv/my state/runs/bpng-12/run.json",
        confirmed: false,
        why: "its orchestrator stopped while starting its playwright process, before recording the process's group",
      }),
    ).toBe(
      "Task bpng may still have run bpng-12 running — unconfirmed: its orchestrator stopped while " +
        "starting its playwright process, before recording the process's group. A second run would " +
        "share its sites. Look for its processes first: lsof -- '/srv/my state/runs/bpng-12/run.log' " +
        "lists those writing its log. End each one's group with: kill -KILL -<PGID>, its PGID from: " +
        "ps -o pgid= -p <PID>. If there are none, mark the run over: in " +
        `'/srv/my state/runs/bpng-12/run.json', set "state" to "lost".`,
    );
  });

  test("one whose record cannot be read says why, how to find its processes by its log, and how to set the record aside", () => {
    expect(
      orphanRefusal({
        id: "bpng-12",
        record: "/srv/my state/runs/bpng-12/run.json",
        unread: "is a symbolic link",
        confirmed: false,
      }),
    ).toBe(
      "Run bpng-12 may still be running — unconfirmed: its record is a symbolic link, so nothing " +
        "says it is over. A second run would share its sites. Look for its processes first: lsof -- " +
        "'/srv/my state/runs/bpng-12/run.log' lists those writing its log. End each one's group " +
        "with: kill -KILL -<PGID>, its PGID from: ps -o pgid= -p <PID>. If there are none, repair " +
        "its record, or set it aside: mv '/srv/my state/runs/bpng-12/run.json' " +
        "'/srv/my state/runs/bpng-12/run.json.unread'",
    );
  });

  test("the lsof it gives lists a process writing the run's log", async () => {
    test.skip(!hasLsof(), "lsof is not installed here");
    const dir = await runFolder("bpng-12");
    const log = join(dir, "run.log");
    const handle = await open(log, "a");
    // A process of the run: its output is the run's log, as `launchRun` spawns it.
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000)"],
      {
        stdio: ["ignore", handle.fd, handle.fd],
      },
    );
    await once(child, "spawn");
    await handle.close();
    try {
      const command = /Look for its processes first: (lsof -- \S+) lists/.exec(
        orphanRefusal({
          taskId: "bpng",
          id: "bpng-12",
          record: join(dir, "run.json"),
          confirmed: false,
          why: "x",
        }),
      )?.[1];
      const [file, ...args] = (command ?? "").split(" ");
      const out = execFileSync(file ?? "", args, { encoding: "utf8" });
      const pids = out
        .trim()
        .split("\n")
        .slice(1)
        .map((line) => Number(line.trim().split(/\s+/)[1]));
      expect(pids).toContain(child.pid);
    } finally {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  });

  test("the command it gives lists exactly the group's processes, its leader gone", async () => {
    const { pgid, member } = await leaderlessGroup();
    try {
      const command = /Check the group first: (ps [^.]+)\./.exec(
        orphanRefusal({
          taskId: "bpng",
          id: "bpng-12",
          pgid,
          record: "/r",
          confirmed: false,
          why: "x",
        }),
      )?.[1];
      const [file, ...args] = (command ?? "").split(" ");
      const out = execFileSync(file ?? "", args, { encoding: "utf8" });
      const lines = out.trim().split("\n");
      expect(lines[0]).toMatch(/^\s*PID\s+USER\s+STARTED\s+COMMAND$/);
      expect(
        lines.slice(1).map((line) => Number(line.trim().split(/\s+/)[0])),
      ).toEqual([member]);
    } finally {
      await killGroup(pgid);
    }
  });
});
