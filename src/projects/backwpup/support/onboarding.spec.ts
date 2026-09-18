import { test, expect } from "@playwright/test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  completeOnboarding,
  completeOnboardingPhp,
  finishActivation,
  isOnboardingPending,
  readOnboardingFlag,
} from "./onboarding";
import type { LocalTransport } from "../../../common/config/types";

// A stub `wp` on PATH. `set` is what WordPress prints for the boolean `true` the plugin writes;
// `deleted` is WP-CLI's own wording once onboarding completes and the row is removed.
const STUB_WP = `#!/usr/bin/env bash
# Running WordPress always succeeds; only the option read varies, which is what lets a test make
# the activation routine run and still control what it left behind.
if [ "$1" = "eval" ]; then exit 0; fi
case "$WP_STUB_MODE" in
  set)      printf '1\\n' ;;
  deleted)  printf "Error: Could not get 'backwpup_onboarding' option. Does it exist?" >&2; exit 1 ;;
  broken)   printf 'Error: Error establishing a database connection.' >&2; exit 1 ;;
esac
exit 0
`;

let binDir: string;
let rootDir: string;
let originalPath: string | undefined;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "bwp-onb-stub-bin-"));
  rootDir = mkdtempSync(join(tmpdir(), "bwp-onb-stub-root-"));
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

test.describe("readOnboardingFlag", () => {
  test("returns the value WordPress stores for the plugin's boolean", async () => {
    process.env.WP_STUB_MODE = "set";
    expect(await readOnboardingFlag(local())).toBe("1");
  });

  // Completing onboarding deletes the row rather than falsifying it, so absence is the normal
  // "already onboarded" state and must not read as an error.
  test("a site that completed onboarding has no option at all", async () => {
    process.env.WP_STUB_MODE = "deleted";
    expect(await readOnboardingFlag(local())).toBeUndefined();
  });

  test("a site that cannot answer throws rather than reading as onboarded", async () => {
    process.env.WP_STUB_MODE = "broken";
    await expect(readOnboardingFlag(local())).rejects.toThrow(
      /database connection/,
    );
  });
});

test.describe("isOnboardingPending", () => {
  test("the value the plugin writes means onboarding is still owed", () => {
    expect(isOnboardingPending("1")).toBe(true);
    expect(isOnboardingPending("1\n")).toBe(true);
  });

  test("an absent row means onboarding is done", () => {
    expect(isOnboardingPending(undefined)).toBe(false);
  });

  // WordPress stores `false` as an empty string, and a hand-set `0` is falsy to PHP as well; both
  // must read the way the plugin's own `get_site_option(..., false)` check would.
  test("a falsy value is read the way WordPress would read it", () => {
    expect(isOnboardingPending("")).toBe(false);
    expect(isOnboardingPending("0")).toBe(false);
  });
});

// ── completeOnboarding ───────────────────────────────────────────────────────

/**
 * A second stub, dispatching on the command rather than on one mode, because completing onboarding
 * is a sequence: seed, then read the flag, the stored jobs and the cron event back. Each read
 * answers from its own variable so a test can make exactly one of them wrong — which is the point,
 * since the whole value of this function is that it refuses to report success on a bad seed.
 */
