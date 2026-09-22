import { evalPhp, phpLiteral } from "../../../common/wp/php";
import { isObject } from "../../../common/guards";
import { BACKWPUP_OPTION_FRAGMENTS, BACKWPUP_TABLES } from "./db-residue";
import type { Transport } from "../../../common/config/types";

/**
 * Everything BackWPup leaves on a site, read back after it has been removed.
 *
 * The question a deletion scenario asks — *is any of it still here?* — has two halves that live in
 * different places, so both are read here: what the plugin put in the **database**, which its
 * uninstall promises to clear, and the **archives** it wrote to disk, which it deliberately keeps.
 * The scenarios assert opposite things about them, and that opposition is the point: a deletion that
 * took the backups with it would be data loss, and one that left its settings behind would leave the
 * next install landing on the last run's state.
 *
 * Read **without plugins loaded** (`--skip-plugins`), so the answer is what the site has persisted
 * rather than what a running plugin would put back while being asked.
 *
 * Deliberately **broader than the `BACKWPUP_SITE_DB_RESIDUE` declaration beside it**. The sweep
 * clears only what blocks a fresh install; this reports the roles, capabilities and user meta as
 * well, because a scenario asserting that deletion cleaned up is making a claim about the
 * *product*, and the product's own `uninstall.php` promises all five. It shares the naming
 * fragments with the declaration because those are the plugin's names, not a policy either file
 * gets to choose.
 */

/** What BackWPup has left in a site's database. Every list is empty on a site it never touched. */
export interface BackwpupFootprint {
  /** Option rows whose names carry the plugin's name, transients and their timeouts included. */
  readonly options: readonly string[];
  /** The plugin's own tables, at their full prefixed names. */
  readonly tables: readonly string[];
  /** Roles the plugin registered (`backwpup_admin`, `backwpup_helper`, `backwpup_check`). */
  readonly roles: readonly string[];
  /** Capabilities the plugin granted the administrator role. */
  readonly adminCapabilities: readonly string[];
  /** Distinct user-meta keys the plugin wrote, which its admin notices create once seen. */
  readonly userMeta: readonly string[];
}

/**
 * The kinds a footprint reports, in the order an assertion message lists them.
 *
 * Spelled out rather than derived from the object at runtime, so adding a kind to
 * {@link BackwpupFootprint} without listing it here is a type error instead of a check that
 * silently stops covering it.
 */
const FOOTPRINT_KINDS = [
  "options",
  "tables",
  "roles",
  "adminCapabilities",
  "userMeta",
] as const satisfies readonly (keyof BackwpupFootprint)[];

/** True when the site holds nothing of the plugin at all. */
export function isFootprintEmpty(footprint: BackwpupFootprint): boolean {
  return FOOTPRINT_KINDS.every((kind) => footprint[kind].length === 0);
}

/**
 * The footprint as one line per non-empty kind, for an assertion message.
 *
 * Naming what survived is the whole diagnostic value: roles left behind mean the uninstall ran and
 * its role handling is wrong, options left behind mean it did not run at all.
 */
export function describeFootprint(footprint: BackwpupFootprint): string {
  const lines = FOOTPRINT_KINDS.filter(
    (kind) => footprint[kind].length > 0,
  ).map((kind) => `  ${kind}: ${footprint[kind].join(", ")}`);
  return lines.length === 0 ? "  (nothing)" : lines.join("\n");
}

/** Narrows one field of the PHP reply to a list of strings. */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === "string") ? value : undefined;
}

/**
 * Reads one list field of the reply, naming the field when the site did not report it.
 *
 * A missing field must not read as an empty list: "nothing of the plugin is left" is exactly the
 * answer these scenarios look for, so a malformed reply would make them pass for free.
 */
function listField(
  fields: Record<string, unknown>,
  kind: string,
  raw: string,
): string[] {
  const list = stringList(fields[kind]);
  if (list === undefined) {
    throw new Error(
      `[backwpup/footprint] the site's reply did not report ${kind}: ${raw || "(no output)"}`,
    );
  }
  return list;
}

/** Parses the reply, validating every field rather than casting. */
function parseFootprint(raw: string): BackwpupFootprint {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(
      `[backwpup/footprint] the site's reply was not JSON: ${raw || "(no output)"}`,
    );
  }
  const fields = isObject(value) ? value : {};
  return {
    options: listField(fields, "options", raw),
    tables: listField(fields, "tables", raw),
    roles: listField(fields, "roles", raw),
    adminCapabilities: listField(fields, "adminCapabilities", raw),
    userMeta: listField(fields, "userMeta", raw),
  };
}

/**
 * Reads what BackWPup still has in a site's database.
 *
 * @param transport - the site to ask.
 * @returns every trace found, each list empty when there is none.
 * @throws {@link Error} if WordPress could not answer, or answered with something else.
 */
