import type { SiteDbResidue } from "../../../common/wp/db-residue";

/**
 * What BackWPup leaves in a site's **database** when its files go without its uninstall running.
 *
 * Its `uninstall.php` is thorough — verified live: after a proper deactivate-then-uninstall the site
 * is byte-for-byte back to its pre-install state, options, table, roles, capabilities and user meta
 * alike. But that file is part of the plugin, so it only runs while the plugin is still there. Two
 * ways it does not: `wp plugin uninstall --deactivate` deletes the files while the plugin's own
 * guard skips the cleanup (measured: **26 options and the table** left behind), and a run killed
 * between the uninstall and the teardown leaves the same shape. Either way the next install reads
 * `backwpup_version`, concludes it is an upgrade rather than a first install, never sets the
 * onboarding flag, and the scenario fails blaming the product.
 *
 * The fragments below were taken from a site, not from the source: a full install plus onboarding
 * plus a UI scenario, sampled throughout, with every matching row collected.
 */

/**
 * Two fragments, because the plugin uses two names for itself.
 *
 * Almost everything is `backwpup*` — 25 rows spanning `backwpup_cfg_*`, the job list, the version
 * markers and the onboarding flag. The table's own schema-version row is `bwpup_backups_version`,
 * which shares no substring with the first fragment, so it needs its own. Notably the plugin's
 * **own** uninstall (`LIKE '%backwpup_%'`) does not match that row either — it is dropped by the
 * table's BerlinDB `uninstall()` instead, which is exactly the path that cannot run here.
 *
 * Matched anywhere in the name rather than as a prefix, which is load-bearing: the plugin's
 * destination caches are site transients, stored under `_site_transient_backwpup_<jobid>_gdrive`
 * and a `_site_transient_timeout_…` row beside it. Both were observed on a cell during an ordinary
 * scenario with no cloud credentials configured, so they are not an edge case of cloud storage.
 */
export const BACKWPUP_OPTION_FRAGMENTS = ["backwpup", "bwpup"];

/**
 * The plugin's backup history table, named without the site's prefix
 * (`src/Backup/Database/Tables/Backup.php`) — one row per archive a run delivered, per destination.
 */
export const BACKUP_HISTORY_TABLE = "bwpup_backups";

/**
 * The plugin's tables, named without the site's prefix — it creates exactly one,
 * {@link BACKUP_HISTORY_TABLE}.
 *
 * That table is also the row that blocks hardest: an install landing on top of it fails with
 * `Table 'wp_bwpup_backups' already exists`, which WordPress reports as a database error the
 * scenario then trips over somewhere unrelated. The `CREATE TABLE` statements elsewhere in the
 * source belong to the mysqldump job type and describe the *site's* tables, not the plugin's.
 */
export const BACKWPUP_TABLES = [BACKUP_HISTORY_TABLE];

/**
 * The footprint the shared `@plugin` hooks sweep whenever they find it.
 *
 * Deliberately not the whole footprint. The plugin also leaves three roles, eleven administrator
 * capabilities and — once its admin notices have been seen — some user meta, none of which is
 * declared here: none of them blocks an install, activation re-establishes them idempotently, and
 * the next scenario's own uninstall removes them. Declaring them would mean reproducing the
 * plugin's role handling, a second implementation to keep in step with it, for rows that cannot
 * accumulate.
 */
export const BACKWPUP_SITE_DB_RESIDUE: SiteDbResidue = {
  optionsContaining: BACKWPUP_OPTION_FRAGMENTS,
  tables: BACKWPUP_TABLES,
};
