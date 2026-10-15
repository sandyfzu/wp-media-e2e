import { lstat, mkdir } from "node:fs/promises";

import { errorCode } from "../error-code";
import {
  checkOwnFolder,
  describeFolderProblem,
  ownFolderRemedy,
  type OwnFolderCheck,
  type OwnFolderRule,
} from "../folders";
import { shellWord } from "../text";
import { StateError } from "./errors";

/**
 * `<state>/runs/`, the run folders' folder, judged wherever it is made or read: a real folder (a link
 * is never followed), this user's, and no one else may write in it. Others writing there could swap a
 * run's folder for a link between two of the orchestrator's looks, and its records and logs would be
 * written wherever the link leads. Reading it is not refused — each run folder is `0700` itself.
 */

/** The runs' folder's rule: no link, no other writer. */
export const RUNS_FOLDER: OwnFolderRule = {
  followLink: false,
  closedTo: 0o022,
  chmod: "go-w",
};

/**
 * Checks the runs' folder.
 *
 * @param runsDir - `<state>/runs`.
 * @returns `false` when it is not there yet, `true` when it is and passes.
 * @throws {@link StateError} naming it and its repair when it is a link (coded `ELOOP`), not a folder
 *   (`ENOTDIR`), another user's, or open to other writers.
 * @throws what `lstat` throws besides `ENOENT`.
 */
export async function checkRunsFolder(runsDir: string): Promise<boolean> {
  let check: OwnFolderCheck;
  try {
    check = await checkOwnFolder(runsDir, RUNS_FOLDER);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  if (check.kind === "ok") return true;
  throw await runsFolderRefusal(runsDir, check);
}

/**
 * Makes the runs' folder `0700` unless it is there, then checks it ({@link checkRunsFolder}).
 *
 * @param runsDir - `<state>/runs`; its parent, the state directory, must exist.
 * @param make - `mkdir` from `node:fs/promises`; a spec's stand-in makes the folder appear meanwhile.
 * @throws as {@link checkRunsFolder} does — a folder made meanwhile by someone else included — and
 *   what `mkdir` throws besides `EEXIST`.
 */
export async function ensureRunsFolder(
  runsDir: string,
  make: (path: string, options: { mode: number }) => Promise<unknown> = mkdir,
): Promise<void> {
  if (await checkRunsFolder(runsDir)) return;
  await make(runsDir, { mode: 0o700 }).catch((error: unknown) => {
    // Made meanwhile: judged below.
    if (errorCode(error) !== "EEXIST") throw error;
  });
  await checkRunsFolder(runsDir);
}

/**
 * The refusal of a runs' folder {@link checkOwnFolder} did not pass, with its repair.
 *
 * @param runsDir - `<state>/runs`.
 * @param check - what was wrong.
 * @returns the error, coded `ELOOP` for a link and `ENOTDIR` for anything else that is no folder.
 */
async function runsFolderRefusal(
  runsDir: string,
  check: Exclude<OwnFolderCheck, { kind: "ok" }>,
): Promise<StateError> {
  const folder = `The run folders' folder ${runsDir}`;
  if (check.kind === "notFolder") {
    const link = (
      await lstat(runsDir).catch(() => undefined)
    )?.isSymbolicLink();
    return Object.assign(
      new StateError(
        `${folder} is not a folder (a symbolic link is never followed). Move it away: mv ${shellWord(runsDir)} ${shellWord(`${runsDir}.moved`)}`,
      ),
      { code: link === true ? "ELOOP" : "ENOTDIR" },
    );
  }
  return new StateError(
    `${folder} ${describeFolderProblem(check)}: it must be this user's, and no one else may write in it (${ownFolderRemedy(runsDir, check, RUNS_FOLDER)}).`,
  );
}
