import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import {
  FAKE_LINES,
  fakeCommand,
  waitForText,
  type FakeBehaviour,
} from "./__fixtures__/fake-suite";
import {
  runBegin,
  runEnd,
  scenarioEnd,
  streamOf,
} from "./__fixtures__/results";
import { RESULTS_FILE } from "../src/common/reporting/results-schema";
import type { CheckedProduct } from "./config/check";
import { loadProductList, type ProductList } from "./config/product-list";
import { runIdentity } from "./runs/identity";
import { readLeaderStart } from "./runs/leader";
import type { KillFn } from "./runs/process-group";
import { runningRecord, writeRunRecord } from "./runs/record";
import type { ShutdownSignal, ShutdownTimers } from "./runs/shutdown";
import { acquireLock } from "./state/lock";
import { runOnce } from "./tasks/cycle";
import {
  CHECKOUT,
  EXIT_WAIT_MS,
  KILL_SETTLE_MS,
  start,
  type StartDeps,
  type StartProcess,
} from "./start";

/**
 * `start` over the fake suite: real processes, real files, the signals emitted on a stand-in process —
 * then, in a child Node, real signals to a real process.
 */

/** A secret the config holds: no line shows it. */
const SECRET = "storage-Password-Of-No-Shape-0123";

/** When every run starts: the report folders are named from it. */
const T0 = new Date(2026, 9, 13, 11, 9, 41);

/** A real SSH site, for the stand-in products. */
function sshSite(
  baseURL: string,
): CheckedProduct["sites"][string]["sites"][number] {
  return {
    baseURL,
    username: "admin",
    password: "pw",
    transport: {
      mode: "ssh",
      host: "qa-lnmp",
      username: "ubuntu",
      privateKeyPath: "/k",
      rootDir: "/var/www",
    },
  };
}

/** The stand-in product list: BackWPup with two real cells. */
const PRODUCT_LIST = {
  PRODUCTS: [
    {
      name: "backwpup",
      sites: {
        "pro@nginx": { edition: "pro", sites: [sshSite("https://a.qa.test")] },
        "free@nginx": {
          edition: "free",
          sites: [sshSite("https://b.qa.test")],
        },
      },
    },
  ],
  productByName: (name: string) => ({ name }),
  playwrightConfigFor: (product: { name: string }) =>
    `playwright.${product.name}.config.ts`,
} as unknown as ProductList;

/** The two tasks: `bpng` on pro@nginx, `bfng` on free@nginx. */
const TASKS = [
  {
    id: "bpng",
    type: "loop",
    product: "backwpup",
    cell: "pro@nginx",
    cooldownMinutes: 1,
  },
  {
    id: "bfng",
    type: "loop",
    product: "backwpup",
    cell: "free@nginx",
    cooldownMinutes: 1,
  },
] as const;

/** The cell of each task. */
const CELLS: Readonly<Record<string, string>> = {
  bpng: "pro@nginx",
  bfng: "free@nginx",
};

/** A stand-in for `process.stdout`: what it was given, and a hook on each write. */
class FakeStdout {
  text = "";
  readonly writableLength = 0;
  readonly isTTY = false;
  onWrite: ((text: string) => void) | undefined;
  /** Takes a chunk at once. */
  write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean {
    const text = Buffer.from(chunk).toString("utf8");
    this.text += text;
    callback();
    this.onWrite?.(text);
    return true;
  }
  /** Never fails. */
  on(): this {
    return this;
  }
}

/** A stand-in process: signals emitted by the test, its outputs kept. */
class FakeProcess extends EventEmitter implements StartProcess {
  readonly pid = 4242;
  readonly env = { PATH: process.env.PATH };
  readonly execPath = process.execPath;
  readonly stdout = new FakeStdout();
  stderrText = "";
  readonly stderr = {
    write: (text: string): boolean => {
      this.stderrText += text;
      return true;
    },
  };
}

/** A clock the shutdown reads, moved by the test: two SIGINTs a second apart in one turn. */
class FakeClock implements ShutdownTimers {
  ms = 0;
  /** The budgets armed and neither fired nor cleared. */
  readonly armed = new Set<unknown>();
  now(): number {
    return this.ms;
  }
  setTimeout(callback: () => void, ms: number): unknown {
    const handle: NodeJS.Timeout = setTimeout(() => {
      this.armed.delete(handle);
      callback();
    }, ms).unref();
    this.armed.add(handle);
    return handle;
  }
  clearTimeout(handle: unknown): void {
    this.armed.delete(handle);
    clearTimeout(handle as NodeJS.Timeout);
  }
}

/** This process's open file descriptors. */
function openFds(): number {
  return readdirSync("/dev/fd").length;
}

/** The process's armed Node timers. */
function activeTimeouts(): number {
  return process
    .getActiveResourcesInfo()
    .filter((resource) => resource === "Timeout").length;
}

/** One spec's checkout and state directory, of its own. */
let checkout: string;
let stateDir: string;

test.beforeEach(async () => {
  checkout = await mkdtemp(join(tmpdir(), "e2e-start-"));
  stateDir = join(checkout, ".orchestrator");
  await mkdir(stateDir, { mode: 0o700 });
});

test.afterEach(async () => {
  await rm(checkout, { recursive: true, force: true });
});

/**
 * Writes the config.
 *
 * @param extra - fields replacing the defaults: both tasks, the secret.
 * @returns its path.
 */
async function writeConfig(
  extra: Record<string, unknown> = {},
): Promise<string> {
  const path = join(stateDir, "config.json");
  await writeFile(
    path,
    JSON.stringify({
      tasks: TASKS,
      secrets: { GITHUB_TOKEN: SECRET },
      ...extra,
    }),
    { mode: 0o600 },
  );
  return path;
}

/**
 * The fake runner for one task's run `number`: writes a results stream of one scenario, then exits.
 *
 * @param taskId - the task.
 * @param number - the run's number.
 * @param status - its scenario's.
 * @param behaviour - how else the fake behaves.
 */
function runner(
  taskId: string,
  number: number,
  status: "passed" | "failed",
  behaviour: FakeBehaviour = {},
): FakeBehaviour {
  const { reportDir } = runIdentity({
    taskId,
    product: "backwpup",
    cell: CELLS[taskId] ?? "",
    number,
    startedAt: T0,
    stateDir,
    checkout,
  });
  return {
    exitCode: status === "passed" ? 0 : 1,
    writes: [
      {
        path: join(reportDir, RESULTS_FILE),
        text: streamOf([
          runBegin(1),
          scenarioEnd("a", status),
          runEnd(status, { total: 1, [status]: 1 }),
        ]),
      },
    ],
    ...behaviour,
  };
}

