import { errorMessage } from "../guards";
import { treeBytes } from "./report-tree";
import {
  DAY_MS,
  DEFAULT_RETENTION,
  LEFTOVER_GRACE_MS,
  MAX_REPORTS_KEEP,
  MIN_MAX_AGE_MS,
  applyRetention,
  describeReason,
  formatBytes,
  formatSpan,
  listReportRuns,
  planRetention,
  removeLeftovers,
  type ReportListing,
  type ReportRun,
  type RetentionDecision,
  type RetentionPolicy,
} from "./retention";
import { displayPath, plain } from "./run-summary";

/**
 * `npm run report:prune`: the report retention policy over every cell's reports — or one product's,
 * or one cell's — as a dry run unless `--apply`. A run prunes only its own cell as it ends; this is
 * how a cell that no longer runs is pruned. The parser and the command are here, testable; the root
 * `prune-reports.ts` only wires them to the process.
 */

/** What the command was asked to do. */
export interface PruneOptions {
  /** Remove; otherwise only say what would go. */
  readonly apply: boolean;
  readonly policy: RetentionPolicy;
  /** Only this product's folder. */
  readonly product?: string;
  /** Only this cell's folders (`_all` included). */
  readonly cell?: string;
}

/** The command line, read. */
export type ParsedPruneArgs =
  | { readonly kind: "run"; readonly options: PruneOptions }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

/** The exit codes: done, a removal (or the listing) failed, the arguments were wrong. */
export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

/** The command's help. */
export const PRUNE_USAGE = `Usage: npm run report:prune -- [options]

Applies the report retention policy to every cell's reports under REPORT_ROOT (default reports/).
A dry run unless --apply: each run is listed with its decision, size and reason.

Options:
  --apply                    remove what the policy says goes
  --keep <n>                 at most n reports per cell, 0 for no cap
                             (default: E2E_REPORTS_KEEP, else ${String(DEFAULT_RETENTION.keep)})
  --older-than <span>        remove reports older than this, at least 1d
                             (default: ${formatSpan(DEFAULT_RETENTION.maxAgeMs)})
  --keep-newest-for <span>   keep each cell's newest complete report up to this age
                             (default: ${formatSpan(DEFAULT_RETENTION.keepNewestCompleteForMs)})
  --product <name>           only this product's reports
  --cell <name>              only this cell's reports (_all: runs of every cell)
  -h, --help                 this help

A span is a whole number and a unit: m (minutes), h (hours), d (days) or w (weeks), e.g. 30d.
Exit status: 0 done, 1 a removal failed, 2 bad arguments.`;

/** Each span unit's length. */
const SPAN_UNITS: Readonly<Record<string, number>> = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: DAY_MS,
  w: 7 * DAY_MS,
};

/**
 * Reads a span: a whole number from 1 to 999999, then `m`, `h`, `d` or `w`.
 *
 * @param text - e.g. `30d`.
 * @returns the span in milliseconds, or `undefined` for anything else.
 */
export function parseSpan(text: string): number | undefined {
  const match = /^([1-9]\d{0,5})([mhdw])$/.exec(text);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const unit = SPAN_UNITS[match[2]];
  return unit === undefined ? undefined : Number(match[1]) * unit;
}

/** The options that take a value. */
const VALUE_OPTIONS = [
  "--keep",
  "--older-than",
  "--keep-newest-for",
  "--product",
  "--cell",
] as const;

/** An option that takes a value. */
type ValueOption = (typeof VALUE_OPTIONS)[number];

/**
 * Reads the command line, strictly: an unknown option, a repeated one, a missing or bad value, or a
 * stray argument is an error naming it.
 *
 * @param argv - the arguments after the script's name.
 * @param defaultKeep - the cap when `--keep` is not given (`E2E_REPORTS_KEEP`).
 */
export function parsePruneArgs(
  argv: readonly string[],
  defaultKeep: number,
): ParsedPruneArgs {
  const values = new Map<ValueOption, string>();
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    if (arg === "--apply") {
      if (apply) return usageError("--apply is given twice");
      apply = true;
      continue;
    }
    const [name, inline] = splitOption(arg);
    const option = VALUE_OPTIONS.find((known) => known === name);
    if (option === undefined) {
      return usageError(
        arg.startsWith("-")
          ? `unknown option ${JSON.stringify(arg)}`
          : `unexpected argument ${JSON.stringify(arg)}`,
      );
    }
    if (values.has(option)) return usageError(`${option} is given twice`);
    const value = inline ?? argv[i + 1];
    if (
      value === undefined ||
      (inline === undefined && value.startsWith("-"))
    ) {
      return usageError(`${option} needs a value`);
    }
    if (inline === undefined) i += 1;
    values.set(option, value);
  }
  return readOptions(values, apply, defaultKeep);
}

/** `--name=value` as `[name, value]`; anything else as `[arg, undefined]`. */
function splitOption(arg: string): [string, string | undefined] {
  const at = arg.indexOf("=");
  return arg.startsWith("--") && at > 0
    ? [arg.slice(0, at), arg.slice(at + 1)]
    : [arg, undefined];
}

