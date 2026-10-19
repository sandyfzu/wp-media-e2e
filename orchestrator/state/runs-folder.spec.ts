import { test, expect } from "@playwright/test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fakeCommand } from "../__fixtures__/fake-suite";
import { launchRun } from "../runs/launch";
import { nextRunNumber } from "./counter";
import { StateError } from "./errors";
import { readRunningFolders } from "./run-folders";
import { pruneTaskRuns } from "./run-retention";
import { checkRunsFolder, ensureRunsFolder } from "./runs-folder";

/** One test's state directory, `0700`, and its runs' folder (not made). */
let stateDir: string;
let runsDir: string;

test.beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "e2e-runs-folder-"));
  runsDir = join(stateDir, "runs");
});

test.afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

/** The refusal of a runs' folder open to other writers, at `mode`. */
function openRefusal(mode: string): string {
  return `The run folders' folder ${runsDir} is mode ${mode}: it must be this user's, and no one else may write in it (chmod go-w ${runsDir}).`;
}

test.describe("checkRunsFolder / ensureRunsFolder", () => {
  test("a missing folder is none yet; ensure makes it 0700", async () => {
    expect(await checkRunsFolder(runsDir)).toBe(false);
    await ensureRunsFolder(runsDir);
    expect((await stat(runsDir)).mode & 0o777).toBe(0o700);
    expect(await checkRunsFolder(runsDir)).toBe(true);
  });

  test("judges a folder made by someone else between its look and its mkdir (EEXIST)", async () => {
    const makeOpen = async (path: string): Promise<never> => {
      await mkdir(path);
      await chmod(path, 0o777);
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    };
    await expect(ensureRunsFolder(runsDir, makeOpen)).rejects.toThrow(
      openRefusal("777"),
    );
  });

  test("passes a folder others may read, and refuses one others may write", async () => {
    await mkdir(runsDir, { mode: 0o700 });
    await chmod(runsDir, 0o755);
    expect(await checkRunsFolder(runsDir)).toBe(true);
    for (const mode of [0o777, 0o775, 0o757]) {
      await chmod(runsDir, mode);
      await expect(checkRunsFolder(runsDir)).rejects.toThrow(
        openRefusal(mode.toString(8)),
      );
      await expect(ensureRunsFolder(runsDir)).rejects.toThrow(StateError);
    }
  });

  test("never follows a link (ELOOP), and refuses a file (ENOTDIR), saying how to move it away", async () => {
    const elsewhere = join(stateDir, "elsewhere");
    await mkdir(elsewhere, { mode: 0o700 });
    await symlink(elsewhere, runsDir);
    await expect(ensureRunsFolder(runsDir)).rejects.toMatchObject({
      code: "ELOOP",
      message: `The run folders' folder ${runsDir} is not a folder (a symbolic link is never followed). Move it away: mv ${runsDir} ${runsDir}.moved`,
    });
    await rm(runsDir);
    await writeFile(runsDir, "");
    await expect(checkRunsFolder(runsDir)).rejects.toMatchObject({
      code: "ENOTDIR",
    });
  });
});

test.describe("a runs' folder others may write in is refused wherever it is made or read", () => {
  test.beforeEach(async () => {
    await mkdir(runsDir, { mode: 0o700 });
    await chmod(runsDir, 0o777);
  });

  test("launchRun makes no run folder in it, and spawns nothing", async () => {
    const dir = join(runsDir, "bpng-1");
    await expect(
      launchRun({
        identity: {
          dir,
          log: join(dir, "run.log"),
          stopFile: join(dir, "stop"),
          reportDir: join(stateDir, "reports"),
        },
        commands: {
          bddgen: fakeCommand({ exitCode: 0 }),
          playwright: fakeCommand({ exitCode: 0 }),
        },
        cwd: stateDir,
        env: { PATH: process.env.PATH ?? "" },
      }),
    ).rejects.toThrow(openRefusal("777"));
    expect(await readdir(runsDir)).toEqual([]);
  });

  test("the counter hands out no number", async () => {
    await expect(nextRunNumber(stateDir, "bpng")).rejects.toThrow(
      openRefusal("777"),
    );
  });

  test("the orphan check's reader refuses it", async () => {
    await expect(readRunningFolders(stateDir)).rejects.toThrow(
      openRefusal("777"),
    );
  });

  test("the run folders' pruning removes nothing, and says why", async () => {
    await mkdir(join(runsDir, "bpng-1"));
    const report = await pruneTaskRuns({
      stateDir,
      taskId: "bpng",
      keep: 0,
      now: Date.now(),
    });
    expect(report.failed).toEqual([
      { path: runsDir, error: openRefusal("777") },
    ]);
    expect(await readdir(runsDir)).toEqual(["bpng-1"]);
  });
});
