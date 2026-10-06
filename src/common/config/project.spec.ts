import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { importable, runInChildNode } from "../__fixtures__/child-node";

/**
 * Where a built config sends each project's output, its reports and its logins, per `--project`
 * selection. Playwright empties the output folder of every project a run selects, so only a run
 * targeting a cell may own that cell's folder. Building a config reads `process.argv` and writes
 * the environment, so each selection is built in a fresh Node, as Playwright builds it: from a
 * temporary working directory, to prove nothing lands relative to it.
 */

/** The repository root, three levels above this file. */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** A synthetic two-cell product: the factory needs no product code, only this shape. */
const PRODUCT = {
  name: "demo",
  features: "src/projects/demo/features/**/*.feature",
  steps: ["src/common/fixtures.ts"],
  sites: {
    a: {
      sites: [
        {
          baseURL: "https://a.example.test",
          username: "u",
          password: "p",
          transport: { mode: "local", rootDir: "/tmp" },
        },
      ],
    },
    b: { sites: [] },
  },
  artifacts: {
    project: "demo",
    defaultRef: { plugin: "develop" },
    version: { kind: "embedded" },
    edition: {
      kind: "editionless",
      identity: { slug: "demo", mainFile: "demo.php", pluginName: "Demo" },
    },
  },
};

/** What one built config says about where things go. */
interface Built {
  /** Project name → its `outputDir`. */
  readonly outputDirs: Record<string, string>;
  /** Every path a reporter writes to. */
  readonly reportPaths: string[];
  /** The first site of cell `a`'s `storageState` path. */
  readonly storageState: string;
}

/** A working directory that is not the repository's. */
let elsewhere = "";

test.beforeAll(() => {
  elsewhere = mkdtempSync(join(tmpdir(), "e2e-project-"));
});

test.afterAll(() => {
  rmSync(elsewhere, { recursive: true, force: true });
});

/** Builds the config with `args` on the command line and `env` added, in a fresh Node. */
async function build(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<Built> {
  const file = (path: string): string => importable(join(REPO_ROOT, path));
  return (await runInChildNode(
    `
    process.argv.push(...${JSON.stringify(args)});
    const { createProductConfig } = await import(${file("src/common/config/project.ts")});
    const { getPool } = await import(${file("src/common/config/metadata.ts")});
    const config = createProductConfig(${JSON.stringify(PRODUCT)});
    console.log(JSON.stringify({
      outputDirs: Object.fromEntries(config.projects.map((p) => [p.name, p.outputDir])),
      reportPaths: config.reporter.flatMap(([, options]) =>
        [options?.outputFolder, options?.outputFile, options?.resultsDir].filter(Boolean)),
      storageState: getPool("demo", "a")[0].storageState,
    }));
    `,
    { cwd: elsewhere, env: { RUN_ID: "run-1", ...env } },
  )) as Built;
}

/** Each of cell `cell`'s three projects, mapped to `dir`. */
function cellProjects(cell: string, dir: string): Record<string, string> {
  return { [`setup:${cell}`]: dir, [`artifacts:${cell}`]: dir, [cell]: dir };
}

const OWN_A = "test-results/demo/a";
const ALL_A = "test-results/demo/_all/a";
const ALL_B = "test-results/demo/_all/b";

test.describe("createProductConfig — output folders by selection", () => {
  test("a run targeting a cell gives all three of its projects the cell's folder", async () => {
    expect((await build(["--project=a"])).outputDirs).toEqual({
      ...cellProjects("a", OWN_A),
      ...cellProjects("b", ALL_B),
    });
  });

  test("every run targeting no single cell writes under _all", async () => {
    const selections = [
      [], // no --project
      ["--project=setup:a"], // a setup project alone
      ["--project=artifacts:a"],
      ["--project=*"], // a wildcard
      ["--project=A"], // Playwright ignores case; the run is not treated as targeting `a`
    ];
    const built = await Promise.all(selections.map((args) => build(args)));
    built.forEach(({ outputDirs }, index) => {
      expect(outputDirs, JSON.stringify(selections[index])).toEqual({
        ...cellProjects("a", ALL_A),
        ...cellProjects("b", ALL_B),
      });
    });
  });

  test("OUTPUT_ROOT replaces only the root", async () => {
    const { outputDirs } = await build(["--project=a"], {
      OUTPUT_ROOT: "/srv/e2e-output",
    });
    expect(outputDirs.a).toBe("/srv/e2e-output/demo/a");
    expect(outputDirs.b).toBe("/srv/e2e-output/demo/_all/b");
  });
});

test.describe("createProductConfig — paths that never follow the working directory", () => {
  test("every report lands in the run's folder in the repository", async () => {
    const [targeted, untargeted] = await Promise.all([
      build(["--project=a"]),
      build([]),
    ]);
    const run = (cell: string): string =>
      resolve(REPO_ROOT, "reports/demo", cell, "run-1");
    expect(targeted.reportPaths).toEqual([
      `${run("a")}/playwright`,
      `${run("a")}/cucumber/index.html`,
      `${run("a")}/allure-results`,
    ]);
    expect(
      untargeted.reportPaths.every((path) => path.startsWith(run("_all"))),
    ).toBe(true);
  });

  test("a site's login is saved in the repository's .auth", async () => {
    expect((await build(["--project=a"])).storageState).toBe(
      resolve(REPO_ROOT, ".auth/demo/a/site-0.json"),
    );
  });
});