/** What a rig's `start` was given, and its stand-ins. */
interface Rig {
  readonly proc: FakeProcess;
  readonly clock: FakeClock;
  readonly deps: StartDeps;
}

/**
 * A rig: the fake process, the shutdown's clock, the product list, the fake suite's commands.
 *
 * @param playwright - each task's runner; by default one that waits for a stop.
 * @param more - deps replacing these.
 */
function rig(
  playwright: (taskId: string) => FakeBehaviour = () => ({ runMs: 60_000 }),
  more: Partial<StartDeps> = {},
): Rig {
  const proc = new FakeProcess();
  const clock = new FakeClock();
  return {
    proc,
    clock,
    deps: {
      process: proc,
      checkout,
      loadProductList: () => Promise.resolve(PRODUCT_LIST),
      now: () => T0,
      shutdownTimers: clock,
      exitWaitMs: 1_000,
      ...more,
      loop: {
        commandsFor: (task) => ({
          bddgen: fakeCommand({ exitCode: 0 }),
          playwright: fakeCommand(playwright(task.id)),
        }),
        launchOptions: { pollMs: 20 },
        ...more.loop,
      },
    },
  };
}

/** The log's text. */
async function logText(): Promise<string> {
  return readFile(join(stateDir, "orchestrator.log"), "utf8").catch(() => "");
}

/** A run's record, as JSON. */
async function record(id: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(join(stateDir, "runs", id, "run.json"), "utf8"),
  ) as Record<string, unknown>;
}

/** A run's `run.log`. */
function runLog(id: string): string {
  return join(stateDir, "runs", id, "run.log");
}

/**
 * Asserts what every start leaves: no handler, no lock, no secret in any output.
 *
 * @param proc - the stand-in process.
 */
async function expectCleanEnd(proc: FakeProcess): Promise<void> {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    expect(proc.listenerCount(signal), signal).toBe(0);
  expect(existsSync(join(stateDir, "orchestrator.lock"))).toBe(false);
  for (const text of [await logText(), proc.stdout.text, proc.stderrText])
    expect(text).not.toContain(SECRET);
}

/**
 * Emits signals once the run's fake runner is ready, the clock moved `stepMs` between each.
 *
 * @param proc - the stand-in process.
 * @param clock - the shutdown's clock.
 * @param signals - the signals, in order.
 * @param stepMs - how far the clock moves between two.
 * @param id - the run whose runner is waited for.
 */
async function signalWhenReady(
  proc: FakeProcess,
  clock: FakeClock,
  signals: readonly ShutdownSignal[],
  stepMs = 2_000,
  id = "bpng-1",
): Promise<void> {
  await waitForText(runLog(id), FAKE_LINES.ready);
  for (const signal of signals) {
    proc.emit(signal);
    clock.ms += stepMs;
  }
}

test.describe("start — --once", () => {
  test("runs two tasks at once, exits 0 when both passed; the lock released, the handlers removed", async () => {
    const config = await writeConfig();
    const r = rig((id) =>
      runner(id, 1, "passed", { exitCode: undefined, runMs: 300 }),
    );
    const code = await start({ config, once: true }, r.deps);
    expect(code).toBe(0);
    for (const id of ["bpng-1", "bfng-1"])
      expect(await record(id)).toMatchObject({
        state: "ended",
        status: "passed",
      });
    const log = await logText();
    // Both started before either ended: the loops run at once.
    const lines = log.split("\n");
    const firstOutcome = lines.findIndex((line) =>
      line.includes("-1 ✔ passed"),
    );
    expect(firstOutcome).toBeGreaterThan(0);
    expect(
      lines
        .slice(0, firstOutcome)
        .filter((line) => / b[pf]ng-1 started /.test(line)),
    ).toHaveLength(2);
    expect(log).toContain(
      "orchestrator  started · 2 tasks (bpng, bfng) · once · .orchestrator/ · pid 4242",
    );
    expect(log).toContain("orchestrator  exiting 0");
    expect(r.proc.stdout.text).toContain("exiting 0");
    await expectCleanEnd(r.proc);
  });

  test("exits 1 when one run failed", async () => {
    const config = await writeConfig();
    const r = rig((id) => runner(id, 1, id === "bfng" ? "failed" : "passed"));
    expect(await start({ config, once: true }, r.deps)).toBe(1);
    expect(await record("bfng-1")).toMatchObject({ status: "failed" });
    await expectCleanEnd(r.proc);
  });

  test("--task runs only the tasks it names, once each", async () => {
    const config = await writeConfig();
    const r = rig((id) => runner(id, 1, "passed"));
    expect(
      await start({ config, once: true, tasks: ["bfng", "bfng"] }, r.deps),
    ).toBe(0);
    expect(existsSync(join(stateDir, "runs", "bfng-1"))).toBe(true);
    expect(existsSync(join(stateDir, "runs", "bpng-1"))).toBe(false);
    expect(await logText()).toContain("started · 1 task (bfng) · once");
    await expectCleanEnd(r.proc);
  });

  test("a SIGINT once its --once loop has ended, while the run's announcement is in flight, exits 130", async () => {
    const config = await writeConfig({
      notifications: {
        slack: {
          webhookUrl:
            "https://hooks.slack.com/services/T0/B0/webhook-token-123",
        },
      },
    });
    // The run's own handle, watched: once it settles, its --once loop ends a few microtasks later.
    const box: { settled?: boolean; signalledAfter?: boolean } = {};
    const r = rig((id) => runner(id, 1, "passed"), {
      notifications: {
        // Slack answers late: the loop has ended by then, and a SIGINT comes while the bus settles.
        fetch: async () => {
          await expect.poll(() => box.settled, { timeout: 5_000 }).toBe(true);
          await delay(50);
          box.signalledAfter = true;
          r.proc.emit("SIGINT");
          return new Response("ok", { status: 200 });
        },
      },
    });
    const deps: StartDeps = {
      ...r.deps,
      loop: {
        ...r.deps.loop,
        runOnce: (task, cycleDeps) => {
          const run = runOnce(task, cycleDeps);
          return {
            stop: (level, why) => {
              run.stop(level, why);
            },
            done: run.done.then((result) => {
              box.settled = true;
              return result;
            }),
          };
        },
      },
    };
    expect(await start({ config, once: true, tasks: ["bpng"] }, deps)).toBe(
      130,
    );
    expect(box.signalledAfter).toBe(true);
    expect(await record("bpng-1")).toMatchObject({ status: "passed" });
    const log = await logText();
    expect(log).toContain("bpng  slack ✓");
    expect(log).not.toContain("no next run");
    await expectCleanEnd(r.proc);
  });
});

