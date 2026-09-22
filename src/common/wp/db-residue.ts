import { evalPhp, phpLiteral } from "./php";
import { SiteDbResidueRemovalFailedError } from "./errors";
import { isObject } from "../guards";
import type { Transport } from "../config/types";

/**
 * The data a plugin leaves in a site's **database** once its files are gone — and removing it so the
 * next install is genuinely fresh.
 *
 * The filesystem counterpart in `residue.ts` exists because a plugin's uninstall deliberately
 * keeps the files it wrote. This one exists for the opposite reason: a well-behaved plugin's
 * uninstall *does* clear its database footprint, but that cleanup lives in the plugin's own
 * `uninstall.php` — so it only ever runs while the plugin's **files are still there**.
 *
 * That is the whole gap. `ensurePluginAbsent` is gated on `wp plugin is-installed`, a *file* test, so
 * a site whose plugin directory has gone while its rows remain looks already-clean and is skipped.
 * Measured on a real cell: `wp plugin uninstall <slug> --deactivate` — the one call this suite
 * forbids, precisely because the plugin's own guard then skips its cleanup — deletes the files and
 * leaves **26 options and the plugin's table** behind. The next run installs on top of that, the
 * plugin reads its own leftover version, concludes it is an upgrade rather than a first install, and
 * the scenario fails somewhere that blames the product.
 *
 * So this sweep keys off the **footprint**, never off the plugin being installed. A product declares
 * what its footprint looks like and the shared scenario hooks clear it whenever they find it.
 *
 * **It only makes sense with the plugin absent, and the hooks guarantee that by ordering.** Measured
 * on a cell: sweeping while the plugin is active does work, and the very next WordPress request puts
 * all 26 options and the table straight back — the plugin re-creates its own footprint on `init`.
 * Both callers therefore run it immediately after `ensurePluginAbsent`, which throws rather than
 * return with the plugin still installed.
 */

/**
 * What a product leaves in a site's database, as the product declares it.
 *
 * Deliberately only two kinds. They are the two that **block a fresh install**: the options are what
 * a plugin reads to decide it has been installed before, and the table is what its installer tries
 * to create again. The rest of a footprint — roles, capabilities, user meta — is re-established
 * idempotently by activation and removed by the next real uninstall, so it neither blocks a run nor
 * accumulates across them, and reproducing the plugin's own role handling here would be a second
 * implementation to keep in step with it.
 */
export interface SiteDbResidue {
  /**
   * Fragments of option names, each matched **anywhere in the name** rather than as a prefix.
   *
   * Anywhere, because a plugin's transients are options whose names it does not begin: BackWPup's
   * `backwpup_<jobid>_gdrive` is stored as `_site_transient_backwpup_<jobid>_gdrive`, observed live
   * during an ordinary scenario. A prefix match would walk straight past those and the timeout rows
   * beside them.
   *
   * Matched literally: `%` and `_` are escaped before the query, so a fragment can only ever mean
   * itself. Each must be at least {@link MIN_FRAGMENT_LENGTH} characters and drawn from
   * `[A-Za-z0-9_-]`, and a fragment broad enough to hit an option WordPress itself owns is refused
   * outright — see {@link PROTECTED_OPTIONS}.
   */
  readonly optionsContaining?: readonly string[];
  /**
   * Tables the product creates, named **without** the site's prefix (`bwpup_backups`, not
   * `wp_bwpup_backups`). The prefix is read from the site, so a cell that does not use `wp_` is
   * swept just as correctly.
   */
  readonly tables?: readonly string[];
}

/** What a sweep found — or removed — on a site, with tables at their full prefixed names. */
export interface FoundDbResidue {
  /** Matching option names, in name order. */
  readonly options: readonly string[];
  /** Matching tables, prefixed as they exist on the site. */
  readonly tables: readonly string[];
}

/** True when a sweep found nothing at all, so callers can skip the work and the logging. */
export function isEmptyDbResidue(found: FoundDbResidue): boolean {
  return found.options.length === 0 && found.tables.length === 0;
}

/**
 * Shortest usable option fragment.
 *
 * A one- or two-character fragment matched anywhere in a name sweeps rows that have nothing to do
 * with the product — `id` alone matches most of a WordPress install. No plugin's identifying
 * fragment is that short, so anything shorter is a declaration mistake rather than a broad intent,
 * and is rejected where it can still be explained.
 */
const MIN_FRAGMENT_LENGTH = 3;