/** The parsed values, checked, as options. */
function readOptions(
  values: ReadonlyMap<ValueOption, string>,
  apply: boolean,
  defaultKeep: number,
): ParsedPruneArgs {
  const keepText = values.get("--keep");
  const keep = keepText === undefined ? defaultKeep : parseKeep(keepText);
  if (keep === undefined) {
    return usageError(
      `--keep must be a whole number from 0 to ${String(MAX_REPORTS_KEEP)}, got ${JSON.stringify(keepText)}`,
    );
  }
  const maxAgeMs = spanOption(
    values,
    "--older-than",
    DEFAULT_RETENTION.maxAgeMs,
  );
  if (typeof maxAgeMs === "string") return usageError(maxAgeMs);
  if (maxAgeMs < MIN_MAX_AGE_MS) {
    return usageError(
      "--older-than must be at least 1d: a run in progress carries no marker, and lasts hours",
    );
  }
  const keepNewestCompleteForMs = spanOption(
    values,
    "--keep-newest-for",
    DEFAULT_RETENTION.keepNewestCompleteForMs,
  );
  if (typeof keepNewestCompleteForMs === "string") {
    return usageError(keepNewestCompleteForMs);
  }
  const product = values.get("--product");
  const cell = values.get("--cell");
  for (const [option, name] of [
    ["--product", product],
    ["--cell", cell],
  ] as const) {
    if (name !== undefined && !isFolderName(name)) {
      return usageError(
        `${option} must be one folder name, got ${JSON.stringify(name)}`,
      );
    }
  }
  return {
    kind: "run",
    options: {
      apply,
      policy: { keep, maxAgeMs, keepNewestCompleteForMs },
      ...(product === undefined ? {} : { product }),
      ...(cell === undefined ? {} : { cell }),
    },
  };
}

/** `--keep`'s value: digits only, 0 to {@link MAX_REPORTS_KEEP}. */
function parseKeep(text: string): number | undefined {
  if (!/^\d{1,5}$/.test(text)) return undefined;
  const keep = Number(text);
  return keep <= MAX_REPORTS_KEEP ? keep : undefined;
}

/** A span option's value in ms, its default when absent, or the error message. */
function spanOption(
  values: ReadonlyMap<ValueOption, string>,
  option: ValueOption,
  fallback: number,
): number | string {
  const text = values.get(option);
  if (text === undefined) return fallback;
  return (
    parseSpan(text) ??
    `${option} must be a whole number and m, h, d or w (e.g. 30d), got ${JSON.stringify(text)}`
  );
}

