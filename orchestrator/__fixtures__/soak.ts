import { readdirSync } from "node:fs";

/**
 * The soak's measures and verdicts (`orchestrator/soak.spec.ts`): what one process holds, sampled
 * between runs, and whether it stays flat as runs go by; what pruning a task's run folders costs as
 * they accumulate. Pure but for {@link takeSample}, so each verdict is unit-tested.
 */

/** What the process holds at one point, between two runs. */
export interface Sample {
  /** Runs ended so far. */
  readonly cycle: number;
  /** Listeners on `process`, every event's summed. */
  readonly listeners: number;
  /** Active handles and requests (`process.getActiveResourcesInfo()`) but timers. */
  readonly resources: number;
  /** Armed Node timers. */
  readonly timeouts: number;
  /** Open file descriptors. */
  readonly fds: number;
  /** The V8 heap in use, MiB: reported, never judged — it moves with the collector. */
  readonly heapMiB: number;
}

/** The measures {@link judgeFlat} judges. */
export type FlatMetric = "listeners" | "resources" | "timeouts" | "fds";

/** How much each measure may exceed its warm-up's highest value. */
export type Tolerance = Readonly<Record<FlatMetric, number>>;

/** One pruning: how many run folders the task had once it ended, and how long it took. */
export interface PruneTiming {
  readonly folders: number;
  readonly ms: number;
}

/**
 * Samples this process.
 *
 * @param cycle - the runs ended so far.
 * @returns the sample.
 */
export function takeSample(cycle: number): Sample {
  const active = process.getActiveResourcesInfo();
  const timeouts = active.filter((resource) => resource === "Timeout").length;
  return {
    cycle,
    listeners: process
      .eventNames()
      .reduce((sum, name) => sum + process.listenerCount(name), 0),
    resources: active.length - timeouts,
    timeouts,
    // `/dev/fd` on macOS and Linux; the listing's own descriptor counts in every sample alike.
    fds: readdirSync("/dev/fd").length,
    heapMiB: process.memoryUsage().heapUsed / 2 ** 20,
  };
}

/**
 * Whether every measure stayed flat once warmed up: after the first `warmup` samples, none may
 * exceed the warm-up's highest value by more than its tolerance. A leak of one handle a run passes
 * a small warm-up spread only for a few runs, so it fails over a long soak.
 *
 * @param samples - in the order taken.
 * @param warmup - how many leading samples set the baseline; at least 1, fewer than `samples`.
 * @param tolerance - each measure's allowance over the baseline.
 * @returns one line per measure that grew, naming the first sample past its bound; none when flat.
 * @throws {@link RangeError} when the warm-up leaves no sample to judge, or is empty.
 */
export function judgeFlat(
  samples: readonly Sample[],
  warmup: number,
  tolerance: Tolerance,
): string[] {
  if (!Number.isSafeInteger(warmup) || warmup < 1 || warmup >= samples.length)
    throw new RangeError(
      `The warm-up must leave samples to judge: ${String(warmup)} of ${String(samples.length)}.`,
    );
  const base = samples.slice(0, warmup);
  const rest = samples.slice(warmup);
  const failures: string[] = [];
  for (const metric of Object.keys(tolerance) as FlatMetric[]) {
    const bound = Math.max(...base.map((s) => s[metric])) + tolerance[metric];
    const over = rest.find((s) => s[metric] > bound);
    if (over !== undefined)
      failures.push(
        `${metric} grew: ${String(over[metric])} after ${String(over.cycle)} runs, over the warm-up's bound of ${String(bound)}`,
      );
  }
  return failures;
}

/**
 * Pruning's cost per run folder, from the last prunings: the median of each one's time over its
 * folder count, so one slow call (a collection, a busy disk) does not decide it.
 *
 * @param timings - in the order taken.
 * @param last - how many of the latest to judge; at least 1.
 * @returns milliseconds per folder.
 * @throws {@link RangeError} when there are fewer timings than `last`, or one counts no folder.
 */
export function pruneMsPerFolder(
  timings: readonly PruneTiming[],
  last: number,
): number {
  if (!Number.isSafeInteger(last) || last < 1 || timings.length < last)
    throw new RangeError(
      `Needs the last ${String(last)} prunings, has ${String(timings.length)}.`,
    );
  const rates = timings.slice(-last).map(({ folders, ms }) => {
    if (folders < 1)
      throw new RangeError("A pruning counted no folder: its cost is unknown.");
    return ms / folders;
  });
  return median(rates);
}

/**
 * The median.
 *
 * @param values - at least one.
 * @returns the middle value, or the mean of the two middle ones.
 */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2;
}