test.describe("start — refusals", () => {
  test("a config error exits 1, says why on standard error, and takes no lock", async () => {
    const r = rig();
    const code = await start(
      { config: join(stateDir, "missing.json") },
      r.deps,
    );
    expect(code).toBe(1);
    expect(r.proc.stderrText).toContain(
      "orchestrator: not started: No orchestrator config at",
    );
    expect(existsSync(join(stateDir, "orchestrator.log"))).toBe(false);
    await expectCleanEnd(r.proc);
  });

  test("a product list that cannot load is a config error: exit 1", async () => {
    const config = await writeConfig();
    const r = rig(undefined, {
      loadProductList: () =>
        loadProductList(() => Promise.reject(new Error("[sites] broken"))),
    });
    expect(await start({ config }, r.deps)).toBe(1);
    expect(r.proc.stderrText).toContain(
      "The product list could not be loaded: [sites] broken",
    );
    await expectCleanEnd(r.proc);
  });

  test("an unknown --task exits 1 naming it and the config's tasks; nothing runs", async () => {
    const config = await writeConfig();
    const r = rig();
    expect(await start({ config, tasks: ["bpng", "zzzz"] }, r.deps)).toBe(1);
    expect(r.proc.stderrText).toContain("--task names no task of");
    expect(r.proc.stderrText).toContain('"zzzz"; its tasks: bpng, bfng');
    expect(existsSync(join(stateDir, "runs"))).toBe(false);
    await expectCleanEnd(r.proc);
  });

  test("a lock held by another start is refused: exit 1, its lock left alone, nothing runs", async () => {
    const config = await writeConfig();
    const held = await acquireLock(stateDir);
    try {
      const r = rig();
      expect(await start({ config }, r.deps)).toBe(1);
      expect(r.proc.stderrText).toContain("orchestrator.lock");
      expect(existsSync(join(stateDir, "orchestrator.lock"))).toBe(true);
      expect(existsSync(join(stateDir, "runs"))).toBe(false);
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
        expect(r.proc.listenerCount(signal)).toBe(0);
    } finally {
      await held.release();
    }
  });

  test("an orphan of any task, selected or not, refuses the start: exit 1, the lock released", async () => {
    const config = await writeConfig();
    const identity = runIdentity({
      taskId: "bfng",
      product: "backwpup",
      cell: "free@nginx",
      number: 3,
      startedAt: T0,
      stateDir,
      checkout,
    });
    await mkdir(identity.dir, { recursive: true, mode: 0o700 });
    await writeRunRecord(
      identity.record,
      runningRecord(identity, "bfng", {
        name: "playwright",
        pgid: 4343,
        leaderStart: "start-of-4343",
      }),
    );
    const r = rig(undefined, {
      orphans: {
        // Group 4343 alive, its leader the run's.
        kill: () => undefined,
        readLeaderStart: () =>
          Promise.resolve({ kind: "start", value: "start-of-4343" }),
      },
    });
    expect(await start({ config, tasks: ["bpng"] }, r.deps)).toBe(1);
    const log = await logText();
    expect(log).toContain(
      "Task bfng still has run bfng-3 running, in process group 4343",
    );
    expect(log).toContain("kill -KILL -4343");
    expect(log).toContain("exiting 1");
    expect(existsSync(join(stateDir, "runs", "bpng-1"))).toBe(false);
    await expectCleanEnd(r.proc);
  });

  test("a stale record is marked lost, said, and the start goes on", async () => {
    const config = await writeConfig();
    const identity = runIdentity({
      taskId: "bpng",
      product: "backwpup",
      cell: "pro@nginx",
      number: 7,
      startedAt: T0,
      stateDir,
      checkout,
    });
    await mkdir(identity.dir, { recursive: true, mode: 0o700 });
    await writeRunRecord(identity.record, runningRecord(identity, "bpng"));
    const r = rig((id) => runner(id, 8, "passed"));
    expect(await start({ config, once: true, tasks: ["bpng"] }, r.deps)).toBe(
      0,
    );
    expect(await logText()).toContain(
      "run bpng-7 was left running and found over (no process recorded): marked lost",
    );
    expect(await record("bpng-7")).toMatchObject({ state: "lost" });
    expect(await record("bpng-8")).toMatchObject({ status: "passed" });
    await expectCleanEnd(r.proc);
  });

  test("a log that cannot be opened exits 1, the lock released", async () => {
    const config = await writeConfig();
    await mkdir(join(stateDir, "orchestrator.log"));
    const r = rig();
    expect(await start({ config }, r.deps)).toBe(1);
    expect(r.proc.stderrText).toContain("not started:");
    await expectCleanEnd(r.proc);
  });

  test("runs' records that cannot be checked refuse the start: exit 1, the lock released", async () => {
    const config = await writeConfig();
    await mkdir(join(checkout, "elsewhere"));
    await symlink(join(checkout, "elsewhere"), join(stateDir, "runs"));
    const r = rig();
    expect(await start({ config }, r.deps)).toBe(1);
    expect(await logText()).toContain(
      "not started: the runs' records could not be checked",
    );
    await expectCleanEnd(r.proc);
  });

  test("a state directory others may write in refuses the lock: exit 1", async () => {
    const config = await writeConfig();
    await chmod(stateDir, 0o777);
    const r = rig();
    expect(await start({ config }, r.deps)).toBe(1);
    expect(r.proc.stderrText).toContain("no one else may write in it");
    await chmod(stateDir, 0o700);
    await expectCleanEnd(r.proc);
  });
});

