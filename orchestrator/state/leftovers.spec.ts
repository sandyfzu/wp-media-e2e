import { test, expect } from "@playwright/test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TASKS_DIR } from "./counter";
import {
  isCounterLeftover,
  isStateLeftover,
  LEFTOVER_AGE_MS,
  sweepLeftovers,
} from "./leftovers";

/** A fresh state directory per test, removed after it. */
let dir: string;
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "e2e-leftovers-"));
});
test.afterEach(async () => {
  await chmod(dir, 0o700).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

const HEX12 = "0123456789ab";
const HEX32 = "0123456789abcdef0123456789abcdef";

/** The time the sweeps run at: a fixed point, so a file's age is set exactly. */
const NOW = Date.UTC(2026, 9, 13, 12);

/**
 * Creates a file of the given age.
 *
 * @param path - the file.
 * @param ageMs - how old, at {@link NOW}.
 */
async function fileAged(path: string, ageMs: number): Promise<void> {
  await writeFile(path, "x");
  const when = new Date(NOW - ageMs);
  await utimes(path, when, when);
}

test.describe("isStateLeftover / isCounterLeftover", () => {
  test("names the lock's temporary file, its claims, and a claim's temporary file", () => {
    for (const name of [
      `.orchestrator.lock.${HEX12}.tmp`,
      `.orchestrator.lock.${HEX32}.claim`,
      `..orchestrator.lock.${HEX32}.claim.${HEX12}.tmp`,
    ])
      expect(isStateLeftover(name), name).toBe(true);
  });

  for (const name of [
    "orchestrator.lock",
    "config.json",
    ".config.json.0123456789ab.tmp",
    `.orchestrator.lock.${HEX12}.tmp.x`,
    `.orchestrator.lock.${HEX32.slice(1)}.claim`,
    `.orchestratorXlock.${HEX12}.tmp`,
    `.orchestrator.lock.${HEX12.toUpperCase()}.tmp`,
  ])
    test(`never names ${JSON.stringify(name)} in the state directory`, () => {
      expect(isStateLeftover(name)).toBe(false);
    });

  test("names a counter's temporary file in tasks/, for a valid task id only", () => {
    expect(isCounterLeftover(`.bpng.json.${HEX12}.tmp`)).toBe(true);
    for (const name of [
      "bpng.json",
      `.BPNG.json.${HEX12}.tmp`,
      `.bp/ng.json.${HEX12}.tmp`,
      `.bpng.json.${HEX12}.tmpx`,
      `..json.${HEX12}.tmp`,
    ])
      expect(isCounterLeftover(name), name).toBe(false);
  });
});

test.describe("sweepLeftovers", () => {
  test("removes leftovers older than a minute, in the state directory and tasks/, and keeps the rest", async () => {
    const tasks = join(dir, TASKS_DIR);
    await mkdir(tasks);
    const old = LEFTOVER_AGE_MS + 1;
    const gone = [
      join(dir, `.orchestrator.lock.${HEX12}.tmp`),
      join(dir, `.orchestrator.lock.${HEX32}.claim`),
      join(dir, `..orchestrator.lock.${HEX32}.claim.${HEX12}.tmp`),
      join(tasks, `.bpng.json.${HEX12}.tmp`),
    ];
    for (const path of gone) await fileAged(path, old);
    // Young: perhaps still being written.
    await fileAged(join(dir, `.orchestrator.lock.${"f".repeat(12)}.tmp`), 1000);
    // Not ours.
    await fileAged(join(dir, "config.json"), old);
    await fileAged(join(tasks, "bpng.json"), old);
    // A folder or a link under a leftover's name: never removed, never followed.
    await mkdir(join(dir, `.orchestrator.lock.${"e".repeat(12)}.tmp`));
    const target = join(dir, "target");
    await fileAged(target, old);
    await symlink(
      target,
      join(dir, `.orchestrator.lock.${"d".repeat(12)}.tmp`),
    );

    const sweep = await sweepLeftovers(dir, NOW);

    expect(sweep).toEqual({ removed: [...gone].sort(), failed: [] });
    expect((await readdir(dir)).sort()).toEqual(
      [
        `.orchestrator.lock.${"d".repeat(12)}.tmp`,
        `.orchestrator.lock.${"e".repeat(12)}.tmp`,
        `.orchestrator.lock.${"f".repeat(12)}.tmp`,
        "config.json",
        "target",
        TASKS_DIR,
      ].sort(),
    );
    expect(await readdir(tasks)).toEqual(["bpng.json"]);
  });

  test("lists nothing through a link at tasks/", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "e2e-leftovers-elsewhere-"));
    try {
      const leftover = join(elsewhere, `.bpng.json.${HEX12}.tmp`);
      await fileAged(leftover, LEFTOVER_AGE_MS + 1);
      await symlink(elsewhere, join(dir, TASKS_DIR));
      expect(await sweepLeftovers(dir, NOW)).toEqual({
        removed: [],
        failed: [],
      });
      expect(await readdir(elsewhere)).toEqual([`.bpng.json.${HEX12}.tmp`]);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  test("never rejects: a leftover it cannot remove is reported with its code", async () => {
    const leftover = join(dir, `.orchestrator.lock.${HEX12}.tmp`);
    await fileAged(leftover, LEFTOVER_AGE_MS + 1);
    await chmod(dir, 0o500);
    expect(await sweepLeftovers(dir, NOW)).toEqual({
      removed: [],
      failed: [{ path: leftover, code: "EACCES" }],
    });
  });

  test("never rejects for a state directory it cannot list", async () => {
    expect(await sweepLeftovers(join(dir, "none"), NOW)).toEqual({
      removed: [],
      failed: [],
    });
    await chmod(dir, 0o300);
    expect((await sweepLeftovers(dir, NOW)).failed).toEqual([
      { path: dir, code: "EACCES" },
    ]);
  });
});
