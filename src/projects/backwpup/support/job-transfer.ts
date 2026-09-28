import { backwpupCli, describeCli } from "./cli";
import { JOBS_OPTION } from "./job-options";
import { evalPhp, phpLiteral } from "../../../common/wp/php";
import { isObject } from "../../../common/guards";
import type { Transport } from "../../../common/config/types";

/**
 * What `wp backwpup job-export` wrote and what `job-import` did with it, compared on the site.
 *
 * **Only key names and yes-or-no answers leave the site.** An export carries the site's database
 * host, name and user, and every stored job carries the site's database password, encrypted — so
 * each comparison between a file and the jobs it came from, or went into, runs in PHP there and
 * reports which keys differ, never what they hold. A failure message can then quote an answer whole.
 *
 * **The stored jobs are the second source.** The file is the command under test's own output; what
 * it is held to is the option the plugin keeps its jobs in, read raw — no defaults merged in — as the
 * export itself reads it.
 */

/**
 * The keys `job-export` leaves out of every job, as its source lists them: the schedule's state, the
 * run history and the plugin's own flags. It also leaves out every empty value and every encrypted
 * one.
 */
export const STRIPPED_KEYS = [
  "tempjob",
  "lastrun",
  "lastruntime",
  "legacy",
  "activetype",
  "activ",
  "backup_ids",
  "logfile",
  "lastbackupdownloadurl",
] as const;

/** One job in an export file, as the site describes it: its id, its keys, and which are encrypted. */
export interface ExportedJob {
  readonly jobId: number;
  readonly keys: readonly string[];
  /** The keys whose value is a BackWPup-encrypted string. */
  readonly encrypted: readonly string[];
}

/** A stored job's keys, and which of them hold a BackWPup-encrypted string. */
export interface StoredJobKeys {
  readonly keys: readonly string[];
  readonly encrypted: readonly string[];
}

/** PHP defining `$encrypted`, which tells a value BackWPup stores encrypted: `$BackWPup$…`. */
const ENCRYPTED_PHP =
  "$encrypted = function ( $value ) { return is_string( $value ) && 0 === strpos( $value, '$BackWPup$' ); };\n";

/**
 * PHP reading the export file at `path` into `$jobs`, and stopping unless it is a non-empty list of
 * jobs, each carrying its id.
 */
function readExportPhp(path: string): string {
  return (
    `$path = ${phpLiteral(path)};\n` +
    "if ( ! is_file( $path ) ) {\n" +
    "\tWP_CLI::error( 'no export file at ' . $path );\n" +
    "}\n" +
    "$jobs = json_decode( (string) file_get_contents( $path ), true );\n" +
    "if ( ! is_array( $jobs ) || array() === $jobs ) {\n" +
    "\tWP_CLI::error( 'the file at ' . $path . ' is not a list of jobs' );\n" +
    "}\n" +
    "foreach ( $jobs as $job ) {\n" +
    "\tif ( ! is_array( $job ) || ! isset( $job['jobid'] ) ) {\n" +
    "\t\tWP_CLI::error( 'the file at ' . $path . ' holds something that is not a job' );\n" +
    "\t}\n" +
    "}\n"
  );
}

/** PHP reading the one job the export file holds into `$exported`, and stopping if it holds more. */
function readOneExportedJobPhp(path: string): string {
  return (
    readExportPhp(path) +
    "if ( 1 !== count( $jobs ) ) {\n" +
    "\tWP_CLI::error( 'the file at ' . $path . ' holds ' . count( $jobs ) . ' jobs, not one' );\n" +
    "}\n" +
    "$exported = reset( $jobs );\n"
  );
}

/** PHP reading the stored record of job `jobId` into `$stored`, raw, and stopping if there is none. */
function readStoredJobPhp(jobId: number): string {
  return (
    `$id = ${phpLiteral(jobId)};\n` +
    "$stored = null;\n" +
    `foreach ( (array) get_site_option( ${phpLiteral(JOBS_OPTION)}, [] ) as $candidate ) {\n` +
    "\tif ( is_array( $candidate ) && isset( $candidate['jobid'] ) && (int) $candidate['jobid'] === $id ) {\n" +
    "\t\t$stored = $candidate;\n" +
    "\t}\n" +
    "}\n" +
    "if ( null === $stored ) {\n" +
    "\tWP_CLI::error( 'the site stores no job ' . $id );\n" +
    "}\n"
  );
}