/**
 * Options that must survive any sweep, whatever a product declared.
 *
 * These are WordPress's own: losing them unreachably breaks the site (`siteurl`, `home`), silently
 * disables every plugin (`active_plugins`), or throws away state no reinstall restores (`cron`,
 * `db_version`). No sensible fragment reaches them — BackWPup's do not come close — so this list
 * never fires in normal use. It exists for the declaration that is *wrong*: a stray `%`, a fragment
 * shortened during a refactor, a product copying another's block. The same bet that
 * `PROTECTED_SITE_PATHS` makes for a privileged `rm -rf`, made here for a `DELETE`.
 *
 * Checked against what the query actually **matched**, not against the declaration, because a
 * fragment is not a name and only the site can say what it reaches.
 */
export const PROTECTED_OPTIONS: readonly string[] = [
  "active_plugins",
  "admin_email",
  "blogdescription",
  "blogname",
  "cron",
  "current_theme",
  "db_version",
  "fresh_site",
  "home",
  "initial_db_version",
  "permalink_structure",
  "rewrite_rules",
  "siteurl",
  "stylesheet",
  "template",
  "upload_path",
  "users_can_register",
];

/**
 * Options that must survive a sweep but carry the site's table prefix in their name
 * (`wp_user_roles`), so they can only be recognised once the prefix is known.
 *
 * `user_roles` is the one that matters here: it holds every role and capability on the site,
 * including the administrator's, so deleting it locks everyone out of `wp-admin`.
 */
const PROTECTED_PREFIXED_OPTIONS: readonly string[] = [
  "user_roles",
  "user_settings",
];

/**
 * Tables no product may declare as its own, named without a prefix.
 *
 * WordPress's core schema. A product that named one of these would drop the site's content, its
 * users or its settings the first time the sweep ran, so the declaration is refused rather than
 * obeyed. The multisite tables are listed too: this sweep refuses to run on multisite at all, but a
 * declaration naming one is wrong regardless of where it is loaded.
 */
export const PROTECTED_TABLES: readonly string[] = [
  "blogmeta",
  "blogs",
  "commentmeta",
  "comments",
  "links",
  "options",
  "postmeta",
  "posts",
  "registration_log",
  "signups",
  "site",
  "sitemeta",
  "term_relationships",
  "term_taxonomy",
  "termmeta",
  "terms",
  "usermeta",
  "users",
];

/**
 * Validates one declared option fragment and returns it trimmed.
 *
 * @param declared - the fragment as the product declared it.
 * @returns the fragment, trimmed.
 * @throws {@link Error} naming the fragment and the rule it broke.
 */
