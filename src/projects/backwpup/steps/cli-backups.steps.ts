import { createHash } from "node:crypto";

import { expect } from "@playwright/test";

import { Given, Then } from "../fixtures";
import {
  allowForBackup,
  runJobInForeground,
  runScheduledBackup,
} from "../support/backups";
import { PLACED_FILE_CONTENT } from "../support/download-folder";
import { archivedRuns, readHistory, runOrder } from "../support/history";
import { theScheduledJob } from "../support/job-options";
import { waitForRunToEnd } from "../support/job-runs";
import { readBackupFolder } from "../support/plugin-folders";
import type { ArchiveSnapshot } from "../support/archive-snapshot";
import type { DownloadFolder } from "../support/download-folder";
import type { SiteDirectory, SiteFile } from "../../../common/wp/files";
import type { Transport } from "../../../common/config/types";

/**
 * Steps for what `wp backwpup backup-delete` and `backup-download` do to the archives on a site.
 *
 * **Who made an archive decides what WP-CLI may do to it.** A run inside WP-CLI writes its archive
 * as the transport's user; a run handed to the web server writes it as the web server's, under that
 * server's own file mode. So the steps that make a scenario's backups say which of the two made them,
 * and record each archive as it was made — its digest, taken on the site — so a later step can say
 * whether a command left it untouched.
 *
 * **Every outcome is read off the site's filesystem**, never from the command's own line and never
 * from the plugin's listing commands, which walk the same folders through the same code as the
 * commands under test.
 */

// ── Making the backups ───────────────────────────────────────────────────────

/** How many runs of `jobId` the history records as having left an archive. */
async function archivedRunCount(
  transport: Transport,
  jobId: number,
): Promise<number> {
  return archivedRuns(await readHistory(transport)).filter(
    (run) => run.jobId === jobId,
  ).length;
}

/**
 * Checks the backups a step made are all recorded, then records them for the scenario — so what a
 * later step calls "the newest backup" is fixed from here on.
 */
async function recordBackups(
  transport: Transport,
  archives: ArchiveSnapshot,
  jobId: number,
  expected: number,
): Promise<void> {
  expect(
    await archivedRunCount(transport, jobId),
    "runs of the scheduled job the backup history records as having left an archive",
  ).toBe(expected);
  await archives.record(transport);
}

/**
 * Backups made by running the scheduled job **inside WP-CLI** — so each archive, and each log,
 * belongs to the transport's user.
 */
Given(
  "the scheduled job has made {int} backup(s) inside WP-CLI",
  async ({ site, archives, $testInfo }, count: number) => {
    allowForBackup($testInfo, count);
    const job = await theScheduledJob(site.transport);
    const before = await archivedRunCount(site.transport, job.jobId);
    for (let made = 0; made < count; made++) {
      await runJobInForeground(site.transport, job.jobId);
    }
    await recordBackups(site.transport, archives, job.jobId, before + count);
  },
);

/**
 * Backups made by handing the scheduled job to the **web server**, as every scheduled or on-demand
 * run is — so each archive belongs to the web server's user. Each run is followed to its recorded
 * end before the next one starts.
 */
Given(
  "the scheduled job has made {int} backup(s) through the web server",
  async ({ site, archives, $testInfo }, count: number) => {
    allowForBackup($testInfo, count);
    const job = await theScheduledJob(site.transport);
    const before = await archivedRunCount(site.transport, job.jobId);
    for (let made = 0; made < count; made++) {
      await runScheduledBackup(site.transport);
      await waitForRunToEnd(site.transport, job.jobId);
    }
    await recordBackups(site.transport, archives, job.jobId, before + count);
  },
);

/**
 * The premise of a refusal: WP-CLI's user may not write the archive — the check the plugin itself
 * makes before it deletes one.
 *
 * On a site whose web server and WP-CLI are one user, or where the web server's archives come out
 * writable by both, nothing the web server makes is out of WP-CLI's reach, so there is no refusal to
 * observe. The scenario is then **skipped, with that reason**, rather than failed: the plugin is
 * behaving correctly there, and a failure would blame it for the host.
 */
Given(
  "WP-CLI's user may not write the {word} backup",
  async ({ site, archives, $testInfo }, which: string) => {
    const name = archives.named(runOrder(which));
    const { file, folder } = await findBackup(site.transport, name);
    expect(file, `${folder.dir} should hold ${name}`).toBeDefined();
    $testInfo.skip(
      file?.writable === true,
      `WP-CLI's user may write ${name}, which the web server made — on this site the two are ` +
        "one user, or share write access to what the web server writes — so there is no " +
        "permission refusal to observe.",
    );
  },
);

// ── What became of them ──────────────────────────────────────────────────────