const STUB_SEQUENCE = `#!/usr/bin/env bash
case "$1" in
  eval)
    case "$2" in
      *wp_next_scheduled*) printf '%s' "$WP_STUB_NEXT_RUN" ;;
      # Matched on the seeding snippet's own call, not on "any eval": completeOnboarding runs
      # finishActivation's bootstrap eval first, so a catch-all here would fail *that* instead and
      # the test below would pass while never exercising the path it names.
      *save_post_form*)    [ -n "$WP_STUB_SEED_FAILS" ] && { printf 'PHP Fatal error: nope' >&2; exit 1; } ;;
      *)                   [ -n "$WP_STUB_BOOTSTRAP_FAILS" ] && { printf 'PHP Fatal error: bootstrap' >&2; exit 1; } ;;
    esac ;;
  option)
    case "$3" in
      backwpup_onboarding)
        # First read is finishActivation's (a fresh install owes onboarding); later reads are the
        # verification's, which expects the flag gone unless a test asks otherwise.
        if [ ! -f "$WP_STUB_ASKED" ]; then touch "$WP_STUB_ASKED"; printf '1'
        elif [ -n "$WP_STUB_STILL_PENDING" ]; then printf '1'
        else printf "Error: Could not get 'backwpup_onboarding' option. Does it exist?" >&2; exit 1; fi ;;
      backwpup_jobs) printf '%s' "$WP_STUB_JOBS" ;;
    esac ;;
esac
exit 0
`;

const DB_JOB =
  '[{"jobid":9,"type":["DBDUMP"],"destinations":["FOLDER"],"activetype":"wpcron","cron":"0 0 1 * *"}]';

test.describe("completeOnboarding", () => {
  let seqDir: string;
  let seqPath: string | undefined;

  test.beforeAll(() => {
    seqDir = mkdtempSync(join(tmpdir(), "bwp-seed-stub-"));
    const wp = join(seqDir, "wp");
    writeFileSync(wp, STUB_SEQUENCE);
    chmodSync(wp, 0o755);
  });

  test.beforeEach(() => {
    seqPath = process.env.PATH;
    process.env.PATH = `${seqDir}:${originalPath ?? ""}`;
    process.env.WP_STUB_ASKED = join(seqDir, "asked");
    rmSync(process.env.WP_STUB_ASKED, { force: true });
    process.env.WP_STUB_JOBS = DB_JOB;
    process.env.WP_STUB_NEXT_RUN = "1788238800";
    delete process.env.WP_STUB_SEED_FAILS;
    delete process.env.WP_STUB_BOOTSTRAP_FAILS;
    delete process.env.WP_STUB_STILL_PENDING;
  });

  test.afterEach(() => {
    if (seqPath !== undefined) process.env.PATH = seqPath;
    delete process.env.WP_STUB_ASKED;
    delete process.env.WP_STUB_JOBS;
    delete process.env.WP_STUB_NEXT_RUN;
    delete process.env.WP_STUB_SEED_FAILS;
    delete process.env.WP_STUB_BOOTSTRAP_FAILS;
    delete process.env.WP_STUB_STILL_PENDING;
  });

  test.afterAll(() => {
    rmSync(seqDir, { recursive: true, force: true });
  });

  test("returns the id of the job the seed produced", async () => {
    expect(await completeOnboarding(local(), "database")).toBe(9);
  });

  test("throws with PHP's own output when the seeding itself fails", async () => {
    process.env.WP_STUB_SEED_FAILS = "1";
    await expect(completeOnboarding(local(), "database")).rejects.toThrow(
      /PHP Fatal error: nope/,
    );
  });

  test("throws when the activation it runs first fails, naming that instead", async () => {
    // The two failures are distinct and reach the caller by different routes; asserting only the
    // shared "PHP Fatal error" prefix would let either stand in for the other.
    process.env.WP_STUB_BOOTSTRAP_FAILS = "1";
    await expect(completeOnboarding(local(), "database")).rejects.toThrow(
      /PHP Fatal error: bootstrap/,
    );
  });

  test("refuses to report success while onboarding is still owed", async () => {
    // The seeding command exits zero whatever it did, so this is the check that turns a no-op into
    // a failure instead of a scenario that quietly drives onboarding again.
    process.env.WP_STUB_STILL_PENDING = "1";
    await expect(completeOnboarding(local(), "database")).rejects.toThrow(
      /no longer be owed/,
    );
  });

  test("refuses a job that backs up something other than what was asked for", async () => {
    process.env.WP_STUB_JOBS =
      '[{"jobid":9,"type":["FILE","DBDUMP","WPPLUGIN"],"destinations":["FOLDER"],"activetype":"wpcron"}]';
    await expect(completeOnboarding(local(), "database")).rejects.toThrow(
      /exactly one scheduled backup job/,
    );
  });

  test("refuses a job with no cron event of its own", async () => {
    // A job that exists but was never scheduled would make the "its schedule comes due" scenario
    // fail several steps later, pointing at the trigger instead of at the setup.
    process.env.WP_STUB_NEXT_RUN = "0";
    await expect(completeOnboarding(local(), "database")).rejects.toThrow(
      /WP-Cron event of its own/,
    );
  });
});

