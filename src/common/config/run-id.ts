/**
 * The run token, `RUN_ID`: the name of a run's report folder. The suite stamps one per invocation
 * (`run-context.ts`) and the orchestrator pins its own; the report pruning reads back when a run
 * started from it. One formatter and one parser, so the producer and the reader cannot drift.
 *
 * The format is the start time, ISO 8601 in UTC with `:` and `.` turned to `-` (a folder name on
 * every filesystem, lexically sortable), then `-` and a suffix that keeps two runs of one millisecond
 * apart — the suite's process id, or the orchestrator's run id.
 *
 * Free of side effects (no `.env`, no environment read), so a long-lived process can import it.
 *
 * @example
 * ```ts
 * formatRunId(new Date("2026-06-19T14:03:22.123Z"), "48217"); // "2026-06-19T14-03-22-123Z-48217"
 * parseRunId("2026-06-19T14-03-22-123Z-48217"); // { time: 1781877802123, suffix: "48217" }
 * ```
 */

/** A RUN_ID's two halves. */
export interface ParsedRunId {
  /** When the run started, in epoch milliseconds. */
  readonly time: number;
  /** What follows the time: a process id, or the orchestrator's run id. */
  readonly suffix: string;
}

/** What a suffix may hold: one folder-name-safe word, never empty. */
const SUFFIX = /^[A-Za-z0-9._-]+$/;

/** A formatted RUN_ID, its parts captured: the date, the time to the millisecond, the suffix. */
const RUN_ID_FORMAT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-([A-Za-z0-9._-]+)$/;

/** The longest folder name the common filesystems accept, in bytes. */
const MAX_NAME_BYTES = 255;

/**
 * Formats a RUN_ID that {@link parseRunId} reads back to the same millisecond.
 *
 * @param date - when the run started: a year from 0100 to 9999.
 * @param suffix - the run's own part: letters, digits, `.`, `_` and `-` only.
 * @returns the token, e.g. `2026-06-19T14-03-22-123Z-48217`.
 * @throws {@link RangeError} for an invalid date, a year outside 0100–9999, or a bad suffix.
 */
export function formatRunId(date: Date, suffix: string): string {
  if (!SUFFIX.test(suffix)) {
    throw new RangeError(
      `A RUN_ID suffix must be letters, digits, ".", "_" or "-", got "${suffix}".`,
    );
  }
  // Throws RangeError itself for an invalid date.
  const iso = date.toISOString();
  const id = `${iso.replace(/[:.]/g, "-")}-${suffix}`;
  // Checked by reading it back: a year past 9999 reads "+010000-…", and `Date.UTC` reads a year
  // below 100 as 19xx — neither would date the run it names.
  if (parseRunId(id)?.time !== date.getTime()) {
    throw new RangeError(
      `A RUN_ID needs a four-digit year from 0100 to 9999, got ${iso}.`,
    );
  }
  return id;
}

/**
 * Parses a RUN_ID {@link formatRunId} could have made. Strict: the date must exist — `Date.UTC`
 * silently rolls 2026-02-30 over to March (and 9999-12-31T24 into the year 10000), so every part of
 * the result is checked against the input. Never throws: any folder name may be handed to it.
 *
 * @param value - a report folder's name.
 * @returns its start time and suffix, or `undefined` for anything else (a pinned RUN_ID may be
 *   any folder name).
 */
export function parseRunId(value: string): ParsedRunId | undefined {
  const match = RUN_ID_FORMAT.exec(value);
  if (match === null) return undefined;
  const [, ...captured] = match;
  const suffix = captured.pop();
  const parts = captured.map(Number);
  const [year, month, day, hour, minute, second, ms] = parts;
  if (
    suffix === undefined ||
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    ms === undefined
  ) {
    return undefined;
  }
  const date = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second, ms),
  );
  // `Date.UTC` maps years 0–99 onto 1900–1999, so a year below 100 never matches either.
  const roundTrips =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second &&
    date.getUTCMilliseconds() === ms;
  return roundTrips ? { time: date.getTime(), suffix } : undefined;
}

/**
 * Whether a value can name a run's report folder: one path segment, not hidden, no control
 * character (C0, DEL or C1), at most 255 bytes. A pinned RUN_ID is otherwise free-form; this keeps it from writing
 * a report outside its cell's folder (`../…`), or under a name the report pruning reads as its own
 * hidden, in-removal folder.
 *
 * @param value - the RUN_ID.
 */
export function isUsableRunId(value: string): boolean {
  return (
    value !== "" &&
    !value.startsWith(".") &&
    !value.includes("/") &&
    !value.includes("\\") &&
    // eslint-disable-next-line no-control-regex -- refusing control characters is the point.
    !/[\u0000-\u001f\u007f-\u009f]/.test(value) &&
    Buffer.byteLength(value, "utf8") <= MAX_NAME_BYTES
  );
}

/**
 * A run's report folder: `<root>/<product>/<cell>/<RUN_ID>`. The suite writes there, and the
 * orchestrator reads a run's results back from there, so both build it here — the orchestrator
 * cannot import `run-context.ts`, which loads `.env` and stamps a `RUN_ID` as it is imported.
 *
 * @param root - the reports' root, relative to the checkout or absolute (`reports` by default).
 * @param product - the product's name.
 * @param cell - the cell.
 * @param runId - the run's RUN_ID.
 * @returns the folder, relative or absolute as `root` is.
 */
export function runReportDir(
  root: string,
  product: string,
  cell: string,
  runId: string,
): string {
  return `${root}/${product}/${cell}/${runId}`;
}