export function normaliseOptionFragment(declared: string): string {
  const fragment = declared.trim();
  const refuse = (reason: string): never => {
    throw new Error(
      `[wp/db-residue] "${declared}" cannot be used to match leftover options: ${reason}. ` +
        'Declare a fragment of the option names the product writes, e.g. "myplugin".',
    );
  };
  if (fragment.length < MIN_FRAGMENT_LENGTH) {
    return refuse(
      `it is shorter than ${String(MIN_FRAGMENT_LENGTH)} characters, so it would match ` +
        "options belonging to the site rather than to the product",
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(fragment)) {
    return refuse(
      "it contains something other than letters, digits, underscore and hyphen — a fragment is " +
        "matched literally, so a wildcard here means only itself and is never what was intended",
    );
  }
  return fragment;
}

/**
 * Validates one declared table name and returns it trimmed.
 *
 * @param declared - the table name as the product declared it, without the site's prefix.
 * @returns the name, trimmed.
 * @throws {@link Error} naming the table and the rule it broke.
 */
export function normaliseResidueTable(declared: string): string {
  const table = declared.trim();
  const refuse = (reason: string): never => {
    throw new Error(
      `[wp/db-residue] "${declared}" cannot be dropped as a leftover table: ${reason}. ` +
        'Declare the name without the site\'s prefix, e.g. "myplugin_items".',
    );
  };
  if (!/^[A-Za-z0-9_]+$/.test(table)) {
    return refuse(
      "a table name may hold only letters, digits and underscores — it is written into `DROP " +
        "TABLE` as an identifier, which no query can parameterise",
    );
  }
  if (PROTECTED_TABLES.includes(table.toLowerCase())) {
    return refuse("it is one of WordPress's own tables");
  }
  return table;
}

/** A declaration with every fragment and table validated, and the empty case already collapsed. */
interface CheckedDbResidue {
  readonly fragments: readonly string[];
  readonly tables: readonly string[];
}

/**
 * Validates a whole declaration up front, so a typo in one entry cannot leave a site half-swept.
 *
 * @param residue - the product's declaration.
 * @returns the validated fragments and tables.
 * @throws {@link Error} for the first entry that is not usable.
 */
function check(residue: SiteDbResidue): CheckedDbResidue {
  return {
    fragments: (residue.optionsContaining ?? []).map(normaliseOptionFragment),
    tables: (residue.tables ?? []).map(normaliseResidueTable),
  };
}

/**
 * Refuses a sweep that matched an option the site cannot lose.
 *
 * @param options - the option names the query matched.
 * @param prefix - the site's table prefix, which some protected names carry.
 * @throws {@link Error} naming every protected option matched, and nothing is removed.
 */
export function assertNoProtectedOptions(
  options: readonly string[],
  prefix: string,
): void {
  const protectedNames = new Set([
    ...PROTECTED_OPTIONS,
    ...PROTECTED_PREFIXED_OPTIONS.map((name) => `${prefix}${name}`),
  ]);
  const hits = options.filter((option) => protectedNames.has(option));
  if (hits.length === 0) return;
  throw new Error(
    `[wp/db-residue] refusing to remove leftover options: the declared fragments match ` +
      `${String(hits.length)} option(s) that belong to WordPress itself — ${hits.join(", ")}. ` +
      "Narrow the product's `optionsContaining` declaration; nothing has been removed.",
  );
}

/**
 * The PHP that finds the footprint, leaving it in `$options` and `$tables`.
 *
 * Shared by the scan and the removal so there is exactly one definition of what "matching" means —
 * a removal that matched differently from the scan that verified it would be worse than either.
 *
 * `esc_like` is what makes a fragment literal: it escapes `%` and `_`, so `bwpup_backups` cannot
 * also match `bwpupXbackups`. `prepare` then quotes the value. The prefix is validated rather than
 * escaped, because it is spliced into a table identifier, which no placeholder can carry.
 */
function matchPhp(checked: CheckedDbResidue): string {
  return `
global $wpdb;
if ( is_multisite() ) {
  WP_CLI::error( 'this site is multisite, where a plugin keeps its options in sitemeta per network; the leftover-footprint sweep only understands single-site installs' );
}
if ( ! preg_match( '/^[A-Za-z0-9_]+$/', $wpdb->prefix ) ) {
  WP_CLI::error( 'this site reports a table prefix that cannot be used as an identifier: ' . $wpdb->prefix );
}
$fragments = ${phpLiteral(checked.fragments)};
$declared  = ${phpLiteral(checked.tables)};
$options   = [];
if ( $fragments ) {
  $where = [];
  foreach ( $fragments as $fragment ) {
    $where[] = $wpdb->prepare( 'option_name LIKE %s', '%' . $wpdb->esc_like( $fragment ) . '%' );
  }
  $options = $wpdb->get_col( 'SELECT option_name FROM ' . $wpdb->options . ' WHERE ' . implode( ' OR ', $where ) . ' ORDER BY option_name' );
}
$tables = [];
foreach ( $declared as $name ) {
  $full = $wpdb->prefix . $name;
  if ( $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $wpdb->esc_like( $full ) ) ) ) {
    $tables[] = $full;
  }
}
`;
}

/** The PHP that reports what {@link matchPhp} found, as JSON. */
const REPORT_PHP = `
echo wp_json_encode( [ 'prefix' => $wpdb->prefix, 'options' => array_values( $options ), 'tables' => $tables ] );
`;

/** A scan's parsed reply: what was found, plus the prefix the protected-option check needs. */
interface ScanResult extends FoundDbResidue {
  readonly prefix: string;
}

/** Narrows an unknown JSON value to an array of strings. */
function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === "string") ? value : undefined;
}

/**
 * Parses a scan's reply.
 *
 * Validated rather than cast: the reply crosses a transport as text, and a site that printed a
 * notice before the JSON would otherwise be read as "nothing found" — the one answer that makes a
 * sweep silently do nothing.
 *
 * @param raw - the snippet's trimmed output.
 * @returns the scan result.
 * @throws {@link Error} if the reply is not the expected shape.
 */
function parseScan(raw: string): ScanResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(
      `[wp/db-residue] the site's reply was not JSON: ${raw || "(no output)"}`,
    );
  }
  const prefix = isObject(value) ? value.prefix : undefined;
  const options = isObject(value) ? stringArray(value.options) : undefined;
  const tables = isObject(value) ? stringArray(value.tables) : undefined;
  if (
    typeof prefix !== "string" ||
    options === undefined ||
    tables === undefined
  ) {
    throw new Error(
      `[wp/db-residue] the site's reply did not describe a footprint: ${raw || "(no output)"}`,
    );
  }
  return { prefix, options, tables };
}