/** One visible folder name: no separator, not `.`/`..`, not hidden. */
function isFolderName(name: string): boolean {
  return (
    name !== "" &&
    !name.startsWith(".") &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

/** A usage error. */
function usageError(message: string): ParsedPruneArgs {
  return { kind: "error", message };
}

/** Where the command prints, and where it shows paths from. */
export interface PruneIo {
  /** Prints one line. */
  readonly print: (line: string) => void;
  /** The working directory paths are shown relative to. */
  readonly cwd: string;
}

/**
 * Runs the command: lists, plans, prints every decision, and removes when asked.
 *
 * @param options - what to do.
 * @param root - the report root, absolute.
 * @param now - the time to measure ages against, epoch ms.
 * @param io - where to print.
 * @returns the exit status ({@link EXIT}).
 */
export function runPrune(
  options: PruneOptions,
  root: string,
  now: number,
  io: PruneIo,
): number {
  const show = (path: string): string => plain(displayPath(path, io.cwd));
  let listing: ReportListing;
  try {
    listing = listReportRuns(root, options);
  } catch (error) {
    io.print(
      `Could not read the reports under ${show(root)}: ${plain(errorMessage(error))}`,
    );
    return EXIT.failed;
  }
  const missing = missingScope(options, listing);
  if (missing !== undefined) {
    io.print(`${missing} under ${show(root)}.`);
    return EXIT.usage;
  }
  io.print(
    `Pruning ${show(root)} — ${options.apply ? "removing" : "a dry run: nothing is removed without --apply"}.`,
  );
  io.print(`Policy: ${describePolicy(options.policy)}.`);
  const plan = planRetention(
    listing.runs,
    options.policy,
    now,
    (run) => run.group,
  );
  const sizes = new Map(
    listing.runs.map((run) => [run.path, treeBytes(run.path)]),
  );
  printPlan(plan, sizes, options.policy, io.print);
  printSkipped(listing, now, show, io.print);
  const doomed = plan.filter((decision) => decision.action === "delete");
  const doomedBytes = doomed.reduce(
    (sum, decision) => sum + (sizes.get(decision.entry.path) ?? 0),
    0,
  );
  const totalBytes = [...sizes.values()].reduce((sum, size) => sum + size, 0);
  const tally = `${String(doomed.length)} of ${String(plan.length)} runs, ${formatBytes(doomedBytes)} of ${formatBytes(totalBytes)}`;
  if (!options.apply) {
    io.print("");
    io.print(`Would remove ${tally}. Pass --apply to remove them.`);
    return EXIT.ok;
  }
  return applyAndReport(plan, listing, root, now, show, io.print, tally);
}

/** Says which `--product`/`--cell` named nothing, or `undefined` when both found a folder. */
function missingScope(
  options: PruneOptions,
  listing: ReportListing,
): string | undefined {
  if (options.product === undefined && options.cell === undefined) {
    return undefined;
  }
  if (listing.groups.length > 0) return undefined;
  const scope = [
    options.product === undefined ? undefined : `product "${options.product}"`,
    options.cell === undefined ? undefined : `cell "${options.cell}"`,
  ]
    .filter(Boolean)
    .join(" and ");
  return `No report folder for ${scope}`;
}

/** The policy in a sentence. */
function describePolicy(policy: RetentionPolicy): string {
  const cap =
    policy.keep === 0
      ? "no cap on the count"
      : `at most ${String(policy.keep)} reports per cell`;
  return (
    `${cap}, none older than ${formatSpan(Math.max(policy.maxAgeMs, MIN_MAX_AGE_MS))}, ` +
    `each cell's newest complete report kept up to ${formatSpan(policy.keepNewestCompleteForMs)}`
  );
}

/** Prints each group's decisions under a heading. */
function printPlan(
  plan: readonly RetentionDecision<ReportRun>[],
  sizes: ReadonlyMap<string, number>,
  policy: RetentionPolicy,
  print: (line: string) => void,
): void {
  const width = Math.max(0, ...plan.map(({ entry }) => entry.name.length));
  let group: string | undefined;
  for (const decision of plan) {
    if (decision.group !== group) {
      group = decision.group;
      print("");
      print(groupHeading(plan, group, sizes));
    }
    const { entry } = decision;
    const size = formatBytes(sizes.get(entry.path) ?? 0).padStart(9);
    const dated = entry.timeSource === "stream" ? " (dated by its stream)" : "";
    print(
      `  ${decision.action === "delete" ? "remove" : "keep  "}  ${plain(entry.name).padEnd(width)}  ${size}  ${describeReason(decision.reason, policy)}${dated}`,
    );
  }
}

/** "backwpup/pro@nginx — 25 runs: 21 kept, 4 to remove (12.3 MB)". */
function groupHeading(
  plan: readonly RetentionDecision<ReportRun>[],
  group: string,
  sizes: ReadonlyMap<string, number>,
): string {
  const members = plan.filter((decision) => decision.group === group);
  const doomed = members.filter((decision) => decision.action === "delete");
  const bytes = doomed.reduce(
    (sum, decision) => sum + (sizes.get(decision.entry.path) ?? 0),
    0,
  );
  return (
    `${plain(group)} — ${String(members.length)} run${members.length === 1 ? "" : "s"}: ` +
    `${String(members.length - doomed.length)} kept, ${String(doomed.length)} to remove (${formatBytes(bytes)})`
  );
}

/** Prints what is never removed, and what interrupted removals left. */
function printSkipped(
  listing: ReportListing,
  now: number,
  show: (path: string) => string,
  print: (line: string) => void,
): void {
  // Hidden entries (a `.DS_Store`) are only counted: they are never anything of the suite's.
  const shown = listing.skipped.filter(({ reason }) => reason !== "hidden");
  const hidden = listing.skipped.length - shown.length;
  if (listing.skipped.length > 0) {
    print("");
    print("Skipped, never removed:");
    for (const { path, reason } of shown) {
      print(`  ${show(path)} — ${reason}`);
    }
    if (hidden > 0) {
      print(`  and ${String(hidden)} hidden entr${hidden === 1 ? "y" : "ies"}`);
    }
  }
  if (listing.leftovers.length > 0) {
    print("");
    print("Left by an interrupted removal:");
    for (const { path, since } of listing.leftovers) {
      const due = now - since >= LEFTOVER_GRACE_MS;
      print(
        `  ${show(path)} — ${due ? "removed with --apply" : "too recent: possibly still being removed"}`,
      );
    }
  }
}

/** Removes what the plan says goes, prints what happened, and returns the exit status. */
function applyAndReport(
  plan: readonly RetentionDecision<ReportRun>[],
  listing: ReportListing,
  root: string,
  now: number,
  show: (path: string) => string,
  print: (line: string) => void,
  tally: string,
): number {
  const report = applyRetention(plan, root, now);
  const leftovers = removeLeftovers(listing.leftovers, root, now);
  const freed =
    report.removed.reduce((sum, removal) => sum + removal.bytes, 0) +
    leftovers.removed.reduce((sum, removal) => sum + removal.bytes, 0);
  print("");
  print(
    `Planned ${tally}. Removed ${String(report.removed.length)} runs` +
      (leftovers.removed.length > 0
        ? ` and ${String(leftovers.removed.length)} leftovers`
        : "") +
      `, ${formatBytes(freed)}.`,
  );
  for (const path of report.gone) {
    print(`  already gone: ${show(path)}`);
  }
  const failed = [...report.failed, ...leftovers.failed];
  for (const failure of failed) {
    print(`  could not remove ${show(failure.path)} — ${plain(failure.error)}`);
  }
  return failed.length > 0 ? EXIT.failed : EXIT.ok;
}
