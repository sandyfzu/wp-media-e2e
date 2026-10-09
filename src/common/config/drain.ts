import { accessSync, constants, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

import { errorMessage, isNonEmptyString, isObject } from "../guards";
import type { TestInfo } from "@playwright/test";

/**
 * The drain: how a run is stopped **gracefully** from outside.
 *
 * Whoever started the run (the orchestrator) names a stop file in {@link STOP_FILE_ENV} and creates
 * it to ask the run to stop. From then on every scenario's **first** attempt is skipped as stopped,
 * while the one in flight finishes as it would have, its retries included. That keeps the reports
 * complete and true, which a SIGINT does not: an interrupt abandons the running step, runs the
 * teardown beside it, and no report says "interrupted" consistently.
 *
 * Only first attempts are gated: a retry is the second half of a scenario that already ran, and
 * skipping it would turn that scenario's failure into "flaky". Without the variable there is no
 * gate at all, so a run nobody can stop this way behaves exactly as before.
 *
 * A gate that can never close fails silently — every stop then becomes an interrupt — so the path
 * is checked strictly: here as it is read, and its folder once as the config loads
 * ({@link assertStopFileFolder}).
 *
 * This module is the policy; `../fixtures.ts` binds it to every scenario as an automatic fixture,
 * and the `@plugin` After hook uses {@link wasDrained} to leave alone a scenario that never began.
 */

/** The variable naming the run's stop file. Internal: set by the orchestrator, never by hand. */
export const STOP_FILE_ENV = "E2E_INTERNAL_STOP_FILE";

/**
 * The annotation a drained scenario carries, so a report or a results reader can tell why it was
 * skipped.
 */
export const STOPPED_ANNOTATION = "stopped";

/**
 * The run's stop file, or `undefined` when the run has none (unset or blank).
 *
 * Absolute and verbatim only: a relative path resolves against whatever the working directory is,
 * and surrounding whitespace names a file nobody creates — either way the gate would look somewhere
 * the stop file never appears, and never close.
 *
 * @param source - where to read it; `process.env` unless a caller (or a spec) holds another.
 * @throws {@link Error} naming the variable and its value when the path is not absolute, or carries
 * surrounding whitespace.
 */
export function stopFileFromEnv(
  source: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const path = source[STOP_FILE_ENV];
  if (!isNonEmptyString(path)) return undefined;
  if (path.trim() !== path || !isAbsolute(path)) {
    throw new Error(
      `${STOP_FILE_ENV} must be an absolute path with no surrounding whitespace, got ` +
        `${JSON.stringify(path)}. It names the file whose existence asks this run to stop; unset ` +
        "it for a run that is not stopped that way.",
    );
  }
  return path;
}

/**
 * Refuses a stop file the gate could never see: one whose folder is missing, is not a folder, or may
 * not be searched by this process. `existsSync` answers `false` when it cannot tell, so any of these
 * would leave the gate open for the whole run. Run once, as the config loads; only the folder is
 * checked, since the file itself appears later, when someone stops the run.
 *
 * @param stopFile - the run's stop file, from {@link stopFileFromEnv}.
 * @throws {@link Error} naming the variable, the folder and what is wrong with it.
 */
export function assertStopFileFolder(stopFile: string): void {
  const folder = dirname(stopFile);
  /** Builds the refusal, saying what is wrong with the folder. */
  const refusal = (problem: string): Error =>
    new Error(
      `${STOP_FILE_ENV}=${JSON.stringify(stopFile)}: its folder ${folder} ${problem}, so this run ` +
        "could never see the stop file and could only be interrupted. Create the folder before " +
        "starting the run, or unset the variable.",
    );
  let isDirectory: boolean;
  try {
    isDirectory = statSync(folder).isDirectory();
  } catch (error) {
    const code =
      isObject(error) && typeof error.code === "string"
        ? error.code
        : errorMessage(error);
    throw refusal(`cannot be read (${code})`);
  }
  if (!isDirectory) throw refusal("is not a directory");
  try {
    accessSync(folder, constants.X_OK);
  } catch {
    throw refusal("may not be searched by this process");
  }
}

/**
 * Whether a scenario attempt is drained, and why.
 *
 * Only a first attempt that has not failed yet. The gate normally runs before anything else in the
 * attempt; it runs late only when something before it already failed (a worker fixture refusing a
 * broken site, say), and Playwright then reports a skip as that attempt's verdict and skips its
 * retry unrun — a broken site would read "flaky" (measured).
 *
 * @param stopFile - the run's stop file, from {@link stopFileFromEnv}; `undefined` for no gate.
 * @param attempt - the attempt's retry number (`0` for the first) and its status so far, both from
 * its `testInfo`.
 * @param exists - whether a path exists; `fs.existsSync` in the runtime.
 * @returns the reason to skip the attempt, or `undefined` to run it.
 */
export function drainReason(
  stopFile: string | undefined,
  attempt: Pick<TestInfo, "retry" | "status">,
  exists: (path: string) => boolean,
): string | undefined {
  if (stopFile === undefined || attempt.retry > 0) return undefined;
  if (attempt.status !== "passed") return undefined;
  // Checked last: the filesystem is touched only when the answer can change the outcome.
  if (!exists(stopFile)) return undefined;
  return "the run was asked to stop before this scenario began, so it was not started";
}

/**
 * Whether the drain skipped this scenario — then no Before hook ran and nothing was installed, so
 * an After hook has nothing of its own to judge or remove.
 *
 * @param annotations - the scenario's annotations, `testInfo.annotations`.
 */
export function wasDrained(
  annotations: readonly { readonly type: string }[],
): boolean {
  return annotations.some(({ type }) => type === STOPPED_ANNOTATION);
}
