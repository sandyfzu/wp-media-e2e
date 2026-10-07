import { expect } from "@playwright/test";

import { Given, Then, When } from "../fixtures";
import { allowForRestore, listBackups } from "../support/backups";
import { commandArgv } from "../support/placeholders";
import { handRestoreWorkingDirToSite } from "../support/restore-dir";
import {
  readDatabaseMarker,
  readFileMarker,
  seedMarkers,
} from "../support/markers";
import { restoreReach } from "../support/cli-restore";
import { snapshotHolds } from "../support/restore-snapshots";
import {
  FreeRestorePage,
  ProRestorePage,
  RESTORE_STRATEGIES,
} from "../pages/restore.page";
import {
  getDebugLogOptions,
  readRouting,
} from "../../../common/config/metadata";
import {
  checkDebugLog,
  scenarioReport,
} from "../../../common/hooks/plugin-lifecycle";
import type { RestorePage, RestoreStrategy } from "../pages/restore.page";
import type { TestInfo } from "@playwright/test";
import type { Transport } from "../../../common/config/types";

/**
 * Steps for restoring a backup: from the history in the browser, by Pro's deep link or Free's
 * upload, and with `wp backwpup restore`.
 *
 * **The markers are the verdict.** A restore's own report is not enough — the command-line restore
 * says `Success:` after a rollback too, and the wizard moves to its last step whether the files part
 * failed or not — so every scenario plants two values before its backup, changes both after it, and
 * asks which of the two each one holds once the restore is over. A side the restore was meant to
 * cover must hold the backed-up value again; a side it was meant to leave alone must still hold the
 * changed one, which is what catches a restore that does everything, or the wrong half.
 *
 * **What a restore writes over is checked first.** A files restore puts back the `debug.log` its
 * archive holds, so whatever PHP logged since the backup would never reach the `@plugin` teardown's
 * reading — the log so far is judged, by the same rule, before the command runs, and in the browser
 * just before "Start", so the wizard's own requests up to there are judged too. What the restore's
 * own files request logs before it writes the log back is the one stretch no reading can reach.
 */

/** A strategy as a feature names it, narrowed to the ones the wizard knows. */
function strategy(label: string): RestoreStrategy {
  const known = RESTORE_STRATEGIES.find((name) => name === label);
  if (known === undefined) {
    throw new Error(
      `[backwpup/restore] unknown restore strategy "${label}". Use ${RESTORE_STRATEGIES.map((s) => `"${s}"`).join(", ")}.`,
    );
  }
  return known;
}

/**
 * Judges the `debug.log` written so far — what a restore is about to overwrite — by the `@plugin`
 * teardown's own rule, with the product's preset.
 */
async function judgeLogSoFar(
  transport: Transport,
  testInfo: TestInfo,
): Promise<void> {
  const { product } = readRouting(testInfo.project.metadata);
  await checkDebugLog(
    transport,
    getDebugLogOptions(product),
    scenarioReport(testInfo),
  );
}

/** The newest archive's file name, as the site lists it. */
async function newestArchive(transport: Transport): Promise<string> {
  const [newest] = await listBackups(transport);
  if (newest === undefined) {
    throw new Error(
      "[backwpup/restore] there is no backup on the site to restore.",
    );
  }
  return newest.name;
}

/**
 * Drives the wizard from the strategy choice to its end, once the archive is on its way.
 *
 * The strategies are read as the screen offers them before one is chosen, so a step after this one
 * can say what was offered; choosing one it did not offer fails here, naming what was. The log is
 * judged again just before "Start" — see the module header.
 */
async function finishRestore(
  restore: RestorePage,
  chosen: string,
  judgeLog: () => Promise<void>,
): Promise<void> {
  await restore.strategiesOffered();
  await restore.restoreWith(strategy(chosen), judgeLog);
}

// ── Arrangement ──────────────────────────────────────────────────────────────

/**
 * Changes both markers after the backup — the difference a restore is to undo. Fresh values are
 * planted over the old ones (`seedMarkers`, which verifies them), and remembered, since a side a
 * restore leaves alone must still hold them afterwards.
 */
Given(
  "the site's marker data has changed since that backup",
  async ({ site, markers, changedMarkers }) => {
    const changed = await seedMarkers(site.transport);
    expect(
      [changed.file, changed.database],
      "the changed markers must differ from the backed-up ones, or a restore could not be told from no restore",
    ).not.toContain(markers.file);
    expect([changed.file, changed.database]).not.toContain(markers.database);
    changedMarkers.record(changed);
  },
);

// ── Restoring in the browser ─────────────────────────────────────────────────

/**
 * Pro's journey: the history row's Restore action, the deep link it opens — asserted to name that
 * very archive and never to ask for a file — then the wizard to its end.
 *
 * The restore's working directory is handed to the web server first: WP-CLI may have written there
 * while the scenario arranged its backup, and the wizard's every request saves its state there.
 */
