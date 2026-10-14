import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readLeaderStart, type LeaderStartReader } from "../runs/leader";
import type { KillFn } from "../runs/process-group";
import { inspectState } from "./inspect";
import { inspectLock, LOCK_FILE, stateFolderProblem } from "./lock";
import { formatOwner, type LockOwner } from "./lock-owner";
import { readPidSpace, type PidSpace } from "./pid-space";

/** A fresh state directory per test, mode 0700, removed after it. */
let dir: string;

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "e2e-inspect-"));
  await chmod(dir, 0o700);
});

test.afterEach(async () => {
  await chmod(dir, 0o700).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

/** The PID space every fake process lives in. */
const SPACE: PidSpace = {
  platform: "linux",
  host: "box",
  boot: "f6fb3842-61ea-4a8e-8577-4be12500a66e",
  pidns: "pid:[4026532829]",
  machine: null,
};

/** A dead PID, as the fake `kill` sees it. */
const DEAD_PID = 4242;

/**
 * A process's start, as the fake reader gives it.
 *
 * @param pid - its PID.
 * @returns its start.
 */
function startOf(pid: number): string {
  return `test:${String(pid)}`;
}

/** Each PID's start, as {@link startOf} gives it. */
const readStart: LeaderStartReader = (pid) =>
  Promise.resolve({ kind: "start", value: startOf(pid) });

/** A `kill` for which {@link DEAD_PID} is gone and every other PID alive. */
const kill: KillFn = (pid) => {
  if (pid === DEAD_PID)
    throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
};

/** This process, as the fakes see it: PID 1000 in {@link SPACE}. */
const DEPS = {
  pid: 1000,
  kill,
  readStart,
  space: () => Promise.resolve(SPACE),
};

/**
 * Writes a lock as an orchestrator would.
 *
 * @param owner - its owner's PID and anything else.
 * @returns nothing; the lock is in {@link dir}.
 */
async function plantLock(
  owner: Partial<LockOwner> & { pid: number },
): Promise<void> {
  await writeFile(
    join(dir, LOCK_FILE),
    formatOwner({
      token: "a".repeat(32),
      start: startOf(owner.pid),
      space: SPACE,
      ...owner,
    }),
    { mode: 0o600 },
  );
}

/**
 * The state directory's entries and the lock's text: what a dry run must leave as it was.
 *
 * @returns them.
 */
async function snapshot(): Promise<string> {
  const entries = (await readdir(dir)).sort();
  const lock = await readFile(join(dir, LOCK_FILE), "utf8").catch(() => "");
  return JSON.stringify({ entries, lock });
}

test.describe("inspectState", () => {
  test("a closed state directory without a lock: nothing to say", async () => {
    expect(await inspectState(dir, DEPS)).toEqual([]);
  });

  test("a directory others may write in: the start's own refusal and its repair", async () => {
    await chmod(dir, 0o775);
    const warnings = await inspectState(dir, DEPS);
    expect(warnings).toEqual([
      `a start would be refused: ${stateFolderProblem(dir, { kind: "open", mode: 0o775 })}`,
    ]);
    expect(warnings[0]).toContain(`(chmod go-w ${dir})`);
  });

  test("a file in the state directory's place: refused, with no repair to give, and its lock not judged", async () => {
    const file = join(dir, "file");
    await writeFile(file, "");
    expect(await inspectState(file, DEPS)).toEqual([
      `a start would be refused: The state directory ${file} is not a folder: it must be this user's, and no one else may write in it.`,
    ]);
  });

  test("a state directory that is not there: said, never thrown", async () => {
    const gone = join(dir, "gone");
    const warnings = await inspectState(gone, DEPS);
    expect(warnings[0]).toBe(
      `the state directory ${gone} could not be checked (ENOENT)`,
    );
  });

  test("a live orchestrator's lock: the start's refusal, naming its PID", async () => {
    await plantLock({ pid: 77 });
    const before = await snapshot();
    expect(await inspectState(dir, DEPS)).toEqual([
      `a start would be refused: Another orchestrator (pid 77 on box) holds ${join(dir, LOCK_FILE)}. Stop it first; if pid 77 is no orchestrator, remove the lock: rm ${join(dir, LOCK_FILE)}`,
    ]);
    expect(await snapshot()).toBe(before);
  });

  test("a dead orchestrator's lock is no warning — a start takes it over — and stays where it is", async () => {
    await plantLock({ pid: DEAD_PID });
    const before = await snapshot();
    expect(await inspectState(dir, DEPS)).toEqual([]);
    expect(await snapshot()).toBe(before);
  });

  test("a lock from another PID space, or one that cannot be read, is the start's refusal", async () => {
    await plantLock({
      pid: 77,
      space: { ...SPACE, pidns: "pid:[4026532965]" },
    });
    expect((await inspectState(dir, DEPS))[0]).toMatch(
      /^a start would be refused: .* in another PID space/,
    );
    await writeFile(join(dir, LOCK_FILE), "not a lock");
    expect((await inspectState(dir, DEPS))[0]).toMatch(
      /^a start would be refused: The orchestrator's lock .* is not one this orchestrator wrote/,
    );
    await rm(join(dir, LOCK_FILE));
    await mkdir(join(dir, LOCK_FILE));
    expect((await inspectState(dir, DEPS))[0]).toMatch(
      /^a start would be refused: The orchestrator's lock .* is not a regular file/,
    );
  });

  test("a judgement that fails is said, never thrown", async () => {
    await plantLock({ pid: 77 });
    const failing: KillFn = () => {
      throw Object.assign(new Error("kill EINVAL"), { code: "EINVAL" });
    };
    expect(await inspectState(dir, { ...DEPS, kill: failing })).toEqual([
      "the state directory's lock could not be checked: kill EINVAL",
    ]);
  });

  test("with the real process: a lock a live process holds is refused, one whose process ended is not", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "setTimeout(() => {}, 60_000)",
    ]);
    try {
      const pid = child.pid ?? 0;
      const start = await readLeaderStart(pid);
      await plantLock({
        pid,
        start: start.kind === "start" ? start.value : null,
        space: await readPidSpace(),
      });
      expect(await inspectState(dir)).toEqual([
        expect.stringContaining(
          `a start would be refused: Another orchestrator (pid ${String(pid)}`,
        ),
      ]);
    } finally {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    expect(await inspectState(dir)).toEqual([]);
  });
});

test.describe("inspectLock", () => {
  test("no lock is free; a dead owner's is dead, with its owner", async () => {
    expect(await inspectLock(dir, DEPS)).toEqual({ kind: "free" });
    await plantLock({ pid: DEAD_PID });
    expect(await inspectLock(dir, DEPS)).toMatchObject({
      kind: "dead",
      owner: { pid: DEAD_PID },
    });
  });
});
