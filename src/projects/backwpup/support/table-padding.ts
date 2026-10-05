import { isPlaceholderSite } from "../../../common/config/sites";
import { evalPhp, phpLiteral } from "../../../common/wp/php";
import { errorMessage, isObject } from "../../../common/guards";
import type { SiteConfig, Transport } from "../../../common/config/types";

/**
 * Empty tables of the scenario's own, added to a site's database so a paced backup lasts as long on
 * every site.
 *
 * "Reduce server load" pauses a job each time it updates its progress, and a database dump does that
 * once per table — every table in the database, since a job excludes none by default. So a paced
 * backup's length is the site's table count: measured, 85 tables ran 10.2 s and 18 ran 3.5 s, while a
 * command sent once the job is seen running lands about 3 s in. Padded to 100, both ran 11.1–11.6 s.
 *
 * The tables are named `<prefix>e2e_pace_NNN` — the site's own prefix, so two sites sharing a
 * database never touch each other's — and only names of exactly that shape are ever dropped.
 *
 * **They can never pile up, and never outlive the next run.** The names are fixed and every padding
 * drops all earlier padding first, so a site holds one padding's worth at most. A scenario's own
 * teardown removes its padding; what a killed run left is removed when the next BackWPup run on the
 * site starts ({@link sweepPaddingLeftovers}).
 */

/** What follows the site's table prefix in every padding table's name, before its three digits. */
export const PADDING_TABLE_STEM = "e2e_pace_";

/** The most tables one padding may create: the names carry three digits. */
export const MAX_PADDING_TABLES = 999;

/** What one padding found and did. */
export interface TablePaddingOutcome {
  /** The tables the database held once any earlier padding was dropped. */
  readonly before: number;
  /** The empty tables created. */
  readonly created: number;
  /** The tables the database holds now. */
  readonly total: number;
}

/**
 * The PHP both snippets open with: the site's padding tables, a query that stops the snippet with the
 * database's own error instead of carrying on past a failed statement, and every earlier padding
 * dropped — `$earlier` holds what it found.
 */
const PADDING_PHP_PREAMBLE =
  String.raw`global $wpdb;
$stem = $wpdb->prefix . ${phpLiteral(PADDING_TABLE_STEM)};
$padding = static function () use ( $wpdb, $stem ) {
	$like = $wpdb->prepare( 'SHOW TABLES LIKE %s', $wpdb->esc_like( $stem ) . '%' );
	return array_values( preg_grep( '/^' . preg_quote( $stem, '/' ) . '\d{3}$/', (array) $wpdb->get_col( $like ) ) );
};
$run = static function ( $sql ) use ( $wpdb ) {
	if ( false === $wpdb->query( $sql ) ) {
		WP_CLI::error( $sql . ' failed: ' . $wpdb->last_error );
	}
};
$earlier = $padding();
foreach ( $earlier as $name ) {
	$run( "DROP TABLE IF EXISTS ` +
  "`{$name}`" +
  String.raw`" );
}
`;

/**
 * The PHP that drops any earlier padding, then creates empty tables until the database holds
 * `atLeast`, and reports {@link TablePaddingOutcome} as JSON.
 *
 * Dropped first so the count is the site's own, whatever an interrupted run left. Each table has a
 * primary key, which a server with `sql_require_primary_key` demands.
 *
 * @param atLeast - the tables the database must hold afterwards.
 */
export function padTablesPhp(atLeast: number): string {
  return (
    String.raw`${PADDING_PHP_PREAMBLE}$at_least = (int) ${phpLiteral(atLeast)};
$before = count( (array) $wpdb->get_col( 'SHOW FULL TABLES' ) );
$created = 0;
while ( $before + $created < $at_least ) {
	++$created;
	$run( 'CREATE TABLE ` +
    "`' . $stem . sprintf( '%03d', $created ) . '`" +
    String.raw` ( id INT NOT NULL PRIMARY KEY )' );
}
echo wp_json_encode( [ 'before' => $before, 'created' => $created, 'total' => count( (array) $wpdb->get_col( 'SHOW FULL TABLES' ) ), 'padding' => count( $padding() ) ] );
`
  );
}

/** The PHP that drops every padding table and reports, as JSON, how many it dropped and how many are left. */
export const REMOVE_PADDING_PHP = `${PADDING_PHP_PREAMBLE}echo wp_json_encode( [ 'dropped' => count( $earlier ), 'left' => count( $padding() ) ] );
`;

/**
 * Refuses a table count a padding cannot or need not reach, before anything touches the site.
 *
 * @throws {@link Error} unless `atLeast` is a whole number from 1 to {@link MAX_PADDING_TABLES}.
 */
export function checkPaddingTarget(atLeast: number): void {
  if (
    !Number.isInteger(atLeast) ||
    atLeast < 1 ||
    atLeast > MAX_PADDING_TABLES
  ) {
    throw new Error(
      `[backwpup/table-padding] a database can be padded to 1–${String(MAX_PADDING_TABLES)} ` +
        `tables, not ${String(atLeast)}.`,
    );
  }
}

