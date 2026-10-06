import type {
  SiteResidue,
  SiteResidueFamily,
} from "../../../common/config/types";

/**
 * What BackWPup leaves on a site's filesystem after it has been uninstalled.
 *
 * **Its uninstall removes no files at all.** `uninstall.php` drops the plugin's options, its
 * database table and its roles, and stops there — everything the plugin *wrote while running* stays
 * where it is. That is right for a real user, whose backups are the whole point, and wrong for a
 * suite that installs the plugin afresh for every scenario: each install generates a new random
 * `backwpup_cfg_hash` (`inc/BackWPup.php:87-93`) and writes under a directory named after it, so
 * the site collects one complete archive of itself per scenario. Measured on the QA cell before
 * this existed: **6.8 GB across 28 such directories**, from a few days of runs.
 *
 * The paths below are the two roots that covers, both under `wp-content/uploads`. Removing the
 * *parents* rather than a single hash directory is deliberate — it also reclaims whatever earlier
 * runs (and crashed ones) left behind.
 */

/**
 * Everything a running job produces: `<hash>/backups`, `<hash>/logs` and `<hash>/temp`.
 *
 * The archive directory is a job setting (`backupdir`) and a scenario could point it elsewhere;
 * this is the default the Website Server destination computes
 * (`inc/class-destination-folder.php:263-270`), which is where every credential-free scenario
 * writes.
 */
const BACKUPS_ROOT = "wp-content/uploads/backwpup";

/**
 * The restore working area as older builds name it (`src/Infrastructure/Restore/commons.php`).
 *
 * Worth clearing for more than disk: it holds the uploaded archive and an extraction tree, and the
 * plugin ships an admin notice specifically because a stale `restore.dat.bkp` in here contains
 * **plaintext database credentials** (`src/Admin/Notices/StaleRestoreFilesDetector.php`).
 */
const RESTORE_ROOT = "wp-content/uploads/backwpup-restore";

/**
 * The restore working area as recent builds name it: `backwpup-restore-` and 20 lowercase hex digits
 * (`bin2hex( random_bytes( 10 ) )`, `restore_dir_token()`), drawn per install — so each scenario's has
 * a new name and only the family finds them all, a killed run's included. The pattern is the plugin's
 * own (`RESTORE_DIR_TOKEN_PATTERN`), anchored; it can never match {@link RESTORE_ROOT}. Holds what
 * that holds. `support/restore-dir.ts` resolves the current one for preparation.
 */
const RESTORE_DIRS: SiteResidueFamily = {
  parent: "wp-content/uploads",
  name: /^backwpup-restore-[0-9a-f]{20}$/,
};

/**
 * The paths the shared `@plugin` teardown clears after every BackWPup scenario.
 *
 * Not exhaustive by design: a site that defines `WP_TEMP_DIR` moves the temp tree to
 * `get_temp_dir()/backwpup/<hash>` (`inc/BackWPup.php:95-100`), and the CLI restore works in
 * `get_temp_dir()/backwpup-restore-<uniqid>`, which it removes itself. Neither applies to the cells
 * this suite runs, and both are outside the WordPress root, which residue paths deliberately cannot
 * reach — a site that needs them cleaned should say so through its own configuration rather than by
 * widening this list. The one temp-dir leftover a scenario does cause, `restore --pre-backup`'s
 * snapshot, is removed by the scenario that made it.
 */
export const BACKWPUP_SITE_RESIDUE: readonly SiteResidue[] = [
  BACKUPS_ROOT,
  RESTORE_ROOT,
  RESTORE_DIRS,
];
