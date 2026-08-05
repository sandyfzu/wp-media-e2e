import { wpCli } from "../../../common/wp/exec";
import type { Transport } from "../../../common/config/types";

/**
 * WP-CLI readers for BackWPup's backups and jobs — the **ground truth** behind every count,
 * status and storage assertion.
 *
 * The baseline scraped the history table with `td:nth-child(n)` and counted `<td>`s to guess the
 * plugin's table layout. That asserts the DOM against itself: it cannot tell a genuinely missing
 * backup from a renamed column. These readers come from a different source entirely — WP-CLI's
 * own structured output — so a scenario can assert the UI *and* the underlying state and only pass
 * when the two agree.
 *
 * Fields are typed to exactly what the commands document (`Backup.php:63-75`, `Job.php:89-104`,
 * verified at the ref under test). Prefer `sizeBytes`/`timeUnix` over the humanised `size`/`time`:
 * the latter are locale- and timezone-formatted for display and make brittle assertions.
 *
 * Both commands exist in **Free and Pro** (V3), so nothing here is edition-gated.
 */

/** WP-CLI's raw `wp backwpup backup --format=json` record, before camel-casing. */
interface RawBackupRecord {
  readonly name: string;
  readonly time: string;
  readonly size: string;
  readonly storage: string;
  readonly type: string;
  readonly folder?: string;
  readonly file?: string;
  readonly job_id?: string | number;
  readonly size_bytes?: string | number;
  readonly time_unix?: string | number;
}

/** WP-CLI's raw `wp backwpup job --format=json` record, before camel-casing. */
interface RawJobRecord {
  readonly job_id: string | number;
  readonly name: string;
  readonly active_type: string;
  readonly type: string;
  readonly storages: string;
  readonly cron: string;
  readonly last_run: string;
  readonly last_runtime: string;
}

/** One archive in BackWPup's backup history, as WP-CLI reports it. */
export interface BackupRecord {
  /** Archive filename, e.g. `2026-07-30_09-12-44_ABCDEF_DBDUMP.tar.gz`. */
  readonly name: string;
  /** Human-formatted creation time (display-formatted — assert on {@link timeUnix} instead). */
  readonly time: string;
  /** Human-formatted size (display-formatted — assert on {@link sizeBytes} instead). */
  readonly size: string;
  /** Destination slug the archive lives on, lower-cased by the plugin (e.g. `folder`, `ftp`). */
  readonly storage: string;
  /** Comma-separated backup contents, e.g. `file, dbdump, wpplugin`. */
  readonly type: string;
  /** Id of the job that produced it, when requested. */
  readonly jobId?: number;
  /** Exact byte size, when requested. The assertion-grade counterpart of {@link size}. */
  readonly sizeBytes?: number;
  /** Unix creation timestamp, when requested. The assertion-grade counterpart of {@link time}. */
  readonly timeUnix?: number;
}

/** One configured backup job, as WP-CLI reports it. */
export interface JobRecord {
  readonly jobId: number;
  readonly name: string;
  /** Which schedule drives it (e.g. `wpcron`, `easycron`, `link`), or empty when inactive. */
  readonly activeType: string;
  /** Comma-separated job contents (e.g. `DBDUMP, FILE`). */
  readonly type: string;
  /** Comma-separated destination slugs. */
  readonly storages: string;
  /** The cron expression, when scheduled. */
  readonly cron: string;
  readonly lastRun: string;
  readonly lastRuntime: string;
}

/**
 * Parses WP-CLI JSON output into an array.
 *
 * WP-CLI prints `[]`-wrapped JSON for list commands, but an **empty** list can also arrive as an
 * empty string on some commands, so that is normalised to `[]` rather than throwing. Anything else
 * unparseable throws with the raw output attached, because silently returning `[]` there would
 * turn a broken command into a passing "no backups yet" assertion — the exact false negative these
 * readers exist to prevent.
 */
function parseList(stdout: string, command: string): readonly unknown[] {
  const trimmed = stdout.trim();
  if (trimmed === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(
      `[backwpup/backups] \`wp ${command}\` did not return JSON. Output was: ${trimmed.slice(0, 500)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `[backwpup/backups] \`wp ${command}\` returned ${typeof parsed}, expected a JSON array.`,
    );
  }
  return parsed;
}

/**
 * Coerces WP-CLI's numeric-ish field to a number.
 *
 * WP-CLI emits numbers as strings in some formats and as numbers in others, so both are accepted;
 * anything absent or non-numeric yields `undefined` rather than `NaN`, which would quietly poison
 * a comparison.
 */