/** Decodes a reply as JSON, refusing one that is not. */
function decode(reply: string, what: string): unknown {
  try {
    return JSON.parse(reply);
  } catch {
    throw new Error(
      `[backwpup/job-transfer] ${what} did not come back as JSON: ${reply.slice(0, 300) || "(empty)"}`,
    );
  }
}

/** Whether a value is a list of strings. */
function isStringList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/**
 * Reads a list of key names out of a reply.
 *
 * @throws {@link Error} if the reply is not a JSON list of strings.
 */
export function parseKeyNames(reply: string, what: string): readonly string[] {
  const parsed = decode(reply, what);
  if (!isStringList(parsed)) {
    throw new Error(
      `[backwpup/job-transfer] ${what} came back as ${reply.slice(0, 300)}, not a list of key names.`,
    );
  }
  return parsed;
}

/**
 * Reads the site's description of an export file's jobs.
 *
 * @throws {@link Error} if the reply is not a list of jobs, each with a positive id and its keys.
 */
export function parseExportedJobs(reply: string): readonly ExportedJob[] {
  const parsed = decode(reply, "describing the export file");
  if (!Array.isArray(parsed)) {
    throw new Error(
      `[backwpup/job-transfer] expected the export file's jobs, got ${reply.slice(0, 300)}.`,
    );
  }
  return parsed.map((entry: unknown) => {
    const { job_id: jobId, keys, encrypted } = isObject(entry) ? entry : {};
    if (
      typeof jobId !== "number" ||
      !Number.isInteger(jobId) ||
      jobId <= 0 ||
      !isStringList(keys) ||
      !isStringList(encrypted)
    ) {
      throw new Error(
        `[backwpup/job-transfer] expected a job's id and keys, got ${JSON.stringify(entry)}.`,
      );
    }
    return { jobId, keys, encrypted };
  });
}

/**
 * The jobs an export file holds, as the site reads the file: each one's id, its keys, and which of
 * them hold an encrypted value.
 *
 * @param transport - the site holding the file.
 * @param path - its absolute path on that site.
 * @throws {@link Error} if there is no file, it is not a non-empty list of jobs, or the reply is not
 * the description asked for.
 */
export async function describeExport(
  transport: Transport,
  path: string,
): Promise<readonly ExportedJob[]> {
  const reply = await evalPhp(
    transport,
    readExportPhp(path) +
      ENCRYPTED_PHP +
      "$out = [];\n" +
      "foreach ( $jobs as $job ) {\n" +
      "\t$out[] = [ 'job_id' => (int) $job['jobid'], 'keys' => array_map( 'strval', array_keys( $job ) ), 'encrypted' => array_map( 'strval', array_keys( array_filter( $job, $encrypted ) ) ) ];\n" +
      "}\n" +
      "echo wp_json_encode( $out );",
    "describing the export file",
    "backwpup/job-transfer",
  );
  return parseExportedJobs(reply);
}

/**
 * A stored job's keys, and which of them hold an encrypted value — read raw from the jobs option.
 *
 * @param transport - the site to ask.
 * @param jobId - the job.
 * @throws {@link Error} if the site stores no such job, or the reply is not its keys.
 */
export async function describeStoredJob(
  transport: Transport,
  jobId: number,
): Promise<StoredJobKeys> {
  const reply = await evalPhp(
    transport,
    readStoredJobPhp(jobId) +
      ENCRYPTED_PHP +
      "echo wp_json_encode( [ 'keys' => array_map( 'strval', array_keys( $stored ) ), 'encrypted' => array_map( 'strval', array_keys( array_filter( $stored, $encrypted ) ) ) ] );",
    `describing job ${String(jobId)}`,
    "backwpup/job-transfer",
  );
  const parsed = decode(reply, `describing job ${String(jobId)}`);
  const { keys, encrypted } = isObject(parsed) ? parsed : {};
  if (!isStringList(keys) || !isStringList(encrypted)) {
    throw new Error(
      `[backwpup/job-transfer] expected job ${String(jobId)}'s keys, got ${reply.slice(0, 300)}.`,
    );
  }
  return { keys, encrypted };
}

