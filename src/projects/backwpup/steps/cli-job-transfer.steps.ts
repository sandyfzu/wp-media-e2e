import { expect } from "@playwright/test";

import { Given, Then } from "../fixtures";
import {
  readStoredJobs,
  scheduledJobs,
  theScheduledJob,
} from "../support/job-options";
import {
  STRIPPED_KEYS,
  describeExport,
  describeStoredJob,
  exportJob,
  jobsDigest,
  nameExportedJob,
  settingsDifferingFromExport,
  settingsMissingFromExport,
} from "../support/job-transfer";
import { CRON_HOOK } from "../support/onboarding";
import { nextScheduled } from "../../../common/wp/cron";
import type { ExportedJob } from "../support/job-transfer";
import type { StoredJob } from "../support/job-options";
import type { PrivateFolder } from "../support/private-folder";
import type { Transport } from "../../../common/config/types";

/**
 * Steps for `wp backwpup job-export` and `job-import`.
 *
 * **Held to the jobs the site stores.** An export file is the command under test's own output, so
 * each claim about it — what it carries, what it left out — is checked against the stored job it
 * came from; and each claim about an import is checked against the stored jobs it left, never
 * against the command's success line.
 *
 * **Compared on the site, answered in key names** (`support/job-transfer.ts`): an export carries the
 * site's database host, name and user, and a stored job its database password, encrypted — so no
 * value crosses into a step or a failure message. Export files live in the scenario's private
 * folder.
 */

/** Intersects two lists of key names, in the first one's order. */
function common(
  keys: readonly string[],
  others: readonly string[],
): readonly string[] {
  const set = new Set(others);
  return keys.filter((key) => set.has(key));
}

/** The one job an export file in the private folder holds, as the site reads it. */
async function exportedJob(
  transport: Transport,
  folder: PrivateFolder,
  file: string,
): Promise<ExportedJob> {
  const jobs = await describeExport(
    transport,
    await folder.absolutePathTo(file),
  );
  expect(
    jobs.map((job) => job.jobId),
    `${file} should hold exactly one job`,
  ).toHaveLength(1);
  const [job] = jobs;
  if (job === undefined) throw new Error("unreachable: asserted above");
  return job;
}

// ── Arranging an export ──────────────────────────────────────────────────────

/**
 * The scheduled job exported into the private folder — the arrangement for a scenario about what an
 * import makes of it. The command's own behaviour is its own scenario's claim; here a refusal is a
 * broken precondition. The digest of the site's jobs is recorded as the export is made, so "as they
 * were" can be checked afterwards.
 */
Given(
  "the scheduled job has been exported to {string}",
  async ({ site, privateFolder, jobExports }, file: string) => {
    const job = await theScheduledJob(site.transport);
    await exportJob(
      site.transport,
      job.jobId,
      await privateFolder.relativePathTo(file),
    );
    jobExports.record(file, await jobsDigest(site.transport));
  },
);

/** The edit a user makes to an export before importing it over the job it came from. */
Given(
  "the export file {string} names its job {string}",
  async ({ site, privateFolder }, file: string, name: string) => {
    await nameExportedJob(
      site.transport,
      await privateFolder.absolutePathTo(file),
      name,
    );
  },
);

// ── What an export holds ─────────────────────────────────────────────────────

Then(
  "the export file {string} holds the scheduled job and no other",
  async ({ site, privateFolder }, file: string) => {
    const job = await theScheduledJob(site.transport);
    expect(
      (await exportedJob(site.transport, privateFolder, file)).jobId,
      `the job ${file} holds`,
    ).toBe(job.jobId);
  },
);

/**
 * That every setting the file carries is what the scheduled job stores — value against value, on the
 * site. After an import over that job, the same check says the import wrote what the file holds.
 */
Then(
  "every setting the export file {string} carries is the scheduled job's own",
  async ({ site, privateFolder }, file: string) => {
    const job = await theScheduledJob(site.transport);
    expect(
      await settingsDifferingFromExport(
        site.transport,
        await privateFolder.absolutePathTo(file),
        job.jobId,
      ),
      `the settings ${file} carries that job ${String(job.jobId)} does not hold as the file does`,
    ).toEqual([]);
  },
);

/**
 * That the file carries every setting the scheduled job holds but those `job-export` leaves out by
 * design — so an export that dropped a setting fails here, where holding the file to the job alone
 * would pass it. "Empty" is the export's own test: a setting holding an empty string.
 */
Then(
  "every setting the scheduled job holds is in the export file {string}, except its schedule, run history, secrets and empty ones",
  async ({ site, privateFolder }, file: string) => {
    const job = await theScheduledJob(site.transport);
    expect(
      await settingsMissingFromExport(
        site.transport,
        await privateFolder.absolutePathTo(file),
        job.jobId,
      ),
      `the settings job ${String(job.jobId)} holds that ${file} leaves out`,
    ).toEqual([]);
  },
);

/**
 * That the file carries none of the keys the export strips — the schedule's state and the run
 * history — while the job **does** hold some, or leaving them out would prove nothing.
 */