export async function readBackwpupFootprint(
  transport: Transport,
): Promise<BackwpupFootprint> {
  const raw = await evalPhp(
    transport,
    `
global $wpdb;
$fragments = ${phpLiteral(BACKWPUP_OPTION_FRAGMENTS)};
$declared  = ${phpLiteral(BACKWPUP_TABLES)};

// An empty fragment list would build "WHERE" with no condition: the query fails, get_col hands
// back an empty array, and the site reads as holding nothing of the plugin — which is the one
// answer these scenarios are looking for. Refused rather than answered.
if ( ! $fragments ) {
  WP_CLI::error( 'no option-name fragments were supplied, so nothing could be matched' );
}
$where = [];
foreach ( $fragments as $fragment ) {
  $where[] = $wpdb->prepare( 'option_name LIKE %s', '%' . $wpdb->esc_like( $fragment ) . '%' );
}
$options = $wpdb->get_col( 'SELECT option_name FROM ' . $wpdb->options . ' WHERE ' . implode( ' OR ', $where ) . ' ORDER BY option_name' );

$tables = [];
foreach ( $declared as $name ) {
  $full = $wpdb->prefix . $name;
  if ( $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $wpdb->esc_like( $full ) ) ) ) {
    $tables[] = $full;
  }
}

// Roles and capabilities are rows inside one serialised option, so they are read through the
// role API rather than matched in SQL — the option's name carries no plugin name at all.
$named = function ( $candidate ) use ( $fragments ) {
  foreach ( $fragments as $fragment ) {
    if ( stripos( $candidate, $fragment ) !== false ) { return true; }
  }
  return false;
};
$roles = array_values( array_filter( array_keys( wp_roles()->roles ), $named ) );
$admin = get_role( 'administrator' );
$caps  = $admin ? array_values( array_filter( array_keys( $admin->capabilities ), $named ) ) : [];

$meta = [];
foreach ( $fragments as $fragment ) {
  $meta = array_merge( $meta, $wpdb->get_col( $wpdb->prepare(
    'SELECT DISTINCT meta_key FROM ' . $wpdb->usermeta . ' WHERE meta_key LIKE %s',
    '%' . $wpdb->esc_like( $fragment ) . '%'
  ) ) );
}
sort( $roles );
sort( $caps );
$meta = array_values( array_unique( $meta ) );
sort( $meta );

echo wp_json_encode( [
  'options'           => array_values( $options ),
  'tables'            => $tables,
  'roles'             => $roles,
  'adminCapabilities' => $caps,
  'userMeta'          => $meta,
] );
`,
    "reading what BackWPup left in the database",
    "backwpup/footprint",
    { skipPlugins: true },
  );
  return parseFootprint(raw);
}

/**
 * The archive files BackWPup has written to this site, as absolute paths.
 *
 * Read off the **filesystem**, not through `wp backwpup backup`: the scenarios that ask this have
 * just deleted the plugin, so its WP-CLI commands are gone — and an archive that outlives the plugin
 * is precisely the thing being checked. The location comes from `wp_upload_dir()` rather than an
 * assumed `wp-content/uploads`, so a site with a relocated uploads directory answers correctly; the
 * `backwpup/` segment below it is the same tree `residue.ts` declares as leftover data.
 *
 * One plain `glob` then an extension filter, rather than a braced pattern: `GLOB_BRACE` is not
 * defined on every PHP build, and an undefined constant is a fatal in PHP 8. Filtering matters
 * either way — the same directories hold the `.bwuidx` index beside each archive, an `index.php`
 * guard and a `.donotbackup` marker, none of which is a backup.
 *
 * @param transport - the site to ask.
 * @returns the archive paths, sorted; empty when the site has made none.
 * @throws {@link Error} if WordPress could not answer, or answered with something else.
 */
export async function listBackwpupArchives(
  transport: Transport,
): Promise<string[]> {
  const raw = await evalPhp(
    transport,
    `
$base = wp_upload_dir( null, false, true )['basedir'] . '/backwpup';
$found = glob( $base . '/*/backups/*' );
$found = is_array( $found ) ? $found : [];
$archives = [];
foreach ( $found as $path ) {
  if ( preg_match( '/\\.(tar|tar\\.gz|zip)$/i', $path ) ) {
    $archives[] = $path;
  }
}
sort( $archives );
echo wp_json_encode( $archives );
`,
    "listing the archives BackWPup wrote to the site",
    "backwpup/footprint",
    { skipPlugins: true },
  );
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(
      `[backwpup/footprint] the site's archive listing was not JSON: ${raw || "(no output)"}`,
    );
  }
  const paths = stringList(value);
  if (paths === undefined) {
    throw new Error(
      `[backwpup/footprint] the site did not list its archives: ${raw || "(no output)"}`,
    );
  }
  return paths;
}