/**
 * The settings the one job in an export file carries that a stored job does **not** hold as the file
 * does — compared on the site, value against value, and answered as key names.
 *
 * @param transport - the site holding both.
 * @param path - the export file's absolute path on that site.
 * @param jobId - the stored job to hold the file to.
 * @param ignoring - keys to leave out of the comparison — `jobid`, for a copy stored under a new id.
 * @returns the differing keys, in the file's order; empty when the job holds everything the file
 * carries.
 * @throws {@link Error} if the file does not hold exactly one job, the site stores no such job, or
 * the reply is not a list of keys.
 */
export async function settingsDifferingFromExport(
  transport: Transport,
  path: string,
  jobId: number,
  ignoring: readonly string[] = [],
): Promise<readonly string[]> {
  const reply = await evalPhp(
    transport,
    readOneExportedJobPhp(path) +
      readStoredJobPhp(jobId) +
      `$ignoring = ${phpLiteral(ignoring)};\n` +
      "$differing = [];\n" +
      "foreach ( $exported as $key => $value ) {\n" +
      "\tif ( in_array( (string) $key, $ignoring, true ) ) {\n" +
      "\t\tcontinue;\n" +
      "\t}\n" +
      "\tif ( ! array_key_exists( $key, $stored ) || wp_json_encode( $stored[ $key ] ) !== wp_json_encode( $value ) ) {\n" +
      "\t\t$differing[] = (string) $key;\n" +
      "\t}\n" +
      "}\n" +
      "echo wp_json_encode( $differing );",
    `comparing the export file with job ${String(jobId)}`,
    "backwpup/job-transfer",
  );
  return parseKeyNames(
    reply,
    `comparing the export file with job ${String(jobId)}`,
  );
}

/**
 * The settings a stored job holds that the one job in an export file leaves out **beyond** what
 * `job-export` leaves out by design — the {@link STRIPPED_KEYS}, an empty string and an encrypted
 * value — compared on the site and answered as key names.
 *
 * The other half of "the file carries the job's settings": {@link settingsDifferingFromExport}
 * holds what the file carries to the job, which a file carrying next to nothing would pass.
 *
 * @param transport - the site holding both.
 * @param path - the export file's absolute path on that site.
 * @param jobId - the stored job the file was exported from.
 * @returns the keys left out, in the job's order; empty when the file carries every other setting.
 * @throws {@link Error} if the file does not hold exactly one job, the site stores no such job, or
 * the reply is not a list of keys.
 */
export async function settingsMissingFromExport(
  transport: Transport,
  path: string,
  jobId: number,
): Promise<readonly string[]> {
  const what = `comparing job ${String(jobId)} with the export file`;
  const reply = await evalPhp(
    transport,
    readOneExportedJobPhp(path) +
      readStoredJobPhp(jobId) +
      ENCRYPTED_PHP +
      `$stripped = ${phpLiteral(STRIPPED_KEYS)};\n` +
      "$missing = [];\n" +
      "foreach ( $stored as $key => $value ) {\n" +
      "\tif ( '' === $value || $encrypted( $value ) || in_array( (string) $key, $stripped, true ) ) {\n" +
      "\t\tcontinue;\n" +
      "\t}\n" +
      "\tif ( ! array_key_exists( $key, $exported ) ) {\n" +
      "\t\t$missing[] = (string) $key;\n" +
      "\t}\n" +
      "}\n" +
      "echo wp_json_encode( $missing );",
    what,
    "backwpup/job-transfer",
  );
  return parseKeyNames(reply, what);
}

/**
 * A digest of the jobs option exactly as the database holds it — read from its row, past every
 * cache — so "the site's jobs are as they were" is one comparison, whatever changed.
 *
 * @param transport - the site to ask.
 * @returns the row's SHA-256, lower-case hex.
 * @throws {@link Error} if the site stores no jobs at all, or the reply is not a digest.
 */