Then(
  "the export file {string} leaves out the job's schedule and run history",
  async ({ site, privateFolder }, file: string) => {
    const job = await theScheduledJob(site.transport);
    const stored = await describeStoredJob(site.transport, job.jobId);
    expect(
      common(stored.keys, STRIPPED_KEYS),
      `job ${String(job.jobId)} should hold some of ${STRIPPED_KEYS.join(", ")}, or leaving them out proves nothing`,
    ).not.toEqual([]);
    const exported = await exportedJob(site.transport, privateFolder, file);
    expect(
      common(exported.keys, STRIPPED_KEYS),
      `the schedule and run history ${file} carries`,
    ).toEqual([]);
  },
);

/**
 * That the file carries none of the secrets the job stores, in either form — while the job **does**
 * store one (every job holds the site's database password, encrypted), or the check would be empty.
 */
Then(
  "the export file {string} leaves out every secret the scheduled job stores",
  async ({ site, privateFolder }, file: string) => {
    const job = await theScheduledJob(site.transport);
    const stored = await describeStoredJob(site.transport, job.jobId);
    expect(
      stored.encrypted,
      `job ${String(job.jobId)} should store an encrypted secret, or leaving secrets out proves nothing`,
    ).not.toEqual([]);
    const exported = await exportedJob(site.transport, privateFolder, file);
    expect(
      common(exported.keys, stored.encrypted),
      `the keys ${file} carries that the job stores encrypted`,
    ).toEqual([]);
    expect(exported.encrypted, `the encrypted values ${file} carries`).toEqual(
      [],
    );
  },
);

// ── What an import did ───────────────────────────────────────────────────────

Then(
  "the scheduled job is now named {string}",
  async ({ site }, name: string) => {
    expect((await theScheduledJob(site.transport)).name).toBe(name);
  },
);

/**
 * The job an export file holds and its copy — the one other job a user would call theirs — once an
 * import has added one.
 */
async function originalAndCopy(
  transport: Transport,
  folder: PrivateFolder,
  file: string,
): Promise<{ readonly original: StoredJob; readonly copy: StoredJob }> {
  const exported = await exportedJob(transport, folder, file);
  const jobs = scheduledJobs(await readStoredJobs(transport));
  expect(
    jobs.map((job) => job.jobId),
    `the site should hold the job ${file} holds and exactly one more`,
  ).toHaveLength(2);
  const original = jobs.find((job) => job.jobId === exported.jobId);
  const copy = jobs.find((job) => job.jobId !== exported.jobId);
  expect(
    original,
    `the site should still hold job ${String(exported.jobId)}, which ${file} holds`,
  ).toBeDefined();
  if (original === undefined || copy === undefined) {
    throw new Error("unreachable: asserted above");
  }
  return { original, copy };
}

Then(
  "the site holds the job exported to {string} and one copy of it, under a different id",
  async ({ site, privateFolder }, file: string) => {
    await originalAndCopy(site.transport, privateFolder, file);
  },
);

/**
 * That the copy holds every setting the file carries, as does the job itself — so the two agree on
 * all of them, and the import changed nothing of the original. The copy's own id is the one key left
 * out of its comparison.
 */
Then(
  "the copy of the job exported to {string} agrees with the job itself on every setting the export carries",
  async ({ site, privateFolder }, file: string) => {
    const { original, copy } = await originalAndCopy(
      site.transport,
      privateFolder,
      file,
    );
    const path = await privateFolder.absolutePathTo(file);
    expect(
      await settingsDifferingFromExport(site.transport, path, original.jobId),
      `the settings ${file} carries that job ${String(original.jobId)} no longer holds as the file does`,
    ).toEqual([]);
    expect(
      await settingsDifferingFromExport(site.transport, path, copy.jobId, [
        "jobid",
      ]),
      `the settings ${file} carries that the copy, job ${String(copy.jobId)}, does not hold as the file does`,
    ).toEqual([]);
  },
);

/** That the import left the copy off the schedule, and the job it copied on it. */
Then(
  "the copy of the job exported to {string} is not scheduled to run, but the job itself still is",
  async ({ site, privateFolder }, file: string) => {
    const { original, copy } = await originalAndCopy(
      site.transport,
      privateFolder,
      file,
    );
    expect(
      await nextScheduled(site.transport, CRON_HOOK, { arg: copy.jobId }),
      `the copy, job ${String(copy.jobId)}, should have no WP-Cron event`,
    ).toBeUndefined();
    expect(
      await nextScheduled(site.transport, CRON_HOOK, { arg: original.jobId }),
      `job ${String(original.jobId)} should still have its WP-Cron event`,
    ).toBeDefined();
  },
);

/**
 * That the site's jobs are exactly as they were when the export was made — the jobs option's row
 * byte for byte — which a refused import must leave them.
 */
Then(
  "the site's backup jobs are as they were when {string} was exported",
  async ({ site, jobExports }, file: string) => {
    expect(
      await jobsDigest(site.transport),
      `the site's jobs, since ${file} was exported`,
    ).toBe(jobExports.digestAt(file));
  },
);