/** An archive in the scheduled job's backup folder, if it is still there, and the folder. */
async function findBackup(
  transport: Transport,
  name: string,
  digests = false,
): Promise<{ readonly file?: SiteFile; readonly folder: SiteDirectory }> {
  const job = await theScheduledJob(transport);
  const folder = await readBackupFolder(transport, job.jobId, { digests });
  const file = folder.files.find((candidate) => candidate.name === name);
  return file === undefined ? { folder } : { file, folder };
}

/** The names a folder holds, for a failure message. */
function holding(files: readonly SiteFile[]): string {
  return files.map((file) => file.name).join(", ") || "nothing";
}

/** That the archive is no longer on the site — read from its folder, not from a listing command. */
Then(
  "the {word} backup is gone from the site",
  async ({ site, archives }, which: string) => {
    const name = archives.named(runOrder(which));
    const { file, folder } = await findBackup(site.transport, name);
    expect(
      file,
      `${folder.dir} should no longer hold ${name} (it holds ${holding(folder.files)})`,
    ).toBeUndefined();
  },
);

/**
 * That the archive is still on the site and is **exactly** what its run wrote — the digest taken
 * when it was made. A delete that half-worked, truncating or rewriting the file, fails here where a
 * check of its presence or its name would pass.
 */
Then(
  "the {word} backup is still on the site, byte for byte",
  async ({ site, archives }, which: string) => {
    const name = archives.named(runOrder(which));
    const { file, folder } = await findBackup(site.transport, name, true);
    expect(
      file,
      `${folder.dir} should still hold ${name} (it holds ${holding(folder.files)})`,
    ).toBeDefined();
    expect(
      file?.sha256,
      `${name} should be byte for byte what its run wrote`,
    ).toBe(archives.digestOf(name));
  },
);

// ── Downloads ────────────────────────────────────────────────────────────────

/** A file in the scenario's download folder, read with its digest, if it is there. */
async function downloaded(
  downloads: DownloadFolder,
  name: string,
): Promise<{ readonly file?: SiteFile; readonly dir: string }> {
  const dir = await downloads.absolutePath();
  const file = (await downloads.list()).find(
    (candidate) => candidate.name === name,
  );
  return file === undefined ? { dir } : { file, dir };
}

/** That a file in the download folder is a byte-for-byte copy of a backup the scenario made. */
async function expectCopyOf(
  downloads: DownloadFolder,
  archives: ArchiveSnapshot,
  fileName: string,
  which: string,
): Promise<void> {
  const backup = archives.named(runOrder(which));
  const { file, dir } = await downloaded(downloads, fileName);
  expect(file, `${dir} should hold ${fileName}`).toBeDefined();
  expect(
    file?.sha256,
    `${fileName} should be byte for byte the ${which} backup, ${backup}`,
  ).toBe(archives.digestOf(backup));
}

/**
 * A file already sitting where a download will land — holding content known in advance, so a later
 * step can tell it apart from the backup that might replace it.
 */
Given(
  "the download folder already holds a file named {string}",
  async ({ downloads }, name: string) => {
    await downloads.place(name);
  },
);

/**
 * That the download folder holds the backup under the backup's own name — where a download lands
 * when its destination is a folder — as a byte-for-byte copy.
 *
 * The folder was handed to the command relative to the WordPress root and is read back here by its
 * absolute path, so the copy being there is also what proves which directory the command wrote to.
 */
Then(
  "the download folder holds a byte-for-byte copy of the {word} backup",
  async ({ downloads, archives }, which: string) => {
    await expectCopyOf(
      downloads,
      archives,
      archives.named(runOrder(which)),
      which,
    );
  },
);

/** That a named file in the download folder is now a byte-for-byte copy of a backup. */
Then(
  "the file {string} in the download folder is a byte-for-byte copy of the {word} backup",
  async ({ downloads, archives }, name: string, which: string) => {
    await expectCopyOf(downloads, archives, name, which);
  },
);

/** That a file placed in the download folder still holds exactly what was placed there. */
Then(
  "the file {string} in the download folder is still the one placed there",
  async ({ downloads }, name: string) => {
    const { file, dir } = await downloaded(downloads, name);
    expect(file, `${dir} should still hold ${name}`).toBeDefined();
    expect(file?.sha256, `${name} should hold what was placed there`).toBe(
      createHash("sha256").update(PLACED_FILE_CONTENT).digest("hex"),
    );
  },
);

/**
 * That nothing was written to the download folder — which a refused download must leave as it found
 * it, not holding an empty or half-written file.
 */
Then("nothing was downloaded", async ({ downloads }) => {
  const dir = await downloads.absolutePath();
  expect(
    (await downloads.list()).map((file) => file.name),
    `what ${dir} holds`,
  ).toEqual([]);
});