export async function jobsDigest(transport: Transport): Promise<string> {
  const reply = await evalPhp(
    transport,
    "global $wpdb;\n" +
      `$raw = $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", ${phpLiteral(JOBS_OPTION)} ) );\n` +
      "if ( null === $raw ) {\n" +
      "\tWP_CLI::error( 'the site stores no jobs option' );\n" +
      "}\n" +
      "echo hash( 'sha256', $raw );",
    "digesting the site's jobs",
    "backwpup/job-transfer",
  );
  if (!/^[0-9a-f]{64}$/.test(reply)) {
    throw new Error(
      `[backwpup/job-transfer] expected a digest of the site's jobs, got ${JSON.stringify(reply.slice(0, 200))}.`,
    );
  }
  return reply;
}

/**
 * Renames the one job an export file holds, in the file — the edit a user makes to an export before
 * importing it over the job it came from. The file is rewritten as `job-export` writes it, a JSON
 * object keyed as it was, and read back.
 *
 * @param transport - the site holding the file.
 * @param path - its absolute path on that site.
 * @param name - the job's new name.
 * @throws {@link Error} if the file does not hold exactly one job, could not be written, or did not
 * read back renamed.
 */
export async function nameExportedJob(
  transport: Transport,
  path: string,
  name: string,
): Promise<void> {
  const reply = await evalPhp(
    transport,
    readOneExportedJobPhp(path) +
      `$name = ${phpLiteral(name)};\n` +
      "$key = array_key_first( $jobs );\n" +
      "$jobs[ $key ]['name'] = $name;\n" +
      "if ( false === file_put_contents( $path, wp_json_encode( $jobs, JSON_PRETTY_PRINT ) ) ) {\n" +
      "\tWP_CLI::error( 'could not write ' . $path );\n" +
      "}\n" +
      "$back = json_decode( (string) file_get_contents( $path ), true );\n" +
      "echo is_array( $back ) && array_keys( $back ) === array_keys( $jobs ) && ( $back[ $key ]['name'] ?? null ) === $name ? 'named' : 'differs';",
    "renaming the job in the export file",
    "backwpup/job-transfer",
  );
  if (reply !== "named") {
    throw new Error(
      `[backwpup/job-transfer] the export file did not read back with its job renamed (${JSON.stringify(reply.slice(0, 200))}).`,
    );
  }
}

/**
 * Exports one job to a file, as the arrangement of a scenario about what happens to that file next —
 * so a refusal here is a broken precondition, and throws.
 *
 * @param transport - the site to run on.
 * @param jobId - the job to export.
 * @param file - where `--file` points: a path relative to WP-CLI's working directory.
 * @throws {@link Error} if the command did not succeed.
 */
export async function exportJob(
  transport: Transport,
  jobId: number,
  file: string,
): Promise<void> {
  const result = await backwpupCli(transport, [
    "job-export",
    String(jobId),
    `--file=${file}`,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `[backwpup/job-transfer] exporting job ${String(jobId)} failed — ${describeCli(result)}`,
    );
  }
}

/**
 * The exports a scenario arranged, each with the digest of the site's jobs when it was made — the
 * reference point "the site's jobs are as they were" is measured against.
 */
export class JobExports {
  /** Each export's digest of the jobs, by the file's name. */
  private readonly digests = new Map<string, string>();

  /** Records the digest of the site's jobs as an export was made. */
  record(file: string, digest: string): void {
    this.digests.set(file, digest);
  }

  /**
   * The digest of the site's jobs when `file` was exported.
   *
   * @throws {@link Error} if the scenario never recorded that export — there is nothing to compare
   * with, and a comparison with nothing must not pass.
   */
  digestAt(file: string): string {
    const digest = this.digests.get(file);
    if (digest === undefined) {
      throw new Error(
        `[backwpup/job-transfer] "${file}" was never exported by an arranging step, so the site's ` +
          'jobs have no "as they were" to compare with. Export it with "the scheduled job has been ' +
          'exported to …" first.',
      );
    }
    return digest;
  }
}
