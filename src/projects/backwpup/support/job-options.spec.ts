import { test, expect } from "@playwright/test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FILE_AREAS,
  addJobPhp,
  describeJobContents,
  fileAreaOption,
  readStoredJobs,
  scheduledJobs,
} from "./job-options";
import type { StoredJob } from "./job-options";
import type { LocalTransport } from "../../../common/config/types";

// A stub `wp` on PATH exercises the reader plus the real exec layer, with no WordPress. The
// payloads mirror what `wp option get backwpup_jobs --format=json` really emits for a site that
// completed onboarding: a `tempjob` placeholder alongside the scheduled job, keys present only
// where the plugin actually wrote them, and PHP's assorted spellings of a boolean.
const PACKED = JSON.stringify([
  {
    jobid: 1,
    name: "First backup",
    type: ["FILE", "DBDUMP", "WPPLUGIN"],
    destinations: ["FOLDER"],
    cron: "0 0 1 * *",
    frequency: "monthly",
    activetype: "wpcron",
    tempjob: true,
  },
  {
    jobid: 2,
    type: ["FILE", "WPPLUGIN"],
    destinations: ["FOLDER"],
    cron: "0 0 * * 0",
    frequency: "weekly",
    activetype: "wpcron",
    tempjob: false,
    backuproot: true,
    backupplugins: false,
    dbdumpexclude: ["e2e_options"],
  },
]);

// Deleting a job leaves a gap in the PHP array, and WP-CLI then serialises the whole option as an
// object. Reading only the packed shape would report such a site as having no jobs at all.
const SPARSE = JSON.stringify({
  "0": { jobid: 1, tempjob: true },
  "2": { jobid: 3, type: ["DBDUMP"], tempjob: "" },
});

// Booleans survive the options table in three different spellings depending on how they were
// written and re-read; all three must mean the same thing.
const SPELLINGS = JSON.stringify([
  {
    jobid: 4,
    tempjob: 0,
    backuproot: "1",
    backupplugins: "0",
    backupthemes: 1,
  },
]);

// A record with no `jobid` is one BackWPup itself discards (`jobs_options()` unsets it).
const NO_JOB_ID = JSON.stringify([{ name: "orphan" }, { jobid: 9 }]);

// "Backup now" creates a throwaway job of its own, which `wp backwpup job` skips exactly as it
// skips a `tempjob`. Both spellings appear because the option survives the table either way.
const BACKUP_NOW = JSON.stringify([
  { jobid: 5, tempjob: false, backup_now: true },
  { jobid: 6, tempjob: false, backup_now: "1" },
  { jobid: 7, tempjob: false, backup_now: false },
]);

const STUB_WP = `#!/usr/bin/env bash
case "$WP_STUB_MODE" in
  packed)    printf '%s' '${PACKED}' ;;
  sparse)    printf '%s' '${SPARSE}' ;;
  spellings) printf '%s' '${SPELLINGS}' ;;
  no-job-id) printf '%s' '${NO_JOB_ID}' ;;
  backup-now) printf '%s' '${BACKUP_NOW}' ;;
  empty)     printf '[]' ;;
  not-set)   printf "Error: Could not get 'backwpup_jobs' option. Does it exist?" >&2; exit 1 ;;
  broken)    printf 'Error: Error establishing a database connection.' >&2; exit 1 ;;
esac
exit 0
`;

let binDir: string;
let rootDir: string;
let originalPath: string | undefined;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "bwp-jobs-stub-bin-"));
  rootDir = mkdtempSync(join(tmpdir(), "bwp-jobs-stub-root-"));
  const wp = join(binDir, "wp");
  writeFileSync(wp, STUB_WP);
  chmodSync(wp, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
});

test.afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(binDir, { recursive: true, force: true });
  rmSync(rootDir, { recursive: true, force: true });
});

const local = (): LocalTransport => ({ mode: "local", rootDir });

const read = async (mode: string): Promise<readonly StoredJob[]> => {
  process.env.WP_STUB_MODE = mode;
  return readStoredJobs(local());
};

test.describe("readStoredJobs", () => {
  test("maps a job's contents, destinations and schedule", async () => {
    const jobs = await read("packed");
    expect(jobs[1]).toMatchObject({
      jobId: 2,
      type: ["FILE", "WPPLUGIN"],
      destinations: ["FOLDER"],
      cron: "0 0 * * 0",
      frequency: "weekly",
      activeType: "wpcron",
      tempJob: false,
      excludedTables: ["e2e_options"],
    });
  });

  // The distinction the whole reader rests on: an area the user never touched has no stored value
  // and must not be reported as included, or a scenario would "confirm" a plugin default it never
  // observed.
  test("reports only the file areas the job actually stores", async () => {
    const jobs = await read("packed");
    expect(jobs[1]?.includedAreas).toEqual({ root: true, plugins: false });
  });

  test("reads the sparse object shape WP-CLI emits after a deletion", async () => {
    const jobs = await read("sparse");
    expect(jobs.map((job) => job.jobId)).toEqual([1, 3]);
    expect(jobs[1]?.type).toEqual(["DBDUMP"]);
  });

  test("accepts every spelling a boolean survives the options table as", async () => {
    const [job] = await read("spellings");
    expect(job?.tempJob).toBe(false);
    expect(job?.includedAreas).toEqual({
      root: true,
      plugins: false,
      themes: true,
    });
  });

  test("skips records with no job id, exactly as the plugin does", async () => {
    const jobs = await read("no-job-id");
    expect(jobs.map((job) => job.jobId)).toEqual([9]);
  });

  test("a site with no jobs reads as an empty list", async () => {
    expect(await read("empty")).toEqual([]);
  });

  test("an option that was never created reads as no jobs", async () => {
    expect(await read("not-set")).toEqual([]);
  });

  // The false negative this reader exists to prevent: a site that cannot answer must never look
  // like a site with nothing configured.
  test("a WordPress that cannot boot throws rather than reading as no jobs", async () => {
    process.env.WP_STUB_MODE = "broken";
    await expect(readStoredJobs(local())).rejects.toThrow(
      /database connection/,
    );
  });
});