/** A count in the reply: a whole number, not negative. */
function countIn(reply: Record<string, unknown>, key: string): number {
  const value = reply[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `[backwpup/table-padding] expected "${key}" to be a count, got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

/**
 * A snippet's JSON reply, as an object.
 *
 * @param reply - the snippet's output.
 * @param what - what the reply should be, for the message.
 * @throws {@link Error} if the reply is not a JSON object.
 */
function replyObject(reply: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    parsed = undefined;
  }
  if (!isObject(parsed)) {
    throw new Error(
      `[backwpup/table-padding] the site did not report ${what}: ${reply.slice(0, 500) || "(empty)"}`,
    );
  }
  return parsed;
}

/**
 * Reads what {@link padTablesPhp} printed, and holds it to what was asked.
 *
 * @param reply - the snippet's output.
 * @param atLeast - the tables the database was to hold.
 * @throws {@link Error} if the reply is not an outcome, if the database holds fewer tables than
 * asked, or if a table the padding created is not there.
 */
export function parsePaddingOutcome(
  reply: string,
  atLeast: number,
): TablePaddingOutcome {
  const parsed = replyObject(reply, "the padding's outcome");
  const outcome = {
    before: countIn(parsed, "before"),
    created: countIn(parsed, "created"),
    total: countIn(parsed, "total"),
  };
  const padding = countIn(parsed, "padding");
  if (outcome.total < atLeast || padding !== outcome.created) {
    throw new Error(
      `[backwpup/table-padding] the database should hold at least ${String(atLeast)} tables, ` +
        `${String(outcome.created)} of them padding; it holds ${String(outcome.total)}, ` +
        `${String(padding)} of them padding.`,
    );
  }
  return outcome;
}

/**
 * Pads the site's database with empty tables until it holds at least `atLeast`, dropping any earlier
 * padding first.
 *
 * @param transport - the site to pad.
 * @param atLeast - the tables the database must hold afterwards.
 * @returns what the padding found and did; nothing is created when the site already holds enough.
 * @throws {@link Error} if the target is out of range, a statement failed, or the database does not
 * hold what was asked afterwards.
 */
export async function padTables(
  transport: Transport,
  atLeast: number,
): Promise<TablePaddingOutcome> {
  checkPaddingTarget(atLeast);
  const reply = await evalPhp(
    transport,
    padTablesPhp(atLeast),
    `padding the database to ${String(atLeast)} tables`,
    "backwpup/table-padding",
  );
  return parsePaddingOutcome(reply, atLeast);
}

/**
 * Reads what {@link REMOVE_PADDING_PHP} printed.
 *
 * @param reply - the snippet's output.
 * @returns how many padding tables were dropped.
 * @throws {@link Error} if the reply is not a removal's, or a padding table is still there.
 */
export function parseRemovalOutcome(reply: string): number {
  const parsed = replyObject(reply, "the removal's outcome");
  const dropped = countIn(parsed, "dropped");
  const left = countIn(parsed, "left");
  if (left !== 0) {
    throw new Error(
      `[backwpup/table-padding] ${String(left)} padding table(s) are still in the database after removal.`,
    );
  }
  return dropped;
}

/**
 * Drops every padding table, and **verifies** none is left.
 *
 * @param transport - the site to clean.
 * @returns how many were dropped — none when the site held no padding.
 * @throws {@link Error} if a statement failed, or a padding table is still there afterwards.
 */
export async function removePaddingTables(
  transport: Transport,
): Promise<number> {
  const reply = await evalPhp(
    transport,
    REMOVE_PADDING_PHP,
    "removing the padding tables",
    "backwpup/table-padding",
  );
  return parseRemovalOutcome(reply);
}

/**
 * Drops whatever padding an earlier run left on a site — one killed before its teardown ran, or whose
 * removal failed. Run once per worker, **before** its first scenario, so a run that is itself killed
 * has still cleared what the one before it left.
 *
 * Never throws: it is housekeeping, and a site that cannot be reached fails the scenarios that need
 * it, with their own words. A placeholder site is skipped — it has no reachable transport.
 *
 * @param site - the worker's bound site, or `undefined` when the project has none.
 */
export async function sweepPaddingLeftovers(
  site: Pick<SiteConfig, "baseURL" | "transport"> | undefined,
): Promise<void> {
  if (site === undefined || isPlaceholderSite(site)) return;
  try {
    const dropped = await removePaddingTables(site.transport);
    if (dropped > 0) {
      console.info(
        `[backwpup/table-padding] removed ${String(dropped)} padding table(s) an earlier run left on ` +
          `${site.baseURL}.`,
      );
    }
  } catch (error) {
    console.warn(
      `[backwpup/table-padding] could not sweep the padding an earlier run may have left on ` +
        `${site.baseURL}: ${errorMessage(error)}`,
    );
  }
}

/**
 * One scenario's padding: made when a step asks for it, removed when the scenario ends.
 *
 * Removed after the `@plugin` teardown — a fixture is torn down after every `After` hook (verified) —
 * so no backup is dumping a table as it goes.
 */
export class TablePadding {
  /** The site being padded. */
  private readonly transport: Transport;

  /** Whether a padding was attempted, and so may have left tables to remove. */
  private used = false;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /**
   * Pads the database until it holds at least `atLeast` tables.
   *
   * Marks the padding used before anything is created, so a padding that failed half-way is still
   * removed.
   *
   * @throws what {@link padTables} throws.
   */
  async padTo(atLeast: number): Promise<TablePaddingOutcome> {
    checkPaddingTarget(atLeast);
    this.used = true;
    return padTables(this.transport, atLeast);
  }

  /**
   * Removes the padding if this scenario made one. Teardown, so it never throws: a failure is
   * reported, and the next run's {@link sweepPaddingLeftovers} drops the tables.
   */
  async release(): Promise<void> {
    if (!this.used) return;
    try {
      await removePaddingTables(this.transport);
    } catch (error) {
      console.warn(
        "[backwpup/table-padding] could not remove this scenario's padding tables — empty, named " +
          `<prefix>${PADDING_TABLE_STEM}NNN, and dropped by the next run on this site: ${errorMessage(error)}`,
      );
    }
  }
}