test.describe("start — stopping", () => {
  test("one SIGINT drains every run and ends every loop: 130, both runs stopped", async () => {
    const config = await writeConfig();
    const r = rig();
    const started = start({ config }, r.deps);
    await waitForText(runLog("bfng-1"), FAKE_LINES.ready);
    await signalWhenReady(r.proc, r.clock, ["SIGINT"]);
    expect(await started).toBe(130);
    for (const id of ["bpng-1", "bfng-1"]) {
      expect(await readFile(runLog(id), "utf8")).toContain(FAKE_LINES.drained);
      expect(await record(id)).toMatchObject({
        state: "ended",
        status: "stopped",
      });
    }
    const log = await logText();
    expect(log).toContain(
      "stopping: the orchestrator was stopped (SIGINT) — no new run",
    );
    expect(log).toContain(
      "bpng  no next run: the orchestrator was stopped (SIGINT)",
    );
    expect(log).toContain(
      "bfng  no next run: the orchestrator was stopped (SIGINT)",
    );
    expect(log).not.toContain("next run 1");
    await expectCleanEnd(r.proc);
  });

  test("a parent that ends drains as a SIGHUP: said, every run stopped, 130; the watch is gone", async () => {
    const config = await writeConfig({ tasks: [TASKS[0]] });
    let parent = 100;
    const reads: number[] = [];
    const r = rig(undefined, {
      parentWatch: {
        parentPid: () => {
          reads.push(parent);
          return parent;
        },
        intervalMs: 20,
      },
    });
    const timeoutsBefore = activeTimeouts();
    const started = start({ config }, r.deps);
    await waitForText(runLog("bpng-1"), FAKE_LINES.ready);
    // An unchanged parent changes nothing.
    await delay(100);
    expect(await logText()).not.toContain("stopping");
    parent = 1;
    expect(await started).toBe(130);
    expect(await record("bpng-1")).toMatchObject({ status: "stopped" });
    const log = await logText();
    expect(log).toContain(
      "the parent process 100 ended (now 1): stopping as on a hangup",
    );
    expect(log).toContain("stopping: the orchestrator was stopped (SIGHUP)");
    expect(log.match(/ stopping: /g)).toHaveLength(1);
    // Read until it changed, then no more: the watch stopped itself, and start left no timer.
    const count = reads.length;
    await delay(100);
    expect(reads.length).toBe(count);
    expect(activeTimeouts()).toBeLessThanOrEqual(timeoutsBefore);
    await expectCleanEnd(r.proc);
  });

  test("a parent that ends while a run drains slowly is said once: the watch stops as it fires", async () => {
    const config = await writeConfig({ tasks: [TASKS[0]] });
    let parent = 100;
    // The run ignores the drain and ends on its own 600 ms in: the watch would fire ~30 times more.
    const r = rig(() => ({ runMs: 600, ignoreDrain: true }), {
      parentWatch: { parentPid: () => parent, intervalMs: 20 },
    });
    const started = start({ config }, r.deps);
    await waitForText(runLog("bpng-1"), FAKE_LINES.ready);
    parent = 1;
    expect(await started).toBe(130);
    const log = await logText();
    expect(log.match(/the parent process 100 ended/g)).toHaveLength(1);
    expect(log.match(/ stopping: /g)).toHaveLength(1);
    await expectCleanEnd(r.proc);
  });

  test("a reparent to a subreaper, not PID 1, is the parent ending too", async () => {
    const config = await writeConfig({ tasks: [TASKS[0]] });
    let parent = 100;
    const r = rig(undefined, {
      parentWatch: { parentPid: () => parent, intervalMs: 20 },
    });
    const started = start({ config }, r.deps);
    await waitForText(runLog("bpng-1"), FAKE_LINES.ready);
    parent = 4321;
    expect(await started).toBe(130);
    expect(await logText()).toContain(
      "the parent process 100 ended (now 4321): stopping as on a hangup",
    );
    await expectCleanEnd(r.proc);
  });

  test("the parent watch is gone once start returns, its parent unchanged", async () => {
    const config = await writeConfig({ tasks: [TASKS[0]] });
    let reads = 0;
    const r = rig(
      (id) => runner(id, 1, "passed", { exitCode: undefined, runMs: 200 }),
      {
        parentWatch: {
          parentPid: () => {
            reads += 1;
            return 7;
          },
          intervalMs: 20,
        },
      },
    );
    expect(await start({ config, once: true }, r.deps)).toBe(0);
    const count = reads;
    expect(count).toBeGreaterThan(1);
    await delay(100);
    expect(reads).toBe(count);
  });

  test("two SIGINTs within a second count as one: the run is drained, not interrupted", async () => {
    const config = await writeConfig();
    const r = rig();
    const started = start({ config, tasks: ["bpng"] }, r.deps);
    await signalWhenReady(r.proc, r.clock, ["SIGINT", "SIGINT"], 5);
    expect(await started).toBe(130);
    const out = await readFile(runLog("bpng-1"), "utf8");
    expect(out).toContain(FAKE_LINES.drained);
    expect(out).not.toContain(FAKE_LINES.sigint);
    expect(await logText()).not.toContain("interrupting");
  });

  test("two SIGINTs interrupt every run: one SIGINT reaches the runner", async () => {
    const config = await writeConfig();
    const r = rig();
    const started = start({ config, tasks: ["bpng"] }, r.deps);
    await signalWhenReady(r.proc, r.clock, ["SIGINT", "SIGINT"]);
    expect(await started).toBe(130);
    const log = await logText();
    expect(log).toContain(
      "interrupting every run: the orchestrator was stopped (SIGINT); interrupted: a SIGINT while draining",
    );
    expect(log).not.toContain("killing");
    expect(await record("bpng-1")).toMatchObject({ status: "stopped" });
    await expectCleanEnd(r.proc);
  });

  test("three SIGINTs kill every run: its group SIGKILLed, the run killed", async () => {
    const config = await writeConfig();
    const r = rig(() => ({ runMs: 60_000, ignoreSigint: true }));
    const started = start({ config, tasks: ["bpng"] }, r.deps);
    await signalWhenReady(r.proc, r.clock, ["SIGINT", "SIGINT", "SIGINT"]);
    expect(await started).toBe(130);
    const log = await logText();
    expect(log).toContain(
      "killing every run: the orchestrator was stopped (SIGINT); killed: a SIGINT while interrupting",
    );
    expect(await record("bpng-1")).toMatchObject({ status: "killed" });
    await expectCleanEnd(r.proc);
  });

  test("an ignored interrupt is escalated to a kill by the interrupt budget, never given up on before the kill", async () => {
    const config = await writeConfig();
    const r = rig(
      () => ({ runMs: 60_000, ignoreSigint: true, ignoreDrain: true }),
      {
        budgets: { drainMs: 60_000, interruptMs: 400, debounceMs: 1_000 },
        killSettleMs: 400,
      },
    );
    const started = start({ config, tasks: ["bpng"] }, r.deps);
    await signalWhenReady(r.proc, r.clock, ["SIGINT", "SIGINT"]);
    expect(await started).toBe(130);
    const log = await logText();
    expect(log).toContain("killed: the interrupt took over 0 s");
    expect(log).not.toContain("stopped waiting");
    expect(await record("bpng-1")).toMatchObject({ status: "killed" });
    await expectCleanEnd(r.proc);
  });

  test("SIGTERM drains, as the first SIGINT; a SIGHUP after it changes nothing", async () => {
    const config = await writeConfig();
    const r = rig();
    const started = start({ config, tasks: ["bpng"] }, r.deps);
    await signalWhenReady(r.proc, r.clock, ["SIGTERM", "SIGHUP"]);
    expect(await started).toBe(130);
    const log = await logText();
    expect(log).toContain("stopping: the orchestrator was stopped (SIGTERM)");
    expect(log).not.toContain("interrupting");
    expect(await record("bpng-1")).toMatchObject({ status: "stopped" });
    await expectCleanEnd(r.proc);
  });

  test("a stop in the cooldown ends the loop at once: no next run", async () => {
    const config = await writeConfig();
    const r = rig((id) => runner(id, 1, "passed"));
    r.proc.stdout.onWrite = (text) => {
      if (text.includes("next run")) setImmediate(() => r.proc.emit("SIGINT"));
    };
    expect(await start({ config, tasks: ["bpng"] }, r.deps)).toBe(130);
    const log = await logText();
    expect(log).toContain("bpng  next run");
    expect(existsSync(join(stateDir, "runs", "bpng-2"))).toBe(false);
    await expectCleanEnd(r.proc);
  });

  test("a signal before any run starts none: 130, the lock released", async () => {
    const config = await writeConfig();
    const r = rig();
    const started = start({ config }, r.deps);
    r.proc.emit("SIGINT");
    expect(await started).toBe(130);
    expect(await logText()).toContain("stopped before any run started");
    expect(existsSync(join(stateDir, "runs"))).toBe(false);
    await expectCleanEnd(r.proc);
  });

  test("a run whose group has ended but whose loop never settles is named without a kill command", async () => {
    const config = await writeConfig();
    // Once SIGKILLed, the launch is told the group never empties, though it has: the loop is stuck.
    const box = { free: false };
    const killed = new Set<number>();
    const kill: KillFn = (pid, signal) => {
      if (signal === 0 && killed.has(pid) && !box.free) return;
      if (signal === "SIGKILL") killed.add(pid);
      process.kill(pid, signal);
    };
    const r = rig(() => ({ runMs: 60_000, ignoreSigint: true }), {
      killSettleMs: 300,
      loop: { launchOptions: { pollMs: 20, kill } },
    });
    const started = start({ config, tasks: ["bpng"] }, r.deps);
    await signalWhenReady(r.proc, r.clock, ["SIGINT", "SIGINT", "SIGINT"]);
    expect(await started).toBe(130);
    const log = await logText();
    expect(log).toContain(
      "stopped waiting: bpng did not end within 300 ms of the kill",
    );
    expect(log).toContain(
      "bpng  bpng-1 left nothing to kill (process group ended): its loop is stuck after its processes",
    );
    expect(log).not.toContain("kill -KILL");
    await expectCleanEnd(r.proc);
    box.free = true;
    await expect
      .poll(async () => (await record("bpng-1")).state, { timeout: 10_000 })
      .toBe("ended");
  });

  test("a stuck run whose group lives, led by its own process, is named with its kill command; another task's loop that ended, and an earlier orchestrator's stale run, are not", async () => {
    const config = await writeConfig();
    // An earlier orchestrator's run, found over (its group is another process's now) but not markable
    // lost: its folder is read-only. Its record still says running.
    const sleeper = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)"],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    const stale = runIdentity({
      taskId: "bpng",
      product: "backwpup",
      cell: "pro@nginx",
      number: 5,
      startedAt: T0,
      stateDir,
      checkout,
    });
    await mkdir(stale.dir, { recursive: true, mode: 0o700 });
    await writeRunRecord(
      stale.record,
      runningRecord(stale, "bpng", {
        name: "playwright",
        pgid: sleeper.pid ?? 0,
        leaderStart: "a-start-that-is-not-its",
      }),
    );
    await chmod(stale.dir, 0o500);
    // A stuck task's folder this start never made, its record unreadable: the orphan check warns once;
    // the give-up, which says only the runs it began, never again.
    await mkdir(join(stateDir, "runs", "bpng-4"), { mode: 0o700 });
    await writeFile(join(stateDir, "runs", "bpng-4", "run.json"), "{");
    // SIGKILL never reaches bpng's group: it lives on, unkillable as a root `sudo` child would be.
    const box = { free: false };
    const kill: KillFn = (pid, signal) => {
      if (signal === "SIGKILL" && !box.free) return;
      process.kill(pid, signal);
    };
    const r = rig(
      (id) =>
        id === "bpng"
          ? { runMs: 60_000, ignoreSigint: true, ignoreDrain: true }
          : runner(id, 1, "passed"),
      { killSettleMs: 300, loop: { launchOptions: { pollMs: 20, kill } } },
    );
    try {
      const started = start({ config }, r.deps);
      await expect.poll(logText).toContain("bfng  next run");
      // bfng's loop is cooling down; its run's record is forced back to `running`, its group a live
      // process's whose start matches: only the stuck tasks' runs may be named.
      const finished = runIdentity({
        taskId: "bfng",
        product: "backwpup",
        cell: "free@nginx",
        number: 1,
        startedAt: T0,
        stateDir,
        checkout,
      });
      const live = await readLeaderStart(sleeper.pid ?? 0);
      await writeRunRecord(
        finished.record,
        runningRecord(finished, "bfng", {
          name: "playwright",
          pgid: sleeper.pid ?? 0,
          leaderStart: live.kind === "start" ? live.value : "unread",
        }),
      );
      await signalWhenReady(
        r.proc,
        r.clock,
        ["SIGINT", "SIGINT", "SIGINT"],
        2_000,
        "bpng-6",
      );
      expect(await started).toBe(130);
      const pgid = String(
        ((await record("bpng-6")) as { process: { pgid: number } }).process
          .pgid,
      );
      const log = await logText();
      expect(log).toContain(
        "run bpng-5 was left running and found over (leader differs): not marked lost",
      );
      expect(log).toContain(
        "stopped waiting: bpng did not end within 300 ms of the kill",
      );
      expect(log).toContain(
        `bpng  bpng-6 left behind, still running in process group ${pgid}: end it with kill -KILL -${pgid}`,
      );
      expect(log).not.toContain("bpng-5 left");
      expect(log).not.toContain(`-KILL -${String(sleeper.pid)}`);
      expect(log).not.toContain("bfng  its loop did not end");
      expect(log).not.toContain("bfng-1 left");
      expect(log).not.toContain("bfng-1 may be left");
      expect(log).not.toContain(
        "bpng  its loop did not end, and no run of it is recorded running",
      );
      expect(
        log.split("run bpng-4's record is not one this orchestrator reads")
          .length - 1,
      ).toBe(1);
      await expectCleanEnd(r.proc);
    } finally {
      box.free = true;
      const pgid = (
        (await record("bpng-6").catch(() => ({}))) as {
          process?: { pgid: number };
        }
      ).process?.pgid;
      if (pgid !== undefined) process.kill(-pgid, "SIGKILL");
      sleeper.kill("SIGKILL");
      await chmod(stale.dir, 0o700);
    }
    await expect
      .poll(async () => (await record("bpng-6")).state, { timeout: 10_000 })
      .toBe("ended");
  });

  test("a finished task's run whose record cannot be read is not said at the give-up: only the stuck tasks' are", async () => {
    const config = await writeConfig();
    const box = { free: false };
    const killed = new Set<number>();
    const kill: KillFn = (pid, signal) => {
      if (signal === 0 && killed.has(pid) && !box.free) return;
      if (signal === "SIGKILL") killed.add(pid);
      process.kill(pid, signal);
    };
    const r = rig(
      (id) =>
        id === "bpng"
          ? { runMs: 60_000, ignoreSigint: true }
          : runner(id, 1, "passed"),
      { killSettleMs: 300, loop: { launchOptions: { pollMs: 20, kill } } },
    );
    const started = start({ config }, r.deps);
    await expect.poll(logText).toContain("bfng  next run");
    await writeFile(join(stateDir, "runs", "bfng-1", "run.json"), "{");
    await signalWhenReady(r.proc, r.clock, ["SIGINT", "SIGINT", "SIGINT"]);
    expect(await started).toBe(130);
    const log = await logText();
    expect(log).toContain("stopped waiting: bpng did not end");
    expect(log).not.toContain("run bfng-1's record");
    await expectCleanEnd(r.proc);
    box.free = true;
    await expect
      .poll(async () => (await record("bpng-1")).state, { timeout: 10_000 })
      .toBe("ended");
  });

  test("a loop stuck with no run recorded running says so", async () => {
    const config = await writeConfig({ tasks: [TASKS[0]] });
    const r = rig(undefined, {
      killSettleMs: 100,
      loop: {
        runOnce: () => ({
          stop: () => undefined,
          done: new Promise(() => undefined),
        }),
      },
    });
    const started = start({ config }, r.deps);
    await expect.poll(logText).toContain("started · 1 task");
    for (const _ of [1, 2, 3]) {
      r.proc.emit("SIGINT");
      r.clock.ms += 2_000;
    }
    expect(await started).toBe(130);
    expect(await logText()).toContain(
      "bpng  its loop did not end, and no run of it is recorded running",
    );
    await expectCleanEnd(r.proc);
  });

  test("a stuck run's record that cannot be read is said, and the run is not named", async () => {
    const config = await writeConfig({ tasks: [TASKS[0]] });
    const box = { free: false };
    const killed = new Set<number>();
    const kill: KillFn = (pid, signal) => {
      if (signal === 0 && killed.has(pid) && !box.free) return;
      if (signal === "SIGKILL") killed.add(pid);
      process.kill(pid, signal);
    };
    const r = rig(() => ({ runMs: 60_000, ignoreSigint: true }), {
      killSettleMs: 300,
      loop: { launchOptions: { pollMs: 20, kill } },
    });
    const started = start({ config }, r.deps);
    await signalWhenReady(r.proc, r.clock, ["SIGINT", "SIGINT", "SIGINT"]);
    await writeFile(join(stateDir, "runs", "bpng-1", "run.json"), "{");
    expect(await started).toBe(130);
    const log = await logText();
    expect(log).toContain(
      "run bpng-1's record is not one this orchestrator reads (not JSON): passed over",
    );
    expect(log).toContain(
      "bpng  its loop did not end, and no run of it is recorded running",
    );
    await expectCleanEnd(r.proc);
    box.free = true;
    await expect
      .poll(
        async () =>
          (await record("bpng-1").catch((): Record<string, unknown> => ({})))
            .state,
        {
          timeout: 10_000,
        },
      )
      .toBe("ended");
  });
});

