import { getOptionJson } from "../../../common/wp/options";
import { isObject } from "../../../common/guards";
import type { Transport } from "../../../common/config/types";

/**
 * The backup jobs a site has configured, read from the option BackWPup stores them in.
 *
 * This is the companion to `./backups.ts`: `wp backwpup job` reports the fields the **command**
 * chose to expose — contents, storages, cron — while a job's finer configuration (which file areas
 * it covers, which tables it skips) exists only in the stored option. Both are ground truth
 * independent of the DOM; this one simply reaches further.
 *
 * BackWPup keeps every job in the single site option {@link JOBS_OPTION}, as an array of records
 * each carrying its own `jobid`. The array is **not necessarily a packed list** — deleting a job
 * leaves a gap, and WP-CLI then serialises the whole thing as a JSON object — so the reader accepts
 * either shape and always returns a list.
 *
 * A note on **absent keys**, which is the one thing a caller must respect: BackWPup only stores an
 * option it has actually written. A file area nobody configured has no entry at all and falls back
 * to the plugin's own default; the reader reports that as absent rather than inventing `true`, so
 * an assertion can never mistake "defaulted" for "confirmed".
 */

/** The site option holding every configured job. Single-site, like the rest of this suite. */
export const JOBS_OPTION = "backwpup_jobs";

/**
 * Every top-level area a files backup can cover.
 *
 * Shared vocabulary rather than a page-object detail: the same five areas name a checkbox in the
 * UI and an option on the job, and {@link fileAreaOption} is the single place that maps between
 * them — so the UI and this reader cannot drift apart.
 */
export const FILE_AREAS = [
  "root",
  "content",
  "plugins",
  "themes",
  "uploads",
] as const;

/** One of the {@link FILE_AREAS}. */
export type FileArea = (typeof FILE_AREAS)[number];

/**
 * The job option recording whether `area` is included.
 *
 * These are the plugin's own long-standing option keys (`backuproot`, `backupcontent`, …), which
 * double as the checkbox `name` in the Select Files panel.
 */
export function fileAreaOption(area: FileArea): string {
  return `backup${area}`;
}

/**
 * What a job can be composed of, named the way a scenario talks about it.
 *
 * The three combinations are the plugin's own (`BackWPup_JobTypes::$type_job_files`,
 * `$type_job_database`, `$type_job_both`) — onboarding never produces any other mixture, because it
 * assigns one of these three constants wholesale.
 *
 * `WPPLUGIN` riding along with `FILE` is why "files" cannot simply be read as one slug: a files
 * backup also captures the plugin list.
 */