test.describe("scheduledJobs", () => {
  test("hides the placeholder job, matching the dashboard and `wp backwpup job`", async () => {
    const jobs = await read("packed");
    expect(scheduledJobs(jobs).map((job) => job.jobId)).toEqual([2]);
  });

  // The other job the command hides. Counting it would make "the site has one backup job" disagree
  // with `wp backwpup job` the moment any scenario runs a backup on demand.
  test("hides the throwaway job a Backup now run creates", async () => {
    const jobs = await read("backup-now");
    expect(scheduledJobs(jobs).map((job) => job.jobId)).toEqual([7]);
  });
});

test.describe("describeJobContents", () => {
  // The three combinations onboarding can produce, named as a scenario names them.
  test("names each combination the plugin assigns", () => {
    expect(describeJobContents(["FILE", "WPPLUGIN"])).toBe("files");
    expect(describeJobContents(["DBDUMP"])).toBe("database");
    expect(describeJobContents(["FILE", "DBDUMP", "WPPLUGIN"])).toBe(
      "files and database",
    );
  });

  // `wp backwpup job` prints `strtolower(implode(', ', $type))`, so a caller splitting that string
  // hands this lowercase slugs with leading spaces. Normalising here is what lets one function
  // serve both the command's output and the raw option's array.
  test("reads the shape `wp backwpup job` prints", () => {
    expect(describeJobContents("file, dbdump, wpplugin".split(","))).toBe(
      "files and database",
    );
  });

  // Slug order is the plugin's array order and carries no meaning; a reordering must not read as a
  // different backup.
  test("is order-independent", () => {
    expect(describeJobContents(["WPPLUGIN", "DBDUMP", "FILE"])).toBe(
      "files and database",
    );
  });

  // A mixture nobody recognises is reported verbatim, so the failure says what the job actually
  // holds instead of only "not files".
  test("reports an unknown mixture as its own slugs", () => {
    expect(describeJobContents(["FILE"])).toBe("FILE");
    expect(describeJobContents(["DBDUMP", "MYSQL"])).toBe("DBDUMP, MYSQL");
    expect(describeJobContents([])).toBe("(nothing)");
  });

  // A job covering nothing but duplicates must not be mistaken for a two-slug combination.
  test("collapses duplicates before comparing", () => {
    expect(describeJobContents(["FILE", "FILE"])).toBe("FILE");
  });
});

test.describe("file-area vocabulary", () => {
  // The UI locates these checkboxes by the same key the option uses, so the mapping is the single
  // point where the two could ever disagree.
  test("maps each area onto the plugin's own option key", () => {
    expect(FILE_AREAS.map(fileAreaOption)).toEqual([
      "backuproot",
      "backupcontent",
      "backupplugins",
      "backupthemes",
      "backupuploads",
    ]);
  });
});

test.describe("addJobPhp", () => {
  /**
   * The values the snippet embeds, decoded back out of `phpLiteral`'s base64.
   *
   * Reading them back is the only way to assert what the site will actually receive: the encoding
   * is what makes the literal injection-proof, and it also makes the snippet unreadable by eye.
   */
  const embedded = (contents: Parameters<typeof addJobPhp>[0]): unknown[] =>
    [...addJobPhp(contents).matchAll(/base64_decode\( '([^']+)' \)/g)].map(
      (match): unknown =>
        JSON.parse(Buffer.from(match[1] ?? "", "base64").toString()) as unknown,
    );

  test("posts to the add-job route under the namespace that serves it", () => {
    // Taken from `./rest.ts`'s verified table rather than written out here, so a route that moved
    // namespace cannot leave this snippet addressing one WordPress no longer serves.
    expect(embedded("database")[0]).toBe("/backwpup/v1/addjob");
  });

  test("sends the endpoint's own word for each set of contents", () => {
    expect(embedded("files")[1]).toBe("files");
    expect(embedded("database")[1]).toBe("database");
    // The endpoint validates against `files`/`database`/`mixed` and rejects anything else, so
    // "files and database" cannot be passed through under the name a scenario uses for it.
    expect(embedded("files and database")[1]).toBe("mixed");
  });

  test("acts as a real administrator, because the route checks a capability", () => {
    const php = addJobPhp("database");
    expect(php).toContain("wp_set_current_user");
    expect(php).toContain("rest_do_request");
    // The job record, its id and its cron event are the plugin's to create: writing them here
    // would be a second implementation of a schema this suite does not own.
    expect(php).not.toContain("update_site_option");
    expect(php).not.toContain("wp_schedule_single_event");
  });

  test("turns a refusal from the endpoint into a failure that names the status", () => {
    const php = addJobPhp("database");
    expect(php).toContain("$response->is_error()");
    expect(php).toContain("WP_CLI::error");
  });
});