test.describe("start — what it hands on and leaves", () => {
  test("the runs get the suite's own commands: this Node, the checkout's scripts, the product's config, the filter", async () => {
    const config = await writeConfig({
      tasks: [{ ...TASKS[0], grep: "@smoke" }],
    });
    const seen: unknown[] = [];
    const r = rig(undefined, {
      loop: {
        runOnce: (task, deps) => {
          seen.push(deps.commandsFor(task), deps.inherited, deps.secrets);
          return {
            stop: () => undefined,
            done: Promise.resolve({ kind: "notStarted", why: "failed" }),
          };
        },
      },
    });
    const { commandsFor: _, ...loop } = r.deps.loop ?? {};
    expect(
      await start(
        { config, once: true },
        { ...r.deps, loop: { ...loop, runOnce: r.deps.loop?.runOnce } },
      ),
    ).toBe(1);
    expect(seen).toEqual([
      {
        bddgen: {
          file: process.execPath,
          args: [
            join(
              checkout,
              "node_modules",
              "playwright-bdd",
              "dist",
              "cli",
              "index.js",
            ),
            "--config",
            "playwright.backwpup.config.ts",
          ],
        },
        playwright: {
          file: process.execPath,
          args: [
            join(checkout, "node_modules", "@playwright", "test", "cli.js"),
            "test",
            "--config",
            "playwright.backwpup.config.ts",
            "--grep=@smoke",
          ],
        },
      },
      r.proc.env,
      // The config's secrets, then its sites' credentials (the stand-in sites' password).
      [SECRET, "pw"],
    ]);
    await expectCleanEnd(r.proc);
  });

  test("every line is masked by the config's secrets: a warning quoting a path that holds one", async () => {
    // The checkout's own path holds the secret, and the config is mode 0644: its warning quotes it.
    const secretDir = join(checkout, SECRET);
    await mkdir(secretDir, { mode: 0o700 });
    stateDir = secretDir;
    const config = await writeConfig({ tasks: [TASKS[0]] });
    await chmod(config, 0o644);
    const r = rig((id) => runner(id, 1, "passed"));
    expect(await start({ config, once: true }, r.deps)).toBe(0);
    const log = await logText();
    expect(log).toContain("chmod 600");
    expect(log).not.toContain(SECRET);
    expect(r.proc.stdout.text).not.toContain(SECRET);
    await expectCleanEnd(r.proc);
  });

  test("a site's credentials are masked like the config's: in the log, the terminal, a run's lines and standard error", async () => {
    const sitePassword = "site-Password-Of-No-Shape-4567";
    const list = {
      ...PRODUCT_LIST,
      PRODUCTS: [
        {
          name: "backwpup",
          sites: {
            "pro@nginx": {
              edition: "pro",
              sites: [
                { ...sshSite("https://a.qa.test"), password: sitePassword },
              ],
            },
          },
        },
      ],
    } as unknown as ProductList;
    // The state directory's path holds it: the config's mode warning and each run's lines quote it.
    stateDir = join(checkout, sitePassword);
    await mkdir(stateDir, { mode: 0o700 });
    const config = await writeConfig({ tasks: [TASKS[0]] });
    await chmod(config, 0o644);
    const r = rig((id) => runner(id, 1, "passed"), {
      loadProductList: () => Promise.resolve(list),
    });
    expect(await start({ config, once: true }, r.deps)).toBe(0);
    const log = await logText();
    expect(log).toContain("chmod 600");
    expect(log).toContain("bpng-1 started");
    for (const text of [log, r.proc.stdout.text])
      expect(text).not.toContain(sitePassword);
    // Refused on standard error, before the log: masked there too.
    const held = await acquireLock(stateDir);
    try {
      const refused = rig(undefined, {
        loadProductList: () => Promise.resolve(list),
      });
      expect(await start({ config }, refused.deps)).toBe(1);
      expect(refused.proc.stderrText).toContain("orchestrator.lock");
      expect(refused.proc.stderrText).not.toContain(sitePassword);
    } finally {
      await held.release();
    }
    await expectCleanEnd(r.proc);
  });

  test("a run's Datator record is kept beside it, the very one posted", async () => {
    const config = await writeConfig({
      tasks: [TASKS[0]],
      notifications: {
        datator: {
          url: "https://datator.example.org/e2e/",
          apiKey: "datator-key-0123456789",
        },
      },
    });
    const posted: string[] = [];
    const r = rig((id) => runner(id, 1, "passed"), {
      notifications: {
        fetch: (_url, init) => {
          posted.push(typeof init?.body === "string" ? init.body : "");
          return Promise.resolve(new Response("{}", { status: 201 }));
        },
      },
    });
    expect(await start({ config, once: true }, r.deps)).toBe(0);
    const kept = await readFile(
      join(stateDir, "runs", "bpng-1", "datator.json"),
      "utf8",
    );
    expect(posted).toHaveLength(1);
    expect(JSON.parse(kept)).toEqual(JSON.parse(posted[0] ?? ""));
    expect(await logText()).toContain("bpng  datator ✓ 201");
    await expectCleanEnd(r.proc);
  });

  test("standard output is made non-blocking when it is a terminal, once start runs", async () => {
    const config = await writeConfig({ tasks: [TASKS[0]] });
    const r = rig((id) => runner(id, 1, "passed"));
    const blocking: boolean[] = [];
    Object.assign(r.proc.stdout, {
      isTTY: true,
      _handle: {
        setBlocking: (value: boolean): number => {
          blocking.push(value);
          return 0;
        },
      },
    });
    expect(blocking).toEqual([]);
    expect(await start({ config, once: true }, r.deps)).toBe(0);
    expect(blocking).toEqual([false]);
  });

  test("it returns only once the terminal has taken what was written, within the exit's bound", async () => {
    const config = await writeConfig({ tasks: [TASKS[0]] });
    const r = rig((id) => runner(id, 1, "passed"));
    // The terminal takes its queue 150 ms after the last write.
    const queue = { until: 0 };
    r.proc.stdout.onWrite = () => {
      queue.until = Date.now() + 150;
    };
    Object.defineProperty(r.proc.stdout, "writableLength", {
      get: () => (Date.now() < queue.until ? 1 : 0),
    });
    expect(await start({ config, once: true }, r.deps)).toBe(0);
    expect(Date.now()).toBeGreaterThanOrEqual(queue.until);
  });

  test("its terminal is waited for even once the log gave up on it: what else was written is taken", async () => {
    const config = await writeConfig({ tasks: [TASKS[0]] });
    const r = rig((id) => runner(id, 1, "passed"));
    // Every write fails, so the log stops writing to it at once; its queue empties 150 ms after that.
    const queue = { until: 0 };
    Object.assign(r.proc.stdout, {
      write: (_chunk: Uint8Array, callback: (error?: Error | null) => void) => {
        if (queue.until === 0) queue.until = Date.now() + 150;
        callback(Object.assign(new Error("EIO"), { code: "EIO" }));
        return true;
      },
    });
    Object.defineProperty(r.proc.stdout, "writableLength", {
      get: () => (queue.until === 0 || Date.now() < queue.until ? 1 : 0),
    });
    expect(await start({ config, once: true }, r.deps)).toBe(0);
    expect(queue.until).toBeGreaterThan(0);
    expect(Date.now()).toBeGreaterThanOrEqual(queue.until);
  });

  test("the log's file is closed and the shutdown's budget disarmed once it returns", async () => {
    const config = await writeConfig({ tasks: [TASKS[0]] });
    const before = openFds();
    const r = rig();
    const started = start({ config }, r.deps);
    await signalWhenReady(r.proc, r.clock, ["SIGINT"]);
    expect(await started).toBe(130);
    // The drain's 15-minute budget was armed by the SIGINT: it must not outlive the start.
    expect(r.clock.armed.size).toBe(0);
    for (let tries = 0; tries < 100 && openFds() > before; tries += 1)
      await delay(20);
    expect(openFds()).toBeLessThanOrEqual(before);
  });

  test("no timer is left armed once it returns, the wait after a kill's included", async () => {
    const config = await writeConfig({ tasks: [TASKS[0]] });
    const before = activeTimeouts();
    const r = rig(() => ({ runMs: 60_000, ignoreSigint: true }), {
      shutdownTimers: undefined,
    });
    const started = start({ config }, { ...r.deps, shutdownTimers: r.clock });
    await signalWhenReady(r.proc, r.clock, ["SIGINT", "SIGINT", "SIGINT"]);
    expect(await started).toBe(130);
    expect(await record("bpng-1")).toMatchObject({ status: "killed" });
    // Polled by hand: `expect.poll` arms timers of its own.
    for (let tries = 0; tries < 100 && activeTimeouts() > before; tries += 1)
      await delay(20);
    expect(activeTimeouts()).toBeLessThanOrEqual(before);
  });
});