export const JOB_CONTENTS = {
  files: ["FILE", "WPPLUGIN"],
  database: ["DBDUMP"],
  "files and database": ["FILE", "DBDUMP", "WPPLUGIN"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/**
 * Names what a job covers, in the same words a scenario uses.
 *
 * Compared as a **set**, never as the joined string WP-CLI prints: the slug order is the plugin's
 * array order, and asserting on it would turn a harmless reordering into a failure while telling
 * nobody anything useful. Anything outside the three known combinations is returned verbatim, so a
 * mismatch reports what the job actually holds rather than just "not files".
 */
export function describeJobContents(type: readonly string[]): string {
  const actual = new Set(type.map((slug) => slug.trim().toUpperCase()));
  for (const [name, slugs] of Object.entries(JOB_CONTENTS)) {
    if (slugs.length === actual.size && slugs.every((s) => actual.has(s))) {
      return name;
    }
  }
  return [...actual].join(", ") || "(nothing)";
}

/** One configured backup job, as BackWPup stores it. */
export interface StoredJob {
  readonly jobId: number;
  /** Contents, in the plugin's own uppercase job-type slugs — e.g. `["FILE","DBDUMP","WPPLUGIN"]`. */
  readonly type: readonly string[];
  /** Destination slugs the job writes to — e.g. `["FOLDER"]`. */
  readonly destinations: readonly string[];
  /** The cron expression that schedules it, or `""` when none is stored. */
  readonly cron: string;
  /** The frequency the user picked (`hourly`/`daily`/`weekly`/`monthly`/`link`), or `""`. */
  readonly frequency: string;
  /** What drives the schedule (`wpcron`, `link`, …); empty while the job is disabled. */
  readonly activeType: string;
  /**
   * True for the placeholder job onboarding runs its first backup from. It is deliberately hidden
   * from the dashboard and from `wp backwpup job`, so a scenario counting "the site's jobs" must
   * exclude it — see {@link scheduledJobs}.
   */
  readonly tempJob: boolean;
  /**
   * True for the throwaway job a "Backup now" run creates. Hidden from `wp backwpup job` exactly
   * like {@link tempJob}, and excluded by {@link scheduledJobs} for the same reason.
   */
  readonly backupNow: boolean;
  /** Per-area include flags **actually stored** on the job; an area never configured is absent. */
  readonly includedAreas: Readonly<Partial<Record<FileArea, boolean>>>;
  /** Tables kept out of the database dump. Empty when every table is included. */
  readonly excludedTables: readonly string[];
}

/** Reads `key` as a list of strings, tolerating the absent and the malformed alike. */
function stringList(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** Reads `key` as a string. WP-CLI emits some scalars as numbers, so those are stringified. */
function text(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

/**
 * Reads `key` as a boolean, the way WordPress itself would.
 *
 * A value that survived a round-trip through the options table can arrive as a real boolean, as
 * `1`/`""`, or as `"1"`/`"0"`, so all three are collapsed to PHP's own notion of truthiness.
 */
function flag(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value !== "" && value !== "0";
  return false;
}

/** The include flags the job actually stores, leaving untouched areas out. */
function includedAreas(
  record: Record<string, unknown>,
): Partial<Record<FileArea, boolean>> {
  const areas: Partial<Record<FileArea, boolean>> = {};
  for (const area of FILE_AREAS) {
    if (fileAreaOption(area) in record) {
      areas[area] = flag(record, fileAreaOption(area));
    }
  }
  return areas;
}

/** Maps one stored record, or `undefined` if it carries no job id (BackWPup skips those too). */
function toStoredJob(value: unknown): StoredJob | undefined {
  if (!isObject(value)) return undefined;
  const jobId = Number(value.jobid);
  if (!Number.isInteger(jobId) || jobId <= 0) return undefined;
  return {
    jobId,
    type: stringList(value, "type"),
    destinations: stringList(value, "destinations"),
    cron: text(value, "cron"),
    frequency: text(value, "frequency"),
    activeType: text(value, "activetype"),
    tempJob: flag(value, "tempjob"),
    backupNow: flag(value, "backup_now"),
    includedAreas: includedAreas(value),
    excludedTables: stringList(value, "dbdumpexclude"),
  };
}

/**
 * Every job the site has stored, including the hidden placeholder ones.
 *
 * @param transport - the site to ask.
 * @returns the jobs, in the order the option holds them; empty when the option does not exist,
 * which is what a site with no configured jobs looks like.
 * @throws {@link Error} if the option exists but cannot be read or decoded — a broken read must
 * never pass as "no jobs".
 */
export async function readStoredJobs(
  transport: Transport,
): Promise<readonly StoredJob[]> {
  const raw = await getOptionJson<unknown>(transport, JOBS_OPTION);
  if (raw === undefined) return [];
  const records = Array.isArray(raw)
    ? raw
    : isObject(raw)
      ? Object.values(raw)
      : [];
  return records
    .map(toStoredJob)
    .filter((job): job is StoredJob => job !== undefined);
}

/**
 * The jobs a user would call "their backups" — everything except the placeholders.
 *
 * Mirrors the filter `wp backwpup job` applies before listing (`Cli/Commands/Job.php`), so a count
 * taken here and a count taken from the command cannot disagree. That command skips a record with
 * no `jobid` (which {@link readStoredJobs} already drops), one flagged `tempjob`, one flagged
 * `backup_now`, and the one whose id matches the site option `backwpup_backup_now_job_id`.
 *
 * The last of those is not re-checked: the plugin writes that option and the record's own
 * `backup_now` flag in the same breath (`Abilities/Jobs/RunJob.php`, `Backups/API/Rest.php`), so
 * the flag already covers every such job — and reading it would cost a second round-trip on every
 * call to answer a question the record has answered.
 */
export function scheduledJobs(
  jobs: readonly StoredJob[],
): readonly StoredJob[] {
  return jobs.filter((job) => !job.tempJob && !job.backupNow);
}
