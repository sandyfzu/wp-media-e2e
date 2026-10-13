import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RESULTS_FILE } from "../reporting/results-schema";

/**
 * For specs: report trees on disk, laid out as runs leave them — `<root>/<product>/<cell>/<RUN_ID>/`
 * — for the report pruning to list and remove.
 */

/** What a fake run's folder holds. */
export interface FakeRun {
  /**
   * Its stream's first line: a `test` run that planned work, a `list` run, a run that found no tests,
   * or no stream at all (a run older than the stream, or killed before it began).
   */
  readonly stream?: "test" | "list" | "no-tests" | "none";
  /** Whether its Playwright report was written to the end; true by default. */
  readonly complete?: boolean;
  /** Bytes of padding in its Allure results, to give it a size. */
  readonly bytes?: number;
  /** Every entry's modification time, epoch ms. */
  readonly mtimeMs?: number;
}

/**
 * A fresh, empty folder under the system's temporary folder, by its real path (macOS's sits behind a
 * link, and the pruning compares paths).
 *
 * @param prefix - the folder name's start.
 */
export function tempRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/**
 * Removes a temporary tree, whatever is in it.
 *
 * @param root - the tree.
 */
export function removeTempRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/** When every fake run's stream says it began: what dates a run whose name is no RUN_ID. */
export const STREAM_BEGAN_AT = "2026-10-12T00:00:00.000Z";

/** A `run.begin` line for a stream of the given kind. */
function runBegin(kind: "test" | "list" | "no-tests"): string {
  return `${JSON.stringify({
    v: 1,
    type: "run.begin",
    at: STREAM_BEGAN_AT,
    runId: "r",
    product: "p",
    mode: kind === "list" ? "list" : "test",
    scenarios: kind === "test" ? 3 : 0,
    setups: kind === "test" ? 2 : 0,
    retries: 2,
    workers: 1,
  })}\n`;
}

/**
 * Writes a run's report folder.
 *
 * @param groupDir - its cell's folder.
 * @param name - its RUN_ID.
 * @param run - what it holds.
 * @returns its path.
 */
export function makeRun(
  groupDir: string,
  name: string,
  run: FakeRun = {},
): string {
  const path = join(groupDir, name);
  mkdirSync(join(path, "playwright"), { recursive: true });
  mkdirSync(join(path, "cucumber"), { recursive: true });
  mkdirSync(join(path, "allure-results"), { recursive: true });
  // A killed run leaves a 0-byte Cucumber file and no Playwright index.
  writeFileSync(join(path, "cucumber", "index.html"), "");
  if (run.complete ?? true) {
    writeFileSync(join(path, "playwright", "index.html"), "<html></html>");
  }
  const stream = run.stream ?? "test";
  if (stream !== "none")
    writeFileSync(join(path, RESULTS_FILE), runBegin(stream));
  writeFileSync(
    join(path, "allure-results", "pad.json"),
    "x".repeat(run.bytes ?? 0),
  );
  if (run.mtimeMs !== undefined) touchTree(path, run.mtimeMs);
  return path;
}

/** Sets the modification time of a run's known entries, deepest first. */
function touchTree(path: string, mtimeMs: number): void {
  const when = new Date(mtimeMs);
  for (const entry of [
    join(path, "allure-results", "pad.json"),
    join(path, "cucumber", "index.html"),
    join(path, "playwright", "index.html"),
    join(path, RESULTS_FILE),
    join(path, "allure-results"),
    join(path, "cucumber"),
    join(path, "playwright"),
    path,
  ]) {
    try {
      utimesSync(entry, when, when);
    } catch {
      // Not every run holds every entry.
    }
  }
}
