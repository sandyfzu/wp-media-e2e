import { test, expect } from "@playwright/test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ACTIVATION_ATTEMPTS,
  completeOnboarding,
  completeOnboardingPhp,
  finishActivation,
  isOnboardingPending,
  isPristineActivation,
  readOnboardingFlag,
  reinstallPlugin,
} from "./onboarding";
import { HOOK_TIMEOUT_MS } from "../../../common/hooks/plugin-lifecycle";
import type { StoredJob } from "./job-options";
import type { ResolvedArtifact } from "../../../common/artifacts/types";
import type { LocalTransport } from "../../../common/config/types";

// A stub `wp` on PATH. `set` is what WordPress prints for the boolean `true` the plugin writes;
// `deleted` is WP-CLI's own wording once onboarding completes and the row is removed. The job list
// answers from its own variable, so a test controls the flag and the jobs independently.
const STUB_WP = `#!/usr/bin/env bash
# Running WordPress always succeeds; only the option reads vary, which is what lets a test make
# the activation routine run and still control what it left behind.
if [ "$1" = "eval" ]; then exit 0; fi
if [ "$3" = "backwpup_jobs" ]; then printf '%s' "$WP_STUB_FRESH_JOBS"; exit 0; fi
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

/** The job list a clean install leaves: one job, the first-backup placeholder (measured). */
const PLACEHOLDER_ONLY = '[{"jobid":1,"tempjob":true}]';

/** A reinstall for a site that must not need one — the test fails if it is ever asked for. */
const refuseReinstall = (): Promise<void> =>
  Promise.reject(new Error("reinstalled a site that did not need it"));

/** The slice of a scenario's test info a reinstall adjusts, starting at `timeout`. */
function budget(timeout: number): {
  timeout: number;
  setTimeout(value: number): void;
} {
  return {
    timeout,
    setTimeout(value) {
      this.timeout = value;
    },
  };
}

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
      *save_post_form*)    [ -n "$WP_STUB_SEED_FAILS" ] && { printf 'PHP Fatal error: nope' >&2; exit 1; }
                           touch "$WP_STUB_SEEDED" ;;
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
      # Before the seed, what a clean install holds; after it, whatever the test says it made.
      backwpup_jobs)
        if [ -f "$WP_STUB_SEEDED" ]; then printf '%s' "$WP_STUB_JOBS"
        else printf '%s' '[{"jobid":1,"tempjob":true}]'; fi ;;
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
    process.env.WP_STUB_SEEDED = join(seqDir, "seeded");
    rmSync(process.env.WP_STUB_SEEDED, { force: true });
    process.env.WP_STUB_JOBS = DB_JOB;
    process.env.WP_STUB_NEXT_RUN = "1788238800";
    delete process.env.WP_STUB_SEED_FAILS;
    delete process.env.WP_STUB_BOOTSTRAP_FAILS;
    delete process.env.WP_STUB_STILL_PENDING;
  });

  test.afterEach(() => {
    if (seqPath !== undefined) process.env.PATH = seqPath;
    delete process.env.WP_STUB_ASKED;
    delete process.env.WP_STUB_SEEDED;
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
    expect(await completeOnboarding(local(), "database", refuseReinstall)).toBe(
      9,
    );
  });

  test("throws with PHP's own output when the seeding itself fails", async () => {
    process.env.WP_STUB_SEED_FAILS = "1";
    await expect(
      completeOnboarding(local(), "database", refuseReinstall),
    ).rejects.toThrow(/PHP Fatal error: nope/);
  });

  test("throws when the activation it runs first fails, naming that instead", async () => {
    // The two failures are distinct and reach the caller by different routes; asserting only the
    // shared "PHP Fatal error" prefix would let either stand in for the other.
    process.env.WP_STUB_BOOTSTRAP_FAILS = "1";
    await expect(
      completeOnboarding(local(), "database", refuseReinstall),
    ).rejects.toThrow(/PHP Fatal error: bootstrap/);
  });

  test("refuses to report success while onboarding is still owed", async () => {
    // The seeding command exits zero whatever it did, so this is the check that turns a no-op into
    // a failure instead of a scenario that quietly drives onboarding again.
    process.env.WP_STUB_STILL_PENDING = "1";
    await expect(
      completeOnboarding(local(), "database", refuseReinstall),
    ).rejects.toThrow(/no longer be owed/);
  });

  test("refuses a job that backs up something other than what was asked for", async () => {
    process.env.WP_STUB_JOBS =
      '[{"jobid":9,"type":["FILE","DBDUMP","WPPLUGIN"],"destinations":["FOLDER"],"activetype":"wpcron"}]';
    await expect(
      completeOnboarding(local(), "database", refuseReinstall),
    ).rejects.toThrow(/exactly one scheduled backup job/);
  });

  test("refuses a job with no cron event of its own", async () => {
    // A job that exists but was never scheduled would make the "its schedule comes due" scenario
    // fail several steps later, pointing at the trigger instead of at the setup.
    process.env.WP_STUB_NEXT_RUN = "0";
    await expect(
      completeOnboarding(local(), "database", refuseReinstall),
    ).rejects.toThrow(/WP-Cron event of its own/);
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
  const warnings: string[] = [];
  let realWarn: typeof console.warn;

  test.beforeEach(() => {
    warnings.length = 0;
    realWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(" "));
    };
    process.env.WP_STUB_FRESH_JOBS = PLACEHOLDER_ONLY;
  });

  test.afterEach(() => {
    console.warn = realWarn;
    delete process.env.WP_STUB_FRESH_JOBS;
  });

  test("passes without reinstalling when the routine leaves the site as a fresh install", async () => {
    process.env.WP_STUB_MODE = "set";
    await expect(
      finishActivation(local(), refuseReinstall),
    ).resolves.toBeUndefined();
    expect(warnings).toEqual([]);
  });

  // The race's footprint: a second request took the upgrade path and deleted the flag. The stub
  // answering "set" once reinstalled stands for the clean install that follows.
  test("a raced activation is redone from a clean install, and reported", async () => {
    process.env.WP_STUB_MODE = "deleted";
    let reinstalls = 0;
    await finishActivation(local(), () => {
      reinstalls++;
      process.env.WP_STUB_MODE = "set";
      return Promise.resolve();
    });

    expect(reinstalls).toBe(1);
    expect(warnings.join("\n")).toMatch(
      /another request reaching the site while it ran .* \(install 2 of 3\)/,
    );
  });

  // The race's other footprint: two requests each made a placeholder, and one lost its flag to the
  // other's write — a real job nobody configured, with the onboarding flag still in place.
  test("an activation that left a job nobody configured is redone like a lost flag", async () => {
    process.env.WP_STUB_MODE = "set";
    process.env.WP_STUB_FRESH_JOBS = '[{"jobid":1},{"jobid":2,"tempjob":true}]';
    let reinstalls = 0;
    await finishActivation(local(), () => {
      reinstalls++;
      process.env.WP_STUB_FRESH_JOBS = PLACEHOLDER_ONLY;
      return Promise.resolve();
    });

    expect(reinstalls).toBe(1);
    expect(warnings.join("\n")).toMatch(/2 job\(s\), 1 of them a placeholder/);
  });

  // What an earlier run's surviving footprint looks like too: the plugin decides it has nothing to
  // set up. Past the attempts, saying so here beats a puzzling redirect failure two steps later.
  test("gives up once every install has come out not owing its onboarding", async () => {
    process.env.WP_STUB_MODE = "deleted";
    let reinstalls = 0;
    await expect(
      finishActivation(local(), () => {
        reinstalls++;
        return Promise.resolve();
      }),
    ).rejects.toThrow(/owe its onboarding .* after 3 installs/);
    expect(reinstalls).toBe(ACTIVATION_ATTEMPTS - 1);
  });

  test("gives up once every install has left a job nobody configured", async () => {
    process.env.WP_STUB_MODE = "set";
    process.env.WP_STUB_FRESH_JOBS = '[{"jobid":1},{"jobid":2,"tempjob":true}]';
    await expect(
      finishActivation(local(), () => Promise.resolve()),
    ).rejects.toThrow(
      /hold only its first-backup placeholder .* after 3 installs/,
    );
  });

  test("a reinstall that fails ends it with that failure", async () => {
    process.env.WP_STUB_MODE = "deleted";
    await expect(
      finishActivation(local(), () =>
        Promise.reject(new Error("no space left on device")),
      ),
    ).rejects.toThrow(/no space left on device/);
  });
});

test.describe("isPristineActivation", () => {
  /** A stored job with only what the judgement reads set; the rest as a record without them. */
  function job(jobId: number, tempJob: boolean): StoredJob {
    return {
      jobId,
      type: [],
      destinations: [],
      cron: "",
      frequency: "",
      activeType: "",
      tempJob,
      backupNow: false,
      includedAreas: {},
      excludedTables: [],
    };
  }

  test("onboarding owed and the first-backup placeholder alone is a fresh install", () => {
    expect(isPristineActivation({ flag: "1", jobs: [job(1, true)] })).toBe(
      true,
    );
  });

  test("a lost flag is not, whatever the jobs", () => {
    expect(
      isPristineActivation({ flag: undefined, jobs: [job(1, true)] }),
    ).toBe(false);
  });

  test("a job beside the placeholder is not, placeholder or not", () => {
    expect(
      isPristineActivation({ flag: "1", jobs: [job(1, false), job(2, true)] }),
    ).toBe(false);
    expect(
      isPristineActivation({ flag: "1", jobs: [job(1, true), job(2, true)] }),
    ).toBe(false);
  });

  test("no job, or one that is not a placeholder, is not", () => {
    expect(isPristineActivation({ flag: "1", jobs: [] })).toBe(false);
    expect(isPristineActivation({ flag: "1", jobs: [job(1, false)] })).toBe(
      false,
    );
  });
});

test.describe("reinstallPlugin", () => {
  /** An artifact the lifecycle refuses before running anything — proof it was what ran. */
  const unusable: ResolvedArtifact = {
    role: "plugin",
    slug: "../elsewhere",
    zipPath: "/nonexistent/backwpup.zip",
    zipFilename: "backwpup.zip",
    source: "default-ref",
    origin: "built",
    resolvedAt: "2026-09-23T00:00:00.000Z",
  };

  test("adds the install's own budget to the scenario's, then runs the @plugin hook's install", async () => {
    const testInfo = budget(90_000);
    await expect(
      reinstallPlugin(local(), unusable, testInfo)(),
    ).rejects.toThrow(/not a usable plugin slug/);
    expect(testInfo.timeout).toBe(90_000 + HOOK_TIMEOUT_MS);
  });

  test("leaves a scenario with no timeout without one", async () => {
    const testInfo = budget(0);
    await expect(
      reinstallPlugin(local(), unusable, testInfo)(),
    ).rejects.toThrow(/not a usable plugin slug/);
    expect(testInfo.timeout).toBe(0);
  });
});
