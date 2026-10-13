import { basename, dirname } from "node:path";

import { errorMessage } from "../guards";
import { lstatOrUndefined } from "./report-tree";
import {
  DEFAULT_RETENTION,
  applyRetention,
  describeReason,
  formatBytes,
  listGroupRuns,
  planRetention,
  removeLeftovers,
  type DeleteReason,
  type RemovalFailure,
  type RetentionPolicy,
} from "./retention";

/**
 * The pruning each run does as it ends, for its own report folder's group alone
 * (`<REPORT_ROOT>/<product>/<cell>`; `<product>/_all` for a run of every cell): the suite's policy
 * with the cap `E2E_REPORTS_KEEP`, the run itself protected. Run from the run summary's `onExit` —
 * the last reporter's, so every report has been written, and the summary can say what went. When a
 * 21st run ends, the oldest goes; a killed run never reaches `onExit`, and the next run prunes for it.
 */

/** What a run's pruning did. */
export interface PruneOutcome {
  /** The policy it applied. */
  readonly policy: RetentionPolicy;
  /** How many runs it removed, per {@link DeleteReason}, in the order each first appears in the plan. */
  readonly removed: readonly {
    readonly reason: DeleteReason;
    readonly count: number;
  }[];
  /** How many folders an interrupted removal had left, removed now. */
  readonly leftovers: number;
  /** The bytes freed, leftovers included. */
  readonly bytes: number;
  /** What it could not remove — or could not even list. */
  readonly failed: readonly RemovalFailure[];
}

/**
 * Prunes the group a run's report folder sits in. Never throws: a failure, listing included, is in
 * the outcome.
 *
 * @param reportPath - the run's own report folder, absolute: protected, and its parent is the group.
 * @param keep - the cap, `E2E_REPORTS_KEEP`; `0` for none.
 * @param now - the time, epoch ms.
 */
export function pruneRunGroup(
  reportPath: string,
  keep: number,
  now: number,
): PruneOutcome {
  const policy: RetentionPolicy = { ...DEFAULT_RETENTION, keep };
  const groupDir = dirname(reportPath);
  const productDir = dirname(groupDir);
  const group = `${basename(productDir)}/${basename(groupDir)}`;
  // A report folder sits at `<root>/<product>/<cell>/<RUN_ID>`: a path too short for that would make
  // a filesystem root's children the "runs" (never the case from the config, which builds the path).
  if (dirname(productDir) === productDir || productDir === groupDir) {
    return failedOutcome(
      policy,
      reportPath,
      "not inside <report root>/<product>/<cell>",
    );
  }
  // Nothing below the report root is followed: a product folder that is a link is left alone too.
  if (lstatOrUndefined(productDir)?.isSymbolicLink() === true) {
    return failedOutcome(policy, productDir, "a link, never followed");
  }
  try {
    const listing = listGroupRuns(groupDir, group);
    const plan = planRetention(listing.runs, policy, now, (run) => run.group, [
      reportPath,
    ]);
    const report = applyRetention(plan, now);
    const leftovers = removeLeftovers(listing.leftovers, now);
    const counts = new Map<DeleteReason, number>();
    for (const { decision } of report.removed) {
      if (decision.action === "delete") {
        counts.set(decision.reason, (counts.get(decision.reason) ?? 0) + 1);
      }
    }
    return {
      policy,
      removed: [...counts].map(([reason, count]) => ({ reason, count })),
      leftovers: leftovers.removed.length,
      bytes:
        report.removed.reduce((sum, removal) => sum + removal.bytes, 0) +
        leftovers.removed.reduce((sum, removal) => sum + removal.bytes, 0),
      failed: [...report.failed, ...leftovers.failed],
    };
  } catch (error) {
    return failedOutcome(policy, groupDir, errorMessage(error));
  }
}

/** An outcome that removed nothing, for this one reason. */
function failedOutcome(
  policy: RetentionPolicy,
  path: string,
  error: string,
): PruneOutcome {
  return {
    policy,
    removed: [],
    leftovers: 0,
    bytes: 0,
    failed: [{ path, error }],
  };
}

/** One line of what a run's pruning did; `warn` when it is a failure. */
export interface PruneLine {
  readonly text: string;
  readonly warn: boolean;
}

/**
 * What a run's pruning did, as the summary's `Pruned` lines: nothing at all when nothing was removed
 * and nothing failed.
 *
 * @param outcome - the pruning's outcome.
 * @param show - how a path is shown (relative to where the run started, quoted for a shell).
 * @example
 * ```ts
 * describePruning(outcome, show);
 * // [{ text: "1 old report, 4.3 MB — beyond the newest 20 (E2E_REPORTS_KEEP)", warn: false }]
 * ```
 */
export function describePruning(
  outcome: PruneOutcome,
  show: (path: string) => string,
): PruneLine[] {
  const lines: PruneLine[] = [];
  const runs = outcome.removed.reduce((sum, { count }) => sum + count, 0);
  if (runs > 0 || outcome.leftovers > 0) {
    lines.push({ text: removedPhrase(outcome, runs), warn: false });
  }
  for (const failure of outcome.failed) {
    lines.push({
      text: `could not prune ${show(failure.path)} — ${failure.error}`,
      warn: true,
    });
  }
  return lines;
}

/** "3 old reports, 8.6 MB — 2 beyond the newest 20 (E2E_REPORTS_KEEP), 1 older than 30 days". */
function removedPhrase(outcome: PruneOutcome, runs: number): string {
  const why = outcome.removed.map(({ reason, count }) => {
    const words = describeReason(reason, outcome.policy);
    const said =
      reason === "beyond-cap" ? `${words} (E2E_REPORTS_KEEP)` : words;
    // One reason needs no count: the head of the line gives it.
    return outcome.removed.length === 1 && outcome.leftovers === 0
      ? said
      : `${String(count)} ${said}`;
  });
  if (outcome.leftovers > 0) {
    why.push(`${String(outcome.leftovers)} left by an interrupted removal`);
  }
  const head =
    runs > 0
      ? `${String(runs)} old report${runs === 1 ? "" : "s"}`
      : `${String(outcome.leftovers)} unfinished removal${outcome.leftovers === 1 ? "" : "s"}`;
  return `${head}, ${formatBytes(outcome.bytes)} — ${why.join(", ")}`;
}