// ── the emitted snippet ──────────────────────────────────────────────────────

/**
 * The snippet is what actually decides which jobs onboarding ends up with: a data type is active
 * to `save_post_form()` exactly when its frequency field is present in `$_POST`, so a missing or
 * stray line is the difference between one job and two. Asserted per variant because the runtime
 * check inside `completeOnboarding` can only report that the outcome was wrong, not why.
 */
test.describe("completeOnboardingPhp", () => {
  /** The frequency assignments the snippet emits, in order, with whitespace normalised. */
  const frequencyLines = (
    contents: Parameters<typeof completeOnboardingPhp>[0],
  ) =>
    completeOnboardingPhp(contents)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("$_POST[ 'job_"));

  test("a files-only job posts the files frequency and nothing else", () => {
    expect(frequencyLines("files")).toEqual([
      "$_POST[ 'job_' . $files . '_frequency' ] = 'monthly';",
    ]);
  });

  test("a database-only job posts the database frequency and nothing else", () => {
    expect(frequencyLines("database")).toEqual([
      "$_POST[ 'job_' . $database . '_frequency' ] = 'monthly';",
    ]);
  });

  test("asking for both posts both, which is what merges them into one job", () => {
    // `save_post_form()` merges files and database into a single job only when both are active and
    // share a cron; posting one frequency would silently produce the wrong shape.
    expect(frequencyLines("files and database")).toEqual([
      "$_POST[ 'job_' . $files . '_frequency' ] = 'monthly';",
      "$_POST[ 'job_' . $database . '_frequency' ] = 'monthly';",
    ]);
  });

  test("the job ids are the two after the first-backup job, as the onboarding page assigns them", () => {
    const php = completeOnboardingPhp("database");
    expect(php).toContain("$files = $first + 1;");
    expect(php).toContain("$database = $first + 2;");
    // Reproducing the page's own arithmetic is the point; allocating ids some other way would put
    // the frequency fields on jobs `save_post_form()` never looks at.
    expect(php).not.toContain("next_job_id");
  });

  test("the destination is saved before the submit, on the first-backup job", () => {
    const php = completeOnboardingPhp("database");
    const savedDestination = php.indexOf(
      "$folder->edit_form_post_save( [ $first ] );",
    );
    const submitted = php.indexOf(
      "BackWPup_Page_Onboarding::save_post_form();",
    );
    expect(savedDestination).toBeGreaterThan(-1);
    // Order is load-bearing: the submit clones the first-backup job into every job it creates, so a
    // destination saved afterwards would never reach them.
    expect(savedDestination).toBeLessThan(submitted);
    expect(php).toContain("'onboarding_storage' => [ 'FOLDER' ]");
  });
});

test.describe("finishActivation", () => {
  test("reports a site that does not come out of activation owing its onboarding", async () => {
    // Exactly what an earlier scenario's surviving footprint looks like: the plugin decides it has
    // nothing to set up, so the flag never appears. Saying so here beats a puzzling redirect
    // failure two steps later.
    process.env.WP_STUB_MODE = "deleted";
    await expect(finishActivation(local())).rejects.toThrow(
      /owe its onboarding/,
    );
  });

  test("passes when the routine leaves the site owing its onboarding", async () => {
    process.env.WP_STUB_MODE = "set";
    await expect(finishActivation(local())).resolves.toBeUndefined();
  });
});