test.describe("start — what it says about itself", () => {
  test("a lock refusal on standard error masks the config's secrets", async () => {
    stateDir = join(checkout, SECRET);
    await mkdir(stateDir, { mode: 0o700 });
    const config = await writeConfig();
    const held = await acquireLock(stateDir);
    try {
      const r = rig();
      expect(await start({ config }, r.deps)).toBe(1);
      expect(r.proc.stderrText).toContain("orchestrator: not started:");
      expect(r.proc.stderrText).toContain("orchestrator.lock");
      expect(r.proc.stderrText).not.toContain(SECRET);
    } finally {
      await held.release();
    }
  });

  test("a log that cannot be opened is refused on standard error, its path's secret masked", async () => {
    stateDir = join(checkout, SECRET);
    await mkdir(stateDir, { mode: 0o700 });
    const config = await writeConfig();
    await mkdir(join(stateDir, "orchestrator.log"));
    const r = rig();
    expect(await start({ config }, r.deps)).toBe(1);
    expect(r.proc.stderrText).toContain("orchestrator: not started:");
    expect(r.proc.stderrText).toContain("orchestrator.log");
    await expectCleanEnd(r.proc);
  });

  test("a signal before the log is open is said on standard error", async () => {
    const config = await writeConfig();
    const r = rig();
    const started = start({ config }, r.deps);
    r.proc.emit("SIGTERM");
    expect(await started).toBe(130);
    expect(r.proc.stderrText).toContain(
      "orchestrator: stopping: the orchestrator was stopped (SIGTERM)",
    );
    await expectCleanEnd(r.proc);
  });

  test("a lock gone before it is released is said", async () => {
    const config = await writeConfig({ tasks: [TASKS[0]] });
    const r = rig((id) =>
      runner(id, 1, "passed", { exitCode: undefined, runMs: 300 }),
    );
    const started = start({ config, once: true }, r.deps);
    await waitForText(runLog("bpng-1"), FAKE_LINES.ready);
    await rm(join(stateDir, "orchestrator.lock"));
    expect(await started).toBe(0);
    expect(await logText()).toContain(
      `${join(stateDir, "orchestrator.lock")} was not removed: it was gone, another's, or could not be`,
    );
  });

  test("what an earlier crash left is removed as the lock is taken, and said", async () => {
    const config = await writeConfig({ tasks: [TASKS[0]] });
    const leftover = join(stateDir, ".orchestrator.lock.0123456789ab.tmp");
    await writeFile(leftover, "");
    const old = new Date(Date.now() - 3_600_000);
    await utimes(leftover, old, old);
    const r = rig((id) => runner(id, 1, "passed"));
    expect(await start({ config, once: true }, r.deps)).toBe(0);
    expect(existsSync(leftover)).toBe(false);
    expect(await logText()).toContain(
      "orchestrator  removed 1 file an earlier crash left",
    );
  });

  test("an unexpected failure under the lock is said and exits 1, the lock released", async () => {
    const config = await writeConfig({ tasks: [TASKS[0]] });
    // A bus limit the bus refuses: it throws where nothing expects a throw.
    const r = rig(undefined, { busTimeoutMs: 0 });
    expect(await start({ config }, r.deps)).toBe(1);
    const log = await logText();
    expect(log).toContain("orchestrator  stopped on an unexpected failure:");
    expect(log).toContain("orchestrator  exiting 1");
    await expectCleanEnd(r.proc);
  });

  test("a server's load counts only the tasks --task selects", async () => {
    const config = await writeConfig({ serverWarningThreshold: 2 });
    const all = rig((id) => runner(id, 1, "passed"));
    expect(await start({ config, once: true }, all.deps)).toBe(0);
    expect(await logText()).toContain(
      "qa-lnmp carries 2 tasks at once (serverWarningThreshold 2)",
    );
    await rm(join(stateDir, "orchestrator.log"));
    const one = rig((id) => runner(id, 2, "passed"));
    expect(await start({ config, once: true, tasks: ["bpng"] }, one.deps)).toBe(
      0,
    );
    expect(await logText()).not.toContain("carries");
  });

  test("the checkout is this module's folder's parent, and the waits are the plan's", () => {
    expect(CHECKOUT).toBe(resolve(import.meta.dirname, ".."));
    expect(existsSync(join(CHECKOUT, "orchestrator", "start.ts"))).toBe(true);
    expect(KILL_SETTLE_MS).toBe(60_000);
    expect(EXIT_WAIT_MS).toBe(5_000);
  });
});