function optionalNumber(
  value: string | number | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Runs a `wp backwpup …` command and returns its parsed JSON list. */
async function readList<T>(
  transport: Transport,
  args: readonly string[],
): Promise<readonly T[]> {
  const argv = ["backwpup", ...args, "--format=json"];
  const result = await wpCli(transport, argv);
  if (result.exitCode !== 0) {
    throw new Error(
      `[backwpup/backups] \`wp ${argv.join(" ")}\` exited ${String(result.exitCode)}: ` +
        (result.stderr.trim() || "(no stderr)"),
    );
  }
  return parseList(result.stdout, argv.join(" ")) as readonly T[];
}

/**
 * Every archive in the backup history, newest first (the plugin's own ordering).
 *
 * Requests the optional `job_id`, `size_bytes` and `time_unix` fields alongside the defaults, so
 * callers always have assertion-grade values without a second round-trip.
 */
export async function listBackups(
  transport: Transport,
): Promise<readonly BackupRecord[]> {
  const raw = await readList<RawBackupRecord>(transport, [
    "backup",
    "--fields=name,time,size,storage,type,job_id,size_bytes,time_unix",
  ]);
  return raw.map((r) => ({
    name: r.name,
    time: r.time,
    size: r.size,
    storage: r.storage,
    type: r.type,
    ...(optionalNumber(r.job_id) === undefined
      ? {}
      : { jobId: optionalNumber(r.job_id) }),
    ...(optionalNumber(r.size_bytes) === undefined
      ? {}
      : { sizeBytes: optionalNumber(r.size_bytes) }),
    ...(optionalNumber(r.time_unix) === undefined
      ? {}
      : { timeUnix: optionalNumber(r.time_unix) }),
  }));
}

/** Every configured backup job. */
export async function listJobs(
  transport: Transport,
): Promise<readonly JobRecord[]> {
  const raw = await readList<RawJobRecord>(transport, ["job"]);
  return raw.map((r) => ({
    jobId: optionalNumber(r.job_id) ?? 0,
    name: r.name,
    activeType: r.active_type,
    type: r.type,
    storages: r.storages,
    cron: r.cron,
    lastRun: r.last_run,
    lastRuntime: r.last_runtime,
  }));
}

/**
 * How many archives the history holds.
 *
 * Uses `--format=count`, which the plugin computes itself — so it stays correct even if a future
 * version changes the record shape, and it is the cheapest possible "did a backup land?" probe.
 */
export async function countBackups(transport: Transport): Promise<number> {
  const result = await wpCli(transport, [
    "backwpup",
    "backup",
    "--format=count",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `[backwpup/backups] \`wp backwpup backup --format=count\` exited ` +
        `${String(result.exitCode)}: ${result.stderr.trim() || "(no stderr)"}`,
    );
  }
  const count = Number(result.stdout.trim());
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(
      `[backwpup/backups] expected an integer count, got "${result.stdout.trim()}".`,
    );
  }
  return count;
}

/** How a backup job ended, as reported by `wp backwpup status`. */
export type JobOutcome = "idle" | "finished" | "warnings" | "errors";

/**
 * Blocks until no backup job is running, then reports how the job ended.
 *
 * **`wp backwpup status` is not a state probe — it is a blocking wait.** Verified in
 * `Cli/Commands/Status.php`: when a job is running it enters a `while (true)` loop that ticks a
 * progress bar until the plugin's `running_file` disappears, and only then prints a verdict. So it
 * must never be used to poll ("is it running?") — such a call would hang for the whole job — but it
 * is exactly the right primitive for "wait for the backup to finish", replacing the baseline's
 * 3-minute fixed sleep with a wait as short as the job actually takes.
 *
 * The four outcomes come from the command's own terminal lines:
 *   - `Success: No job running.`          → nothing was running when asked (`idle`)
 *   - `Success: Job finished.`            → completed clean (`finished`)
 *   - `Warning: Job finished with warnings.` → completed, non-fatal problems (`warnings`)
 *   - `Error: Job finished with errors!`  → failed; WP-CLI exits non-zero (`errors`)
 *
 * The caller decides which outcomes are acceptable — this reports, it does not judge, so a
 * scenario asserting "the backup succeeded" and one deliberately provoking a failure can share it.
 *
 * @param transport - the site to ask.
 * @throws {@link Error} if the command fails for any reason other than a job ending in errors,
 * since that means the state could not be determined at all.
 */
export async function waitForJobToFinish(
  transport: Transport,
): Promise<JobOutcome> {
  const result = await wpCli(transport, ["backwpup", "status"]);
  const output = `${result.stdout}\n${result.stderr}`;

  if (/Job finished with errors/i.test(output)) return "errors";
  if (/Job finished with warnings/i.test(output)) return "warnings";
  if (/No job running/i.test(output)) return "idle";
  if (/Job finished/i.test(output)) return "finished";

  throw new Error(
    `[backwpup/backups] \`wp backwpup status\` exited ${String(result.exitCode)} with no ` +
      `recognisable verdict. Output was: ${output.trim().slice(0, 500)}`,
  );
}
