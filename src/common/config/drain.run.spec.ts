import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { STOPPED_ANNOTATION, STOP_FILE_ENV } from "./drain";

/**
 * The drain end to end: the gate, the fixture order and the `@plugin` After hook, through the real
 * `bddgen`, runner and shared hooks — what `drain.spec.ts` cannot reach, since a mutation of the
 * bindings leaves every pure function intact.
 *
 * A synthetic product runs the two scenarios of `__fixtures__/drain/drain.feature` on a placeholder
 * site, so nothing leaves the machine. Its config is written to a temporary folder: the factory's
 * relative paths (generated specs, setup projects) then land there, never in the repository.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, "src/common/__fixtures__/drain");

/** How long one child process may take: `bddgen`, or a run of two short scenarios and a retry. */
const CHILD_TIMEOUT_MS = 90_000;

/** One test of the JSON report, as far as these cases read it. */
interface ReportedTest {
  readonly title: string;
  readonly status: string;
  readonly annotations: readonly { readonly type: string }[];
  readonly results: readonly {
    readonly status: string;
    readonly errors: readonly { readonly message?: string }[];
  }[];
}

/** What one run of the synthetic product left. */
interface RunOutcome {
  readonly exitCode: number | null;
  readonly tests: readonly ReportedTest[];
}

let work = "";

test.beforeAll(() => {
  // Its real path: playwright-bdd compares the feature's path to the config's resolved folder, and
  // macOS's temporary folder sits behind a symlink.
  work = realpathSync(mkdtempSync(join(tmpdir(), "e2e-drain-")));
  writeFileSync(join(work, "package.json"), '{ "type": "module" }\n');
  // The config names its reporters as bare modules, resolved from the config's own folder.
  symlinkSync(join(REPO_ROOT, "node_modules"), join(work, "node_modules"));
  // playwright-bdd takes features only from under the config's folder.
  copyFileSync(join(FIXTURE_DIR, "drain.feature"), join(work, "drain.feature"));
  writeFileSync(join(work, "playwright.config.ts"), configSource(work));
});

test.afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/**
 * The synthetic product's config: one placeholder cell, `x`, whose steps are the shared fixtures,
 * the shared hooks — the binding under test — and the fixture's own steps.
 */
function configSource(dir: string): string {
  const product = {
    name: "drainprobe",
    features: join(dir, "drain.feature"),
    steps: [
      join(REPO_ROOT, "src/common/fixtures.ts"),
      join(REPO_ROOT, "src/common/hooks/**/*.hooks.ts"),
      join(FIXTURE_DIR, "*.steps.ts"),
    ],
    sites: {
      x: {
        sites: [
          {
            baseURL: "https://x.example.test",
            username: "u",
            password: "p",
            transport: { mode: "local", rootDir: dir },
          },
        ],
      },
    },
    artifacts: {
      project: "drainprobe",
      defaultRef: { plugin: "develop" },
      version: { kind: "embedded" },
      edition: {
        kind: "editionless",
        identity: {
          slug: "drainprobe",
          mainFile: "drainprobe.php",
          pluginName: "Drain probe",
        },
      },
    },
  };
  const factory = JSON.stringify(
    join(REPO_ROOT, "src/common/config/project.ts"),
  );
  return (
    `import { createProductConfig } from ${factory};\n` +
    `export default createProductConfig(${JSON.stringify(product)});\n`
  );
}

/**
 * Runs `bddgen` and then the runner, as the orchestrator spawns them, in a built environment —
 * nothing inherited from this worker, whose own Playwright variables would confuse a nested run.
 *
 * @param stopFile - the run's stop file; it is not created here.
 */
function runProduct(stopFile: string): RunOutcome {
  const report = join(work, "report.json");
  rmSync(report, { force: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    E2E_LOAD_DOTENV: "false",
    E2E_CELL: "x",
    E2E_RETRIES: "1",
    [STOP_FILE_ENV]: stopFile,
    REPORT_ROOT: join(work, "reports"),
    OUTPUT_ROOT: join(work, "test-results"),
    AUTH_ROOT: join(work, "auth"),
    ARTIFACTS_ROOT: join(work, "artifacts"),
    PLAYWRIGHT_JSON_OUTPUT_NAME: report,
  };
  const node = (cli: string, args: readonly string[]): number | null => {
    const child = spawnSync(
      process.execPath,
      [join(REPO_ROOT, "node_modules", cli), ...args],
      { cwd: work, env, encoding: "utf8", timeout: CHILD_TIMEOUT_MS },
    );
    if (child.error !== undefined) throw child.error;
    if (cli.startsWith("playwright-bdd") && child.status !== 0) {
      throw new Error(
        `bddgen failed (${String(child.status)}):\n${child.stderr}`,
      );
    }
    return child.status;
  };
  node("playwright-bdd/dist/cli/index.js", ["-c", "playwright.config.ts"]);
  const exitCode = node("@playwright/test/cli.js", [
    "test",
    "-c",
    "playwright.config.ts",
    "--reporter=json",
  ]);
  return { exitCode, tests: scenariosIn(readFileSync(report, "utf8")) };
}

/** The scenarios of the JSON report, the setup projects left out. */
function scenariosIn(json: string): ReportedTest[] {
  interface Suite {
    readonly specs?: readonly {
      readonly title: string;
      readonly tests: readonly (Omit<ReportedTest, "title"> & {
        readonly projectName: string;
      })[];
    }[];
    readonly suites?: readonly Suite[];
  }
  const found: ReportedTest[] = [];
  const walk = (suite: Suite): void => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) {
        if (t.projectName === "x") found.push({ ...t, title: spec.title });
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of (JSON.parse(json) as { suites: Suite[] }).suites) {
    walk(suite);
  }
  return found;
}

/** The reported scenario whose title starts with `prefix`. */
function scenario(outcome: RunOutcome, prefix: string): ReportedTest {
  const found = outcome.tests.find((t) => t.title.startsWith(prefix));
  if (found === undefined) {
    throw new Error(
      `no scenario "${prefix}…" in ${JSON.stringify(outcome.tests.map((t) => t.title))}`,
    );
  }
  return found;
}

test.describe("the drain, through the real runner", () => {
  // One run, two minutes at worst: `bddgen`, two worker starts and a retry.
  test.describe.configure({ timeout: 2 * CHILD_TIMEOUT_MS + 30_000 });

  test("finishes the scenario in flight with its retry, then skips the rest untouched", () => {
    const stopFile = join(work, "stop");
    const outcome = runProduct(stopFile);

    // The first scenario created the stop file while it ran, so the gate was open for it…
    expect(existsSync(stopFile)).toBe(true);
    const inFlight = scenario(outcome, "A scenario that fails once");
    // …and its retry still ran, and passed: a retry finishes a scenario that already began.
    expect(inFlight.results.map((r) => r.status)).toEqual(["failed", "passed"]);
    expect(inFlight.status).toBe("flaky");

    // The second began after it. On this placeholder site its login and its install would both
    // fail, so a clean skip proves the gate ran before both, and its teardown left it alone.
    const drained = scenario(outcome, "A plugin scenario that begins after");
    expect(drained.results.map((r) => r.status)).toEqual(["skipped"]);
    expect(drained.results.flatMap((r) => r.errors)).toEqual([]);
    expect(drained.annotations.map((a) => a.type)).toContain(
      STOPPED_ANNOTATION,
    );

    // Nothing that ran failed for good, so the run passes.
    expect(outcome.exitCode).toBe(0);
  });
});