test.describe("start — in a real process, real signals", () => {
  /**
   * Starts `start` in a child Node over the fake suite, its process the real one.
   *
   * @returns the child, and a promise of its exit code.
   */
  function child(config: string): {
    pid: number;
    exit: Promise<number | null>;
  } {
    const body = `
      import { start } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "start.ts")).href)};
      import { fakeCommand } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "__fixtures__", "fake-suite.ts")).href)};
      const list = {
        PRODUCTS: ${JSON.stringify(PRODUCT_LIST.PRODUCTS)},
        productByName: () => { throw new Error("injected"); },
        playwrightConfigFor: () => "x",
      };
      process.exit(await start({ config: ${JSON.stringify(config)} }, {
        checkout: ${JSON.stringify(checkout)},
        loadProductList: async () => list,
        loop: {
          commandsFor: () => ({ bddgen: fakeCommand({ exitCode: 0 }), playwright: fakeCommand({ runMs: 60000 }) }),
          launchOptions: { pollMs: 20 },
        },
      }));
    `;
    const proc = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "--eval",
        body,
      ],
      {
        cwd: checkout,
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
        stdio: "ignore",
      },
    );
    return {
      pid: proc.pid ?? 0,
      exit: new Promise((resolve) =>
        proc.on("exit", (code) => {
          resolve(code);
        }),
      ),
    };
  }

  for (const [name, signals, gapMs] of [
    [
      "one Ctrl-C under npm — two SIGINTs, milliseconds apart — drains",
      ["SIGINT", "SIGINT"],
      5,
    ],
    ["SIGTERM drains", ["SIGTERM"], 0],
  ] as const)
    test(`${name}, and the process exits 130 with its lock released`, async () => {
      const config = await writeConfig({ tasks: [TASKS[0]] });
      const proc = child(config);
      await waitForText(runLog("bpng-1"), FAKE_LINES.ready, 20_000);
      for (const signal of signals) {
        process.kill(proc.pid, signal);
        await delay(gapMs);
      }
      expect(await proc.exit).toBe(130);
      const out = await readFile(runLog("bpng-1"), "utf8");
      expect(out).toContain(FAKE_LINES.drained);
      expect(out).not.toContain(FAKE_LINES.sigint);
      expect(await record("bpng-1")).toMatchObject({ status: "stopped" });
      expect(existsSync(join(stateDir, "orchestrator.lock"))).toBe(false);
      expect(await logText()).toContain("exiting 130");
    });
});
