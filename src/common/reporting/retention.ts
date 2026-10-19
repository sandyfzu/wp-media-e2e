import { randomBytes } from "node:crypto";
import {
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { parseRunId } from "../config/run-id";
import { errorMessage } from "../guards";
import {
  errnoCode,
  isListable,
  isRealDirectory,
  lstatOrUndefined,
  readHead,
  treeBytes,
} from "./report-tree";
import { parseResults } from "./results-reader";
import { RESULTS_FILE, type RunBeginEvent } from "./results-schema";

/**
 * Report retention: which run report folders to keep, and removing the rest safely. Each run prunes
 * its own cell's folder as it ends (`run-pruning.ts`), `npm run report:prune` prunes every cell, and
 * the orchestrator reuses the planner per task.
 *
 * The policy, per group (a `<product>/<cell>` folder; a task, for the orchestrator), newest first:
 *
 *  1. an **empty** run — `--list`, or "No tests found" — never counts, and goes unless protected;
 *  2. a **protected** run (the run in progress) is kept, and so is one dated in the **future** — which
 *     takes no place under the cap and is never the newest complete report, so a skewed clock or a
 *     pinned RUN_ID cannot push a real report out;
 *  3. the group's **newest complete** report is kept while at most `keepNewestCompleteForMs` old,
 *     whatever the cap — so a cell whose last runs were all killed keeps one readable report;
 *  4. a run older than `maxAgeMs` (never under one day) goes; so does one at rank `keep` or beyond
 *     (`keep = 0`: no cap); anything else is kept. Killed runs count toward the cap — and so does a
 *     run of the same group still in progress, which only a protected path keeps: nothing on disk
 *     tells it from a killed one, so a group takes one run at a time.
 *
 * A run whose start time is unknown (a caller's entry with no finite `time`) is always kept, outside
 * the cap; a listed run always has one — its RUN_ID's, else its stream's `run.begin`. Never a file's
 * modification time: an Allure generation makes an old run look new, and a folder that is no run at
 * all (a `REPORT_ROOT` set to the repository) would be dated, then removed, by it.
 *
 * Free of side effects on import (no `.env`, no `RUN_ID`), so a long-lived process can use it.
 */

/** One day, in milliseconds. */
export const DAY_MS = 86_400_000;

/** How many reports a group keeps, how old they may grow, and how long its newest complete one lives. */
export interface RetentionPolicy {
  /** At most this many runs per group (FIFO); `0` sets no cap. */
  readonly keep: number;
  /** A run older than this goes; read as at least {@link MIN_MAX_AGE_MS}. */
  readonly maxAgeMs: number;
  /** The group's newest complete report is kept up to this age, whatever the other rules say. */
  readonly keepNewestCompleteForMs: number;
}

/** The suite's policy: 20 reports per cell, 30 days, the newest complete one up to 182 days. */
export const DEFAULT_RETENTION: RetentionPolicy = {
  keep: 20,
  maxAgeMs: 30 * DAY_MS,
  keepNewestCompleteForMs: 182 * DAY_MS,
};

/**
 * The floor under `maxAgeMs`: a run in progress has no marker, and one lasts hours at most (8.6 h,
 * the longest seen, on a runner that slept) — so nothing younger than a day is ever removed for its age.
 */
export const MIN_MAX_AGE_MS = DAY_MS;

/** The highest `keep` accepted (`E2E_REPORTS_KEEP`, `--keep`). */
export const MAX_REPORTS_KEEP = 10_000;

/** Where reports go when `REPORT_ROOT` is unset, relative to the repository root. */
export const DEFAULT_REPORT_ROOT = "reports";

/** What the planner needs to know about a run. */
export interface RetentionEntry {
  /** The run's folder, absolute. */
  readonly path: string;
  /** When the run started, epoch ms; a non-finite value marks it undated, and keeps it. */
  readonly time: number;
  /** Ran nothing: `--list`, or "No tests found". */
  readonly empty: boolean;
  /** Its reports were written to the end: a readable Playwright report. */
  readonly complete: boolean;
}

/** A run's report folder, as {@link listReportRuns} found it. */
export interface ReportRun extends RetentionEntry {
  /** `<product>/<cell>`: the folder it sits in, below the report root. */
  readonly group: string;
  /** The folder's name: the run's RUN_ID. */
  readonly name: string;
  /** Where {@link RetentionEntry.time} came from: its name, or its stream's `run.begin`. */
  readonly timeSource: "run-id" | "stream";
}

/** Something under the report root that is not a run, and why. Never removed. */
export interface SkippedEntry {
  readonly path: string;
  readonly reason: string;
}

/** A folder an earlier removal renamed and did not finish removing ({@link applyRetention}). */
export interface RemovalLeftover {
  readonly path: string;
  /** When it was renamed, epoch ms, from its name. */
  readonly since: number;
}

/** What a report tree holds. */
export interface ReportListing {
  readonly runs: readonly ReportRun[];
  readonly skipped: readonly SkippedEntry[];
  readonly leftovers: readonly RemovalLeftover[];
  /** Every group folder listed, `<product>/<cell>`, whether it holds runs or not. */
  readonly groups: readonly string[];
}

/** Why a run is kept. */
export type KeepReason =
  "protected" | "future" | "undated" | "newest-complete" | "within-policy";

/** Why a run goes. */
export type DeleteReason = "empty" | "too-old" | "beyond-cap";

/** One run's fate. */
export type RetentionDecision<E extends RetentionEntry = RetentionEntry> = {
  readonly entry: E;
  readonly group: string;
  /** Its place among the group's dated, non-empty runs, newest 0; absent for an empty or undated run. */
  readonly rank?: number;
} & (
  | { readonly action: "keep"; readonly reason: KeepReason }
  | { readonly action: "delete"; readonly reason: DeleteReason }
);

/** A removal that happened, and what it freed. */
export interface Removal<E extends RetentionEntry = RetentionEntry> {
  readonly decision: RetentionDecision<E>;
  /** The bytes of the regular files removed. */
  readonly bytes: number;
}

/** A removal that did not happen, or not fully. */
export interface RemovalFailure {
  /** The run's folder, or the leftover's. */
  readonly path: string;
  /** What went wrong, and where any remainder now is. */
  readonly error: string;
}

/** What {@link applyRetention} did. */
export interface RemovalReport<E extends RetentionEntry = RetentionEntry> {
  readonly removed: readonly Removal<E>[];
  /** Folders already gone when their turn came: another prune removed them first. */
  readonly gone: readonly string[];
  readonly failed: readonly RemovalFailure[];
}

/** The parts a run's report folder holds; a folder with none is not a run. */
export const REPORT_PARTS: readonly string[] = [
  "playwright",
  "cucumber",
  "allure-results",
  "allure",
  RESULTS_FILE,
  // The run-facts reporter's record of what the run tested.
  "run-facts.json",
];

/** The prefix of a folder renamed for removal; hidden, so no report listing shows it. */
const IN_REMOVAL_PREFIX = ".pruning-";

/** An in-removal name: the prefix, when (epoch ms), the pid, eight random hex digits. */
const IN_REMOVAL_NAME = /^\.pruning-(\d{1,16})-\d{1,10}-[0-9a-f]{8}$/;

/**
 * How long a renamed folder is left to the removal that renamed it, before a later prune takes it
 * over: a removal takes milliseconds to seconds, so an older one was interrupted.
 */
export const LEFTOVER_GRACE_MS = 60 * 60 * 1000;

/** How much of `results.jsonl` is read to find its first line, `run.begin` (about 250 bytes). */
const STREAM_HEAD_BYTES = 64 * 1024;

/**
 * Lists the run report folders under a report root, laid out `<root>/<product>/<cell>/<RUN_ID>/`.
 * The root itself may be a link; nothing below it is followed. A run is a folder holding a report
 * part ({@link REPORT_PARTS}) and dated by the suite's own hand — a RUN_ID name, else a results
 * stream that opens with `run.begin`; everything else — a cell-level `allure-history.jsonl`, a link,
 * a hidden folder, a folder of someone else's — is skipped with its reason, and in-removal folders
 * are listed as leftovers.
 *
 * @param root - the report root, absolute.
 * @param filter - only this product's and/or this cell's folders.
 * @returns what is there; an empty listing when the root does not exist.
 * @throws {@link Error} when the root exists but is not a folder or cannot be read.
 */
export function listReportRuns(
  root: string,
  filter: { readonly product?: string; readonly cell?: string } = {},
): ReportListing {
  const listing = emptyListing();
  // The root may be a link (a REPORT_ROOT on another disk); `statSync` follows it, deliberately.
  let rootStats;
  try {
    rootStats = statSync(root);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return listing;
    throw error;
  }
  if (!rootStats.isDirectory()) {
    throw new Error(`The report root ${root} is not a folder.`);
  }
  for (const product of subfolders(root, listing)) {
    if (filter.product !== undefined && product !== filter.product) continue;
    const productDir = join(root, product);
    const cells = readOrSkip(productDir, listing, () =>
      subfolders(productDir, listing),
    );
    for (const cell of cells ?? []) {
      if (filter.cell !== undefined && cell !== filter.cell) continue;
      const groupDir = join(productDir, cell);
      readOrSkip(groupDir, listing, () => {
        collectGroup(groupDir, `${product}/${cell}`, listing);
      });
    }
  }
  return listing;
}

/**
 * Reads one folder below the root; one that cannot be read is skipped, with why, and the listing
 * goes on — one unreadable cell must not hide every other.
 */
function readOrSkip<T>(
  dir: string,
  listing: MutableListing,
  read: () => T,
): T | undefined {
  try {
    return read();
  } catch (error) {
    listing.skipped.push({
      path: dir,
      reason: `unreadable (${errnoCode(error) ?? errorMessage(error)})`,
    });
    return undefined;
  }
}

/**
 * Lists one group folder's runs — what a run's own end-of-run pruning reads.
 *
 * @param groupDir - the folder, absolute: `<root>/<product>/<cell>`.
 * @param group - its label, `<product>/<cell>`.
 * @returns its runs, skipped entries and leftovers; empty when the folder does not exist.
 * @throws {@link Error} when the folder is a link (never followed, as below a report root) or
 *   cannot be read.
 */
export function listGroupRuns(groupDir: string, group: string): ReportListing {
  const listing = emptyListing();
  const stats = lstatOrUndefined(groupDir);
  if (stats === undefined) return listing;
  if (stats.isSymbolicLink()) {
    throw new Error(`${groupDir} is a link, never followed`);
  }
  collectGroup(groupDir, group, listing);
  return listing;
}

/** A listing being built. */
interface MutableListing {
  runs: ReportRun[];
  skipped: SkippedEntry[];
  leftovers: RemovalLeftover[];
  groups: string[];
}

/** A new, empty listing. */
function emptyListing(): MutableListing {
  return { runs: [], skipped: [], leftovers: [], groups: [] };
}

/**
 * The names of a folder's real subfolders, sorted; anything else is recorded as skipped. Hidden
 * names are skipped too: nothing the suite writes there starts with a dot.
 */
function subfolders(dir: string, listing: MutableListing): string[] {
  const names: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const reason = notAFolderReason(path, name);
    if (reason === undefined) names.push(name);
    else listing.skipped.push({ path, reason });
  }
  return names;
}

