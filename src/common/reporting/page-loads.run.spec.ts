import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
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

import { PAGE_LOAD_ATTACHMENT } from "./page-loads";

/**
 * The lost-requests report end to end: the shared fixtures' `context` override, through the real
 * `bddgen` and runner — what `page-loads.spec.ts` cannot reach, since unwiring the override leaves
 * every function it calls intact.
 *
 * A synthetic product runs `__fixtures__/page-loads/page-loads.feature` on a placeholder site whose
 * pages `page.route` serves, so nothing leaves the machine. Its config is written to a temporary
 * folder, so the factory's relative paths land there, never in the repository.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, "src/common/__fixtures__/page-loads");

/** How long one child process may take: `bddgen`, or a run of two short scenarios. */
const CHILD_TIMEOUT_MS = 90_000;

/** One attempt of a reported scenario, as far as these cases read it. */
interface ReportedResult {
  readonly status: string;
  readonly attachments: readonly {
    readonly name: string;
    readonly body?: string;
  }[];
  readonly stderr: readonly { readonly text?: string }[];
}

/** A reported scenario. */
interface ReportedTest {
  readonly title: string;
  readonly results: readonly ReportedResult[];
}

let work = "";

test.beforeAll(() => {
  // Its real path: playwright-bdd compares the feature's path to the config's resolved folder, and
  // macOS's temporary folder sits behind a symlink.
  work = realpathSync(mkdtempSync(join(tmpdir(), "e2e-page-loads-")));
  writeFileSync(join(work, "package.json"), '{ "type": "module" }\n');
  symlinkSync(join(REPO_ROOT, "node_modules"), join(work, "node_modules"));
  copyFileSync(
    join(FIXTURE_DIR, "page-loads.feature"),
    join(work, "page-loads.feature"),
  );
  writeFileSync(join(work, "playwright.config.ts"), configSource(work));
});

test.afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** The synthetic product's config: one placeholder cell, `x`, with the shared fixtures. */
function configSource(dir: string): string {
  const product = {
    name: "pageloadsprobe",
    features: join(dir, "page-loads.feature"),
    steps: [
      join(REPO_ROOT, "src/common/fixtures.ts"),
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
      project: "pageloadsprobe",
      defaultRef: { plugin: "develop" },
      version: { kind: "embedded" },
      edition: {
        kind: "editionless",
        identity: {
          slug: "pageloadsprobe",
          mainFile: "p.php",
          pluginName: "Probe",
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

/** Runs `bddgen` and then the runner, in a built environment, and returns the scenarios reported. */
function runProduct(): ReportedTest[] {
  const report = join(work, "report.json");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    E2E_LOAD_DOTENV: "false",
    E2E_CELL: "x",
    E2E_RETRIES: "0",
    REPORT_ROOT: join(work, "reports"),
    OUTPUT_ROOT: join(work, "test-results"),
    AUTH_ROOT: join(work, "auth"),
    ARTIFACTS_ROOT: join(work, "artifacts"),
    PLAYWRIGHT_JSON_OUTPUT_NAME: report,
  };
  for (const [cli, args] of [
    ["playwright-bdd/dist/cli/index.js", ["-c", "playwright.config.ts"]],
    [
      "@playwright/test/cli.js",
      ["test", "-c", "playwright.config.ts", "--reporter=json"],
    ],
  ] as const) {
    const child = spawnSync(
      process.execPath,
      [join(REPO_ROOT, "node_modules", cli), ...args],
      {
        cwd: work,
        env,
        encoding: "utf8",
        timeout: CHILD_TIMEOUT_MS,
      },
    );
    if (child.error !== undefined) throw child.error;
  }
  return scenariosIn(readFileSync(report, "utf8"));
}

/** The scenarios of the JSON report, the setup projects left out. */
function scenariosIn(json: string): ReportedTest[] {
  interface Suite {
    readonly specs?: readonly {
      readonly title: string;
      readonly tests: readonly {
        readonly projectName: string;
        readonly results: ReportedResult[];
      }[];
    }[];
    readonly suites?: readonly Suite[];
  }
  const found: ReportedTest[] = [];
  const walk = (suite: Suite): void => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) {
        if (t.projectName === "x")
          found.push({ title: spec.title, results: t.results });
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of (JSON.parse(json) as { suites: Suite[] }).suites)
    walk(suite);
  return found;
}

/** The only attempt of the reported scenario whose title starts with `prefix`. */
function attempt(
  tests: readonly ReportedTest[],
  prefix: string,
): ReportedResult {
  const found = tests.find((t) => t.title.startsWith(prefix))?.results[0];
  if (found === undefined) {
    throw new Error(
      `no attempt of "${prefix}…" in ${JSON.stringify(tests.map((t) => t.title))}`,
    );
  }
  return found;
}

test.describe("the site's lost requests, through the real runner", () => {
  test.describe.configure({ timeout: 2 * CHILD_TIMEOUT_MS + 30_000 });

  test("a failed scenario says how many of its own requests failed and lists them; a passing one says nothing", () => {
    const tests = runProduct();

    const failed = attempt(tests, "A page that lost its own script fails");
    expect(failed.status).toBe("failed");
    const report = failed.attachments.find(
      (a) => a.name === PAGE_LOAD_ATTACHMENT,
    );
    const body = Buffer.from(report?.body ?? "", "base64").toString("utf8");
    expect(body).toBe(
      "1 of the site's own requests failed while this scenario ran.\n" +
        "Shown as paths: queries cut to page/step/tab/action, hex runs of 16+ masked.\n" +
        "\n" +
        "/wp-admin/admin.php?page=demo&…\n" +
        "  GET script /wp-content/plugins/demo/admin.js?… — net::ERR_CONNECTION_CLOSED\n",
    );
    expect(failed.stderr.map((s) => s.text ?? "").join("")).toContain(
      `[page-loads] "A page that lost its own script fails, and the report lists the script": ` +
        "1 of the site's own requests failed (1 net::ERR_CONNECTION_CLOSED).",
    );

    const passed = attempt(
      tests,
      "A passing scenario whose page lost a script",
    );
    expect(passed.status).toBe("passed");
    expect(passed.attachments.map((a) => a.name)).not.toContain(
      PAGE_LOAD_ATTACHMENT,
    );
    expect(passed.stderr.map((s) => s.text ?? "").join("")).not.toContain(
      "[page-loads]",
    );
  });
});
