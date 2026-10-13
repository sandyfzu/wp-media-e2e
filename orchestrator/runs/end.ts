import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { RESULTS_FILE } from "../../src/common/reporting/results-schema";
import {
  buildRunFinished,
  type RunFinishedEvent,
  type RunFinishedInput,
} from "../events/run-finished";
import { readRunFacts, RUN_FACTS_FILE } from "./facts";
import type { RunIdentity } from "./identity";
import { LOG_PREFIX, type LaunchResult } from "./launch";
import { runOutcome, type RunOutcome } from "./outcome";
import { errorCode } from "./process-group";
import { readRunResults } from "./results";

/**
 * A run's end: what it left read back — its results stream, its facts, its log's last lines — each
 * within a size cap, then its outcome decided and its `run.finished` built. Reading never fails the
 * run: a missing or oversized file is read as absent, and the outcome says so where it matters.
 */

/**
 * The largest results stream read, in bytes: a full run writes well under 1 MiB (the largest seen, 12
 * KB). Its lines are capped too ({@link readRunResults}), so a hostile stream costs little to parse.
 */
export const MAX_RESULTS_BYTES = 8 * 1024 * 1024;

/** The largest facts file read, in bytes: a run's is a few KiB. */
export const MAX_FACTS_BYTES = 1024 * 1024;

/** How much of the log's end is read, in bytes. */
export const LOG_TAIL_BYTES = 64 * 1024;

/** How many of the log's last lines are kept: enough to find `bddgen`'s first error line. */
export const LOG_TAIL_MAX_LINES = 40;

/**
 * Opens for reading without waiting: a FIFO put where a report should be would otherwise block the
 * open until something writes to it. A regular file reads the same either way.
 */
const READ_NONBLOCKING = constants.O_RDONLY | constants.O_NONBLOCK;

/** A file read within a cap. */
export type CappedRead =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "missing" }
  | { readonly kind: "tooLarge"; readonly bytes: number }
  /** It is there, and could not be read: the system error's code. */
  | { readonly kind: "unreadable"; readonly code: string };

/**
 * Reads a whole file, unless it is larger than `maxBytes`.
 *
 * @param path - the file.
 * @param maxBytes - the cap.
 * @returns its text (UTF-8), or why there is none.
 */
export async function readCapped(
  path: string,
  maxBytes: number,
): Promise<CappedRead> {
  let handle;
  try {
    handle = await open(path, READ_NONBLOCKING);
  } catch (error) {
    const code = errorCode(error);
    return code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unreadable", code: code ?? "unknown error" };
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { kind: "unreadable", code: "not a file" };
    const { size } = stats;
    if (size > maxBytes) return { kind: "tooLarge", bytes: size };
    // Read through the cap, not to the size: a file still growing must not grow the read.
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return {
      kind: "text",
      text: buffer.subarray(0, bytesRead).toString("utf8"),
    };
  } catch (error) {
    return { kind: "unreadable", code: errorCode(error) ?? "unknown error" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * The run log's last lines, ours left out — a reason quotes what the run said, not our header lines.
 * Read from the last {@link LOG_TAIL_BYTES}; a line cut by that start is dropped, a whole one kept.
 *
 * @param path - the log.
 * @param bytes - how much of its end to read.
 * @param maxLines - how many lines to keep.
 * @returns the lines, oldest first; none when the log cannot be read.
 */
export async function readLogTail(
  path: string,
  bytes = LOG_TAIL_BYTES,
  maxLines = LOG_TAIL_MAX_LINES,
): Promise<string[]> {
  let handle;
  try {
    handle = await open(path, READ_NONBLOCKING);
  } catch {
    return [];
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return [];
    const { size } = stats;
    // One byte before the window too: the first line is whole only when that byte ends a line.
    const cut = size > bytes;
    const start = cut ? size - bytes - 1 : 0;
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer
      .subarray(0, bytesRead)
      .toString("utf8")
      .split(/\r?\n|\r/);
    // The piece before the first line end: the extra byte's line, empty when it ended one.
    if (cut) lines.shift();
    return lines
      .map(withoutOurs)
      .filter((line) => line.trim() !== "")
      .slice(-maxLines);
  } catch {
    return [];
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** One of our lines: the prefix, then an ISO time — at a line's start, or after output without a newline. */
const OUR_LINE = new RegExp(
  `${LOG_PREFIX.replace(/[[\]]/g, "\\$&")} \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z .*$`,
);

/**
 * A log line without the line of ours it may hold: ours begins on a line of its own, but a process
 * writing while we do can still run into it. A run printing lines like ours only hides its own.
 *
 * @param line - the line.
 * @returns the line's own text, `""` when it is one of ours.
 */
function withoutOurs(line: string): string {
  return line.startsWith(LOG_PREFIX) ? "" : line.replace(OUR_LINE, "");
}

/** What a run's end is made from. */
export interface RunEndInput {
  readonly identity: Pick<
    RunIdentity,
    "id" | "runId" | "startedAt" | "log" | "reportDir"
  >;
  readonly task: RunFinishedInput["task"];
  readonly launch: LaunchResult;
  /** The secret values the orchestrator holds (`secretValues(config)`). */
  readonly secrets: readonly string[];
  /** When the run ended. */
  readonly endedAt: Date;
}

/**
 * A run's end. The files' raw contents are not handed on: only the event, whose every text is made
 * safe to send, leaves this module.
 */
export interface RunEnd {
  readonly outcome: RunOutcome;
  readonly event: RunFinishedEvent;
}

/**
 * Reads what a run left, decides its outcome and builds its `run.finished`.
 *
 * @param input - the run, its task, how its processes ended and the secrets to mask.
 * @returns the outcome and the event.
 */
export async function endRun(input: RunEndInput): Promise<RunEnd> {
  const { identity, task, launch, secrets } = input;
  const [resultsRead, factsRead, logTail] = await Promise.all([
    readCapped(join(identity.reportDir, RESULTS_FILE), MAX_RESULTS_BYTES),
    readCapped(join(identity.reportDir, RUN_FACTS_FILE), MAX_FACTS_BYTES),
    readLogTail(identity.log),
  ]);
  const results =
    resultsRead.kind === "text" ? readRunResults(resultsRead.text) : undefined;
  const facts =
    factsRead.kind === "text"
      ? readRunFacts(factsRead.text, task.cell)
      : undefined;
  const resultsUnread = whyUnread(resultsRead);
  const outcome = runOutcome({
    stop: launch.stop,
    bddgen: launch.bddgen,
    ...(launch.playwright === undefined
      ? {}
      : { playwright: launch.playwright }),
    ...(results === undefined ? {} : { results }),
    ...(resultsUnread === undefined ? {} : { resultsUnread }),
    setupFailures: facts?.setupFailures ?? [],
    logTail,
    secrets,
  });
  const event = buildRunFinished({
    at: input.endedAt,
    run: { id: identity.id, runId: identity.runId },
    task,
    startedAt: identity.startedAt,
    endedAt: input.endedAt,
    outcome,
    ...(results === undefined ? {} : { results }),
    ...(facts === undefined ? {} : { facts }),
    reportDir: identity.reportDir,
    log: identity.log,
    secrets,
  });
  return { outcome, event };
}

/**
 * Why a file that is there was not read, in words; `undefined` when it was read or is not there.
 *
 * @param read - the read.
 */
function whyUnread(read: CappedRead): string | undefined {
  if (read.kind === "tooLarge")
    return `it is ${String(read.bytes)} bytes, over the ${String(MAX_RESULTS_BYTES)}-byte cap`;
  if (read.kind === "unreadable") return read.code;
  return undefined;
}