/** Why a path is not a folder to descend into, or `undefined` when it is one. */
function notAFolderReason(path: string, name: string): string | undefined {
  if (name.startsWith(".")) return "hidden";
  const stats = lstatOrUndefined(path);
  if (stats === undefined) return "unreadable";
  if (stats.isSymbolicLink()) return "a symlink, never followed";
  if (!stats.isDirectory()) return "a file, not a run";
  return undefined;
}

/** Adds one group folder's runs, skipped entries and leftovers to the listing. */
function collectGroup(
  groupDir: string,
  group: string,
  listing: MutableListing,
): void {
  listing.groups.push(group);
  for (const name of readdirSync(groupDir).sort()) {
    const path = join(groupDir, name);
    const leftover = leftoverSince(name);
    // Only a real folder is a removal's leftover; a link or a file of that name is merely hidden.
    if (leftover !== undefined && isRealDirectory(path)) {
      listing.leftovers.push({ path, since: leftover });
      continue;
    }
    const reason = notAFolderReason(path, name);
    if (reason !== undefined) {
      listing.skipped.push({ path, reason });
      continue;
    }
    const run = describeRun(path, name, group);
    if (typeof run === "string") listing.skipped.push({ path, reason: run });
    else listing.runs.push(run);
  }
}

/** When an in-removal folder was renamed, from its name; `undefined` for any other name. */
function leftoverSince(name: string): number | undefined {
  const match = IN_REMOVAL_NAME.exec(name);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * A run folder's facts, or why it is not a run: it holds no report part, or nothing the suite wrote
 * dates it — the name is no RUN_ID and there is no stream (a pinned RUN_ID's run killed before its
 * stream began is kept for a person to remove, never guessed at).
 *
 * @param path - the folder.
 * @param name - its name: the RUN_ID, if it is a run.
 * @param group - its group's label, `<product>/<cell>`.
 * @returns the run, or the reason it is skipped.
 */
function describeRun(
  path: string,
  name: string,
  group: string,
): ReportRun | string {
  const parts = REPORT_PARTS.filter((part) => {
    const stats = lstatOrUndefined(join(path, part));
    return stats !== undefined && !stats.isSymbolicLink();
  });
  if (parts.length === 0) {
    return isListable(path) ? "holds no report part" : "unreadable";
  }
  const begin = readRunBegin(path);
  const parsed = parseRunId(name);
  const time =
    parsed?.time ?? (begin === undefined ? Number.NaN : isoInstant(begin.at));
  if (!Number.isFinite(time)) {
    return "not a run: its name is no RUN_ID, and no results stream dates it";
  }
  const empty =
    begin !== undefined &&
    (begin.mode === "list" || (begin.scenarios === 0 && begin.setups === 0));
  return {
    path,
    group,
    name,
    time,
    timeSource: parsed === undefined ? "stream" : "run-id",
    empty,
    complete: !empty && isComplete(path),
  };
}

/**
 * An instant exactly as the suite writes `run.begin`'s `at` (`Date.prototype.toISOString`, UTC), in
 * epoch ms; `NaN` for anything else. `Date.parse` alone would read a date with no zone as local time,
 * a bare `"1"` as 2001, and roll 2026-02-30 over to March — none of which reads back the same.
 *
 * @param value - the `at` of a `run.begin`.
 */
export function isoInstant(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value
    ? time
    : Number.NaN;
}

/**
 * A run's `run.begin`, its stream's first line. An empty run is told by it — `list` mode, or no
 * scenario and no setup planned ("No tests found"); a run with none (older than the stream, or killed
 * before it began) is not empty.
 *
 * @param path - the run's folder.
 * @returns the event, or `undefined` when the stream is absent, unreadable or opens with anything else.
 */
function readRunBegin(path: string): RunBeginEvent | undefined {
  const head = readHead(join(path, RESULTS_FILE), STREAM_HEAD_BYTES);
  if (head === undefined) return undefined;
  // The first line alone: one cut short by the head's limit has no newline, and reads as nothing.
  const first = parseResults(head.slice(0, head.indexOf("\n") + 1)).events[0];
  return first?.type === "run.begin" ? first : undefined;
}

/**
 * Whether a run's reports were written to the end: its Playwright report's `index.html`, which the
 * HTML reporter writes as the run ends, is a non-empty file. A killed run has none (nor does a run
 * still in progress).
 */
function isComplete(path: string): boolean {
  const folder = join(path, "playwright");
  if (!isRealDirectory(folder)) return false;
  const index = lstatOrUndefined(join(folder, "index.html"));
  return index?.isFile() === true && index.size > 0;
}

/**
 * Decides, per group, which runs to keep and which to remove — the policy in this module's
 * description. Pure: the same entries, policy and `now` always give the same plan.
 *
 * @param entries - the runs, in any order.
 * @param policy - the limits; `maxAgeMs` below {@link MIN_MAX_AGE_MS} is read as that floor.
 * @param now - the time to measure ages against, epoch ms.
 * @param groupOf - each run's group: its cell folder, or the orchestrator's task.
 * @param protectedPaths - runs never removed (the run in progress), absolute.
 * @returns one decision per entry, grouped (groups by name), newest first within each.
 */
export function planRetention<E extends RetentionEntry>(
  entries: readonly E[],
  policy: RetentionPolicy,
  now: number,
  groupOf: (entry: E) => string,
  protectedPaths: readonly string[] = [],
): RetentionDecision<E>[] {
  const maxAgeMs = Math.max(policy.maxAgeMs, MIN_MAX_AGE_MS);
  const isProtected = new Set(protectedPaths.map((path) => resolve(path)));
  const groups = new Map<string, E[]>();
  for (const entry of entries) {
    const group = groupOf(entry);
    const members = groups.get(group);
    if (members === undefined) groups.set(group, [entry]);
    else members.push(entry);
  }
  const decisions: RetentionDecision<E>[] = [];
  for (const group of [...groups.keys()].sort()) {
    const ordered = newestFirst(groups.get(group) ?? []);
    const newestComplete = ordered.find(
      (entry) => entry.complete && ranked(entry, now),
    );
    let next = 0;
    for (const entry of ordered) {
      const rank = ranked(entry, now) ? next++ : undefined;
      const verdict = decide(entry, {
        rank,
        now,
        maxAgeMs,
        policy,
        isProtected: isProtected.has(resolve(entry.path)),
        isNewestComplete: entry === newestComplete,
      });
      decisions.push({
        entry,
        group,
        ...(rank === undefined ? {} : { rank }),
        ...verdict,
      });
    }
  }
  return decisions;
}

/**
 * Whether a run takes a place under the cap: dated, not empty, and not in the future — a run dated
 * ahead (a skewed clock, a pinned RUN_ID) would otherwise hold a place, and push a real report out,
 * until its date came.
 */
function ranked(entry: RetentionEntry, now: number): boolean {
  return !entry.empty && Number.isFinite(entry.time) && entry.time <= now;
}

/** A group's runs, newest first; an undated run last, a tie broken by path (descending). */
function newestFirst<E extends RetentionEntry>(entries: readonly E[]): E[] {
  const key = (entry: E): number =>
    Number.isFinite(entry.time) ? entry.time : Number.NEGATIVE_INFINITY;
  return [...entries].sort((a, b) => {
    const byTime = key(b) - key(a);
    if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
    if (a.path === b.path) return 0;
    return a.path < b.path ? 1 : -1;
  });
}

/** What {@link decide} needs to know beyond the entry. */
interface DecisionContext {
  readonly rank: number | undefined;
  readonly now: number;
  readonly maxAgeMs: number;
  readonly policy: RetentionPolicy;
  readonly isProtected: boolean;
  readonly isNewestComplete: boolean;
}

/** One run's fate, by the rules in their order. */
function decide(
  entry: RetentionEntry,
  context: DecisionContext,
):
  | { action: "keep"; reason: KeepReason }
  | { action: "delete"; reason: DeleteReason } {
  if (context.isProtected) return { action: "keep", reason: "protected" };
  if (entry.empty) return { action: "delete", reason: "empty" };
  // A run whose start is unknown is never removed for its age or its place.
  if (!Number.isFinite(entry.time))
    return { action: "keep", reason: "undated" };
  if (entry.time > context.now) return { action: "keep", reason: "future" };
  const age = context.now - entry.time;
  if (
    context.isNewestComplete &&
    age <= context.policy.keepNewestCompleteForMs
  ) {
    return { action: "keep", reason: "newest-complete" };
  }
  if (age > context.maxAgeMs) return { action: "delete", reason: "too-old" };
  if (
    context.policy.keep > 0 &&
    context.rank !== undefined &&
    context.rank >= context.policy.keep
  ) {
    return { action: "delete", reason: "beyond-cap" };
  }
  return { action: "keep", reason: "within-policy" };
}

/**
 * A decision's reason in words.
 *
 * @param reason - why the run is kept or removed.
 * @param policy - the policy it was decided under, for its numbers.
 */
export function describeReason(
  reason: KeepReason | DeleteReason,
  policy: RetentionPolicy,
): string {
  switch (reason) {
    case "protected":
      return "a run in progress";
    case "future":
      return "dated in the future";
    case "undated":
      return "no start time known";
    case "newest-complete":
      return "the newest complete report";
    case "within-policy":
      return "within the policy";
    case "empty":
      return "empty (--list, or no tests found)";
    case "too-old":
      return `older than ${formatSpan(Math.max(policy.maxAgeMs, MIN_MAX_AGE_MS))}`;
    case "beyond-cap":
      return `beyond the newest ${String(policy.keep)}`;
  }
}

/**
 * A span in the largest whole unit: `30 days`, `36 hours`, `90 minutes`.
 *
 * @param ms - the span, in milliseconds.
 */
export function formatSpan(ms: number): string {
  const units: [number, string][] = [
    [DAY_MS, "day"],
    [60 * 60 * 1000, "hour"],
    [60 * 1000, "minute"],
  ];
  for (const [size, word] of units) {
    if (ms >= size && ms % size === 0) {
      const count = ms / size;
      return `${String(count)} ${word}${count === 1 ? "" : "s"}`;
    }
  }
  return `${String(Math.round(ms / 1000))} seconds`;
}

/**
 * Removes the runs a plan deletes. Each folder is first renamed to a hidden name inside its group —
 * atomic on one filesystem, so no reader ever sees a half-removed run — then removed, then confirmed
 * gone. A failure is reported, never thrown: pruning must not fail a run.
 *
 * Should the removal stop part-way, what is left keeps its hidden name; a later prune removes it once
 * {@link LEFTOVER_GRACE_MS} has passed ({@link removeLeftovers}).
 *
 * A run is removed only while its folder still leads where the listing found it, below `root`
 * ({@link outsideRoot}) — checked before the rename and again after it, so a folder above the run
 * swapped for a link in between cannot redirect the removal out of the report tree.
 *
 * @param plan - the decisions; only `delete` ones are acted on.
 * @param root - the report root every run sits below, as it was listed.
 * @param now - the time to name the in-removal folders by, epoch ms.
 */
export function applyRetention<E extends RetentionEntry>(
  plan: readonly RetentionDecision<E>[],
  root: string,
  now: number = Date.now(),
): RemovalReport<E> {
  const removed: Removal<E>[] = [];
  const gone: string[] = [];
  const failed: RemovalFailure[] = [];
  for (const decision of plan) {
    if (decision.action !== "delete") continue;
    const outcome = removeRun(decision.entry.path, root, now);
    if (outcome.kind === "removed") {
      removed.push({ decision, bytes: outcome.bytes });
    } else if (outcome.kind === "gone") {
      gone.push(decision.entry.path);
    } else {
      failed.push({ path: decision.entry.path, error: outcome.error });
    }
  }
  return { removed, gone, failed };
}

/** What happened to one folder. */
type RemovalOutcome =
  | { readonly kind: "removed"; readonly bytes: number }
  | { readonly kind: "gone" }
  | { readonly kind: "failed"; readonly error: string };

/** Renames one run's folder out of sight, then removes it; see {@link applyRetention}. */
function removeRun(path: string, root: string, now: number): RemovalOutcome {
  const before = lstatOrUndefined(path);
  if (before === undefined) return { kind: "gone" };
  if (!before.isDirectory()) {
    return {
      kind: "failed",
      error: "no longer a folder (a link or a file now): left alone",
    };
  }
  const outside = outsideRoot(path, root);
  if (outside !== undefined) return { kind: "failed", error: outside };
  const hidden = join(dirname(path), inRemovalName(now));
  try {
    renameSync(path, hidden);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { kind: "gone" };
    return {
      kind: "failed",
      error: `could not set it aside, nothing removed: ${errorMessage(error)}`,
    };
  }
  // What was renamed is what was checked, unless it was swapped in between: put a swapped-in link back.
  if (!isRealDirectory(hidden)) {
    return restoreSwapped(hidden, path);
  }
  // Its folder may have been swapped for a link after the check above: then the rename went there.
  const movedOut = outsideRoot(hidden, root);
  if (movedOut !== undefined) return restoreSwapped(hidden, path, movedOut);
  return removeHidden(hidden);
}

/**
 * Why `path` must not be removed as a folder below `root`, or `undefined` when it may: it must sit
 * below the root, and its parent must resolve to the root's own resolved path plus the same names —
 * so no folder between the two is a link (the root itself may be one, as a listing allows).
 *
 * @param path - a run's folder, or a removal's hidden one.
 * @param root - the report root.
 */
export function outsideRoot(path: string, root: string): string | undefined {
  const parent = dirname(resolve(path));
  const below = relative(resolve(root), parent);
  if (below === "" || below === ".." || below.startsWith(`..${sep}`)) {
    return "not below the report root: left alone";
  }
  if (isAbsolute(below)) return "not below the report root: left alone";
  let expected: string;
  let actual: string;
  try {
    expected = join(realpathSync(root), below);
    actual = realpathSync(parent);
  } catch (error) {
    return `its folder cannot be resolved, left alone: ${errorMessage(error)}`;
  }
  return actual === expected
    ? undefined
    : "its folder now leads outside the report root (a link): left alone";
}

/**
 * Puts back what was renamed although it must not be removed: a link or a file swapped in for a run's
 * folder, or a folder reached through a link swapped in above it — between the check and the rename.
 *
 * @param hidden - where the rename put it.
 * @param path - where it was.
 * @param why - what was found; by default, a link or a file in the run folder's place.
 */
function restoreSwapped(
  hidden: string,
  path: string,
  why = "replaced by a link or a file while being removed",
): RemovalOutcome {
  const said = why.replace(/: left alone$/, "");
  try {
    renameSync(hidden, path);
    return { kind: "failed", error: `${said}: left alone` };
  } catch (error) {
    return {
      kind: "failed",
      error: `${said}, and left as ${hidden}: ${errorMessage(error)}`,
    };
  }
}

/**
 * Removes a folder already renamed out of sight, then confirms it is gone. Links inside are removed,
 * never followed.
 */
function removeHidden(hidden: string): RemovalOutcome {
  const bytes = treeBytes(hidden);
  try {
    rmSync(hidden, { recursive: true, force: true, maxRetries: 2 });
  } catch (error) {
    return {
      kind: "failed",
      error: `removed in part; the rest is in ${basename(hidden)}, which a later prune removes: ${errorMessage(error)}`,
    };
  }
  if (lstatOrUndefined(hidden) !== undefined) {
    return {
      kind: "failed",
      error: `still there after its removal, as ${basename(hidden)}`,
    };
  }
  return { kind: "removed", bytes };
}

/** A fresh hidden name for a folder being removed; unique across processes and hosts. */
function inRemovalName(now: number): string {
  return `${IN_REMOVAL_PREFIX}${String(Math.max(0, Math.trunc(now)))}-${String(process.pid)}-${randomBytes(4).toString("hex")}`;
}

/** What {@link removeLeftovers} did. */
export interface LeftoverReport {
  readonly removed: readonly {
    readonly path: string;
    readonly bytes: number;
  }[];
  readonly failed: readonly RemovalFailure[];
}

/**
 * Removes what interrupted removals left, once {@link LEFTOVER_GRACE_MS} has passed since each was
 * renamed — a younger one may still be in the hands of the prune that renamed it. Like a run, one is
 * removed only while it still sits below `root` ({@link outsideRoot}).
 *
 * @param leftovers - from a listing.
 * @param root - the report root they were listed under.
 * @param now - the time, epoch ms.
 */
export function removeLeftovers(
  leftovers: readonly RemovalLeftover[],
  root: string,
  now: number,
): LeftoverReport {
  const removed: { path: string; bytes: number }[] = [];
  const failed: RemovalFailure[] = [];
  for (const leftover of leftovers) {
    if (now - leftover.since < LEFTOVER_GRACE_MS) continue;
    if (!isRealDirectory(leftover.path)) continue;
    const outside = outsideRoot(leftover.path, root);
    if (outside !== undefined) {
      failed.push({ path: leftover.path, error: outside });
      continue;
    }
    const outcome = removeHidden(leftover.path);
    if (outcome.kind === "removed") {
      removed.push({ path: leftover.path, bytes: outcome.bytes });
    } else if (outcome.kind === "failed") {
      failed.push({ path: leftover.path, error: outcome.error });
    }
  }
  return { removed, failed };
}

/**
 * A size as a person reads it, in decimal units: `512 B`, `4.3 MB`, `1.2 GB`.
 *
 * @param bytes - the size.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${String(Math.round(bytes))} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1000) break;
    value /= 1000;
    unit = next;
  }
  return `${value.toFixed(1)} ${unit}`;
}