/**
 * Runs one footprint snippet against a site and parses its reply.
 *
 * Plugins are **not** loaded (`--skip-plugins`). Two reasons, both measured: the product's own
 * plugin re-creates every row of its footprint on `init`, so a sweep that loaded it could undo
 * itself within the one request; and the cells this suite runs carry unrelated plugins that hook
 * option and transient writes, which a cleanup step must not depend on. WordPress core — and so
 * `delete_option`, with the cache invalidation that makes a raw `DELETE` unsafe — is unaffected.
 */
async function runFootprintPhp(
  transport: Transport,
  php: string,
  what: string,
): Promise<ScanResult> {
  const raw = await evalPhp(transport, php, what, "wp/db-residue", {
    skipPlugins: true,
  });
  return parseScan(raw);
}

/**
 * Reports the declared footprint a site is currently carrying, without changing anything.
 *
 * @param transport - the site to ask.
 * @param residue - the product's declaration. Declaring nothing costs no round-trip at all.
 * @returns what is present, with tables at their full prefixed names.
 * @throws {@link Error} if a declared fragment or table is unusable, if the site is multisite, or
 * if WordPress could not answer.
 */
export async function findSiteDbResidue(
  transport: Transport,
  residue: SiteDbResidue,
): Promise<FoundDbResidue> {
  const checked = check(residue);
  if (checked.fragments.length === 0 && checked.tables.length === 0) {
    return { options: [], tables: [] };
  }
  const { options, tables } = await runFootprintPhp(
    transport,
    matchPhp(checked) + REPORT_PHP,
    "looking for a leftover plugin footprint",
  );
  return { options, tables };
}

/**
 * Removes the declared footprint from a site, and confirms it is gone.
 *
 * Rows go through `delete_option` rather than a `DELETE`, so WordPress invalidates its own caches as
 * it would for any other deletion — which is why no cache flush follows. Tables are dropped with
 * `IF EXISTS`, so a table that vanished between the scan and the drop is not an error.
 *
 * Removal is **verified by re-reading**, in a second process, straight from the database rather than
 * from any cache — the same discipline the rest of this layer applies to WP-CLI's exit codes. A
 * `DROP` reports success for a table it never had to touch, and `delete_option` returns false both
 * for "there was nothing there" and for "a filter refused it".
 *
 * @param transport - the site to clean.
 * @param residue - the product's declaration. Declaring nothing does nothing at all.
 * @returns what was removed, so a caller can say what it found rather than that it ran.
 * @throws {@link Error} if a declared fragment or table is unusable, if a matched option belongs to
 * WordPress itself (nothing is removed), if the site is multisite, or if WordPress could not answer;
 * or {@link SiteDbResidueRemovalFailedError} naming whatever survived the removal.
 */
export async function removeSiteDbResidue(
  transport: Transport,
  residue: SiteDbResidue,
): Promise<FoundDbResidue> {
  const checked = check(residue);
  if (checked.fragments.length === 0 && checked.tables.length === 0) {
    return { options: [], tables: [] };
  }

  // Scanned before anything is removed, so the protected-option guard can refuse the whole sweep
  // rather than stop it half-way — and so a clean site pays one read and no write.
  const scan = await runFootprintPhp(
    transport,
    matchPhp(checked) + REPORT_PHP,
    "looking for a leftover plugin footprint",
  );
  if (isEmptyDbResidue(scan)) return { options: [], tables: [] };
  assertNoProtectedOptions(scan.options, scan.prefix);

  await runFootprintPhp(
    transport,
    `${matchPhp(checked)}
foreach ( $options as $name ) {
  delete_option( $name );
}
foreach ( $tables as $table ) {
  $wpdb->query( 'DROP TABLE IF EXISTS \`' . $table . '\`' );
}
${REPORT_PHP}`,
    "removing a leftover plugin footprint",
  );

  const after = await runFootprintPhp(
    transport,
    matchPhp(checked) + REPORT_PHP,
    "confirming the leftover plugin footprint is gone",
  );
  if (!isEmptyDbResidue(after)) {
    throw new SiteDbResidueRemovalFailedError(after.options, after.tables);
  }
  return { options: scan.options, tables: scan.tables };
}
