import { evalPhp, phpLiteral } from "../../../common/wp/php";
import { isObject } from "../../../common/guards";
import { BACKUP_HISTORY_TABLE } from "./db-residue";
import type { Transport } from "../../../common/config/types";

/**
 * BackWPup's own record of the backups it made: its history table.
 *
 * **Why read the table when `wp backwpup backup` lists backups too.** That command lists the files
 * it finds on each job's destinations; this table is written by the **run** — a row when the archive
 * is created, marked `completed` once a destination has it — and is what the dashboard's history
 * reads. Different code, so a scenario testing the command can check it here without comparing the
 * command with itself.
 *
 * Single-site, like the rest of this suite: the table is read under the site's own prefix.
 */

/** One history row: an archive a run produced, on one destination. */
export interface HistoryRecord {
  /** The archive's filename; empty when the row names none. */
  readonly filename: string;
  /** The destination slug, as the plugin registers it — e.g. `FOLDER`. */
  readonly destination: string;
  /** The job that made it, when the row records one. */
  readonly jobId?: number;
  /** `created` until the destination has the archive, then `completed` — or `failed` / `aborted`. */
  readonly status: string;
  /**
   * What started the run, in the plugin's own words: `backup_now_job` for `run --background`, and
   * `wp-cli` for a foreground `run`.
   */
  readonly trigger: string;
}

/**
 * PHP that reads every history row, oldest first, into `$rows` — for a snippet that reports them
 * alongside something else, as the running-job reader does.
 *
 * A failed query is turned into an error rather than left in `$rows`: `$wpdb` answers a missing
 * table with an empty result and a note in `last_error`, which would otherwise read as "no backups
 * yet" — the one wrong answer that makes an absence assertion pass.
 */
export const HISTORY_ROWS_PHP = `
global $wpdb;
$table = $wpdb->prefix . ${phpLiteral(BACKUP_HISTORY_TABLE)};
$rows  = $wpdb->get_results( "SELECT filename, destination, job_id, status, backup_trigger FROM \`{$table}\` ORDER BY id", ARRAY_A );
if ( $wpdb->last_error ) {
	WP_CLI::error( 'reading ' . $table . ' failed: ' . $wpdb->last_error );
}
`;

/** The PHP that prints every history row, oldest first, as JSON. */
export const HISTORY_PHP = `${HISTORY_ROWS_PHP}echo wp_json_encode( $rows );
`;

/** The message for a column holding something its type cannot. */
function unexpected(
  row: Record<string, unknown>,
  column: string,
  wanted: string,
): Error {
  return new Error(
    `[backwpup/history] expected "${column}" to be ${wanted}, got ${JSON.stringify(row[column])} in ${JSON.stringify(row)}.`,
  );
}

/** Reads a text column; `nullable` ones read `NULL` as empty. */
function textColumn(
  row: Record<string, unknown>,
  column: string,
  nullable = false,
): string {
  const value = row[column];
  if (typeof value === "string") return value;
  if (nullable && value === null) return "";
  throw unexpected(row, column, "text");
}

/**
 * Reads a nullable integer column. `$wpdb` hands numbers over as strings unless the database driver
 * is set to return native types, so both spellings of the same value are accepted.
 */
function integerColumn(
  row: Record<string, unknown>,
  column: string,
): number | undefined {
  const value = row[column];
  if (value === null) return undefined;
  const number =
    typeof value === "number" ||
    (typeof value === "string" && value.trim() !== "")
      ? Number(value)
      : Number.NaN;
  if (!Number.isInteger(number)) throw unexpected(row, column, "an integer");
  return number;
}

/** Maps one row, refusing a shape the table does not produce rather than guessing at it. */
function toHistoryRecord(row: unknown): HistoryRecord {
  if (!isObject(row)) {
    throw new Error(
      `[backwpup/history] expected a row, got ${JSON.stringify(row)}.`,
    );
  }
  // Of the columns read, the schema lets only `filename` and `job_id` be NULL.
  const jobId = integerColumn(row, "job_id");
  return {
    filename: textColumn(row, "filename", true),
    destination: textColumn(row, "destination"),
    ...(jobId === undefined ? {} : { jobId }),
    status: textColumn(row, "status"),
    trigger: textColumn(row, "backup_trigger"),
  };
}

/**
 * Maps the rows {@link HISTORY_ROWS_PHP} read, once decoded from JSON.
 *
 * @param rows - the decoded `$rows`.
 * @throws {@link Error} if they are not a list of rows shaped like the table's — a reply that
 * cannot be read must never pass as an empty history.
 */
export function historyRecords(rows: unknown): readonly HistoryRecord[] {
  if (!Array.isArray(rows)) {
    throw new Error(
      `[backwpup/history] expected a list of rows, got ${JSON.stringify(rows)}.`,
    );
  }
  return rows.map(toHistoryRecord);
}

/**
 * Parses what {@link HISTORY_PHP} printed.
 *
 * @param json - the snippet's output.
 * @throws {@link Error} if it is not JSON, or not a list of rows shaped like the table's.
 */
export function parseHistory(json: string): readonly HistoryRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(
      `[backwpup/history] the history did not come back as JSON: ${json.slice(0, 500) || "(empty)"}`,
    );
  }
  return historyRecords(parsed);
}

/**
 * Every row of the site's backup history, oldest first.
 *
 * @param transport - the site to ask. BackWPup must be installed, since it owns the table.
 * @throws {@link Error} if the table cannot be read, or reads back in a shape it does not have.
 */
export async function readHistory(
  transport: Transport,
): Promise<readonly HistoryRecord[]> {
  return parseHistory(
    await evalPhp(
      transport,
      HISTORY_PHP,
      "reading the backup history",
      "backwpup/history",
    ),
  );
}