When(
  "I restore the newest backup from the backup history, choosing {string}",
  async ({ site, restore, backupHistory, $testInfo }, chosen: string) => {
    if (!(restore instanceof ProRestorePage)) {
      throw new Error(
        "[backwpup/restore] restoring from the archive on the server is Pro's journey; tag the scenario @pro.",
      );
    }
    allowForRestore($testInfo);
    const archive = await newestArchive(site.transport);
    await handRestoreWorkingDirToSite(site.transport);
    const judgeLog = () => judgeLogSoFar(site.transport, $testInfo);
    await judgeLog();
    await backupHistory.waitForLoaded();
    await restore.startFrom(backupHistory.newestRow);
    await restore.expectEntryPath(archive);
    await finishRestore(restore, chosen, judgeLog);
  },
);

/**
 * Free's journey: the history row's Restore action lands on the bare page — asserted to name no
 * archive and to ask for one — so the copy the scenario downloaded is uploaded, then the wizard is
 * driven to its end. The download step saved it under the name the site gives it, which is how it is
 * found again here.
 */
When(
  "I restore the newest backup from the backup history by uploading it, choosing {string}",
  async ({ site, restore, backupHistory, $testInfo }, chosen: string) => {
    if (!(restore instanceof FreeRestorePage)) {
      throw new Error(
        "[backwpup/restore] restoring by upload is Free's journey; tag the scenario @free.",
      );
    }
    allowForRestore($testInfo);
    const archive = await newestArchive(site.transport);
    await handRestoreWorkingDirToSite(site.transport);
    const judgeLog = () => judgeLogSoFar(site.transport, $testInfo);
    await judgeLog();
    await backupHistory.waitForLoaded();
    await restore.startFrom(backupHistory.newestRow);
    await restore.expectEntryPath();
    await restore.uploadArchive($testInfo.outputPath(archive));
    await finishRestore(restore, chosen, judgeLog);
  },
);

/** What the strategy step offered, in screen order — all three for a backup of files and database. */
Then(
  "the restore screen offered {string}, {string} and {string}",
  ({ restore }, first: string, second: string, third: string) => {
    expect(
      restore.offered,
      "the strategies the restore screen offered",
    ).toEqual([first, second, third].map(strategy));
  },
);

/** What the strategy step offered for a backup holding one half of the site: that half alone. */
Then(
  "the restore screen offered only {string}",
  ({ restore }, only: string) => {
    expect(
      restore.offered,
      "the strategies the restore screen offered",
    ).toEqual([strategy(only)]);
  },
);

// ── Restoring over WP-CLI ────────────────────────────────────────────────────

/**
 * Runs `wp backwpup restore …` the way {@link CliRestore} makes safe for a shared site, and remembers
 * the result for the generic command steps. Placeholders are filled as for any BackWPup command.
 */
When(
  "I run the BackWPup restore command {string}",
  async (
    { cliRestore, site, privateFolder, archives, keys, $testInfo },
    command: string,
  ) => {
    allowForRestore($testInfo);
    const argv = await commandArgv(command, {
      transport: site.transport,
      privateFolder,
      archives,
      keys,
    });
    if (restoreReach(argv).files)
      await judgeLogSoFar(site.transport, $testInfo);
    await cliRestore.run(argv);
  },
);

/**
 * That the command's `--pre-backup` snapshot holds the site as it was just before the restore — the
 * changed markers, file and database — which is what it promises to roll back to.
 */
Then(
  "the restore's safety snapshot holds the site as it was before the restore",
  async ({ site, cliRestore, changedMarkers }) => {
    const snapshots = await cliRestore.snapshots();
    expect(
      snapshots.length,
      "the restore should have left exactly one snapshot holding this site's changed markers",
    ).toBe(1);
    const [snapshot] = snapshots;
    if (snapshot === undefined) throw new Error("unreachable: asserted above");
    expect(
      await snapshotHolds(site.transport, snapshot, changedMarkers.values),
      "the snapshot should hold both markers as they were just before the restore — the file one in " +
        "its copy of wp-content, the database one in its export",
    ).toEqual({ file: true, database: true });
  },
);

// ── What the restore left ────────────────────────────────────────────────────

/** The files half was restored: the file marker holds the value the backup captured. */
Then(
  "the site's files are back as they were in the backup",
  async ({ site, markers }) => {
    expect(
      await readFileMarker(site.transport),
      "the file marker should hold the value it had when the backup was made",
    ).toBe(markers.file);
  },
);

/** The files half was left alone: the file marker still holds the value written after the backup. */
Then(
  "the site's files still hold the changes made after the backup",
  async ({ site, changedMarkers }) => {
    expect(
      await readFileMarker(site.transport),
      "the file marker should still hold the value written after the backup — this restore was not to touch files",
    ).toBe(changedMarkers.values.file);
  },
);

/** The database half was restored: the option holds the value the backup captured. */
Then(
  "the site's database is back as it was in the backup",
  async ({ site, markers }) => {
    expect(
      await readDatabaseMarker(site.transport),
      "the database marker should hold the value it had when the backup was made",
    ).toBe(markers.database);
  },
);

/** The database half was left alone: the option still holds the value written after the backup. */
Then(
  "the site's database still holds the changes made after the backup",
  async ({ site, changedMarkers }) => {
    expect(
      await readDatabaseMarker(site.transport),
      "the database marker should still hold the value written after the backup — this restore was not to touch the database",
    ).toBe(changedMarkers.values.database);
  },
);
