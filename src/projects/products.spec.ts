import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { isObject } from "../common/guards";
import {
  PRODUCTS,
  playwrightConfigFor,
  productByName,
  productFromEnv,
} from "./products";

/**
 * The product list against the repository it describes — so a product folder, entry config or
 * npm script nobody listed fails here, instead of being skipped by the healthcheck and the
 * artifact warm — and the guarantee that importing the list leaves a process's environment alone,
 * which the orchestrator will rely on.
 */

const execFileAsync = promisify(execFile);

/** The repository root, two levels above this file. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The unit config, the only root entry config that is not a product's. */
const UNIT_ENTRY = "unit";

/** tsx's loader, so a child Node imports the suite's TypeScript as the runners do. */
const TSX_LOADER = import.meta.resolve("tsx");

/** A working directory whose `.env` sets a sentinel, so a child that loads `.env` shows it. */
let probeDir = "";

test.beforeAll(() => {
  probeDir = mkdtempSync(join(tmpdir(), "e2e-products-"));
  writeFileSync(join(probeDir, ".env"), "E2E_PROBE_SENTINEL=from-dotenv\n");
});

test.afterAll(() => {
  rmSync(probeDir, { recursive: true, force: true });
});

/**
 * How long a child may run. One takes under 2 s here; this leaves room for a slow CI runner and
 * stays under the 30 s test timeout, so a hung child fails its test with {@link runInChild}'s
 * message rather than the runner's.
 */
const CHILD_TIMEOUT_MS = 15_000;

/** Why a child failed: killed at the time limit, its exit code, or why it never started. */
function describeChildFailure(error: unknown): string {
  if (!isObject(error)) return String(error);
  const stderr = typeof error.stderr === "string" ? error.stderr : "";
  const how =
    error.killed === true
      ? `killed after ${String(CHILD_TIMEOUT_MS)} ms`
      : typeof error.code === "number"
        ? `exit ${String(error.code)}`
        : String(error.code ?? error.message);
  return `${how}: ${stderr}`;
}

/**
 * Runs `body` — ES module code — in a fresh Node from {@link probeDir}, with only `PATH` and
 * `HOME`, and returns the JSON printed on its last stdout line. A child, because what is measured
 * is what importing a module does to a process, and this worker has imported plenty already.
 * Asynchronous, so the test's own timeout can still interrupt it.
 */
async function runInChild(body: string): Promise<unknown> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      process.execPath,
      ["--import", TSX_LOADER, "--input-type=module", "--eval", body],
      {
        cwd: probeDir,
        encoding: "utf8",
        timeout: CHILD_TIMEOUT_MS,
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      },
    ));
  } catch (error) {
    // The argv is our own probe code and the env holds only PATH and HOME: nothing to hide.
    throw new Error(`child Node failed (${describeChildFailure(error)})`, {
      cause: error,
    });
  }
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
}

/** The `file:` URL of a repository file, as a JS string literal for a child's code. */
function moduleUrl(repoPath: string): string {
  return JSON.stringify(pathToFileURL(join(REPO_ROOT, repoPath)).href);
}

/** The environment variables importing `repoPath` adds, removes or changes, sorted. */
function envChangedByImport(repoPath: string): Promise<unknown> {
  return runInChild(`
    const before = { ...process.env };
    await import(${moduleUrl(repoPath)});
    const keys = new Set([...Object.keys(before), ...Object.keys(process.env)]);
    console.log(JSON.stringify([...keys].filter((k) => before[k] !== process.env[k]).sort()));
  `);
}

/** The product names on the projects that a Playwright entry config builds. */
function productsBuiltBy(entryConfig: string): Promise<unknown> {
  return runInChild(`
    const config = (await import(${moduleUrl(entryConfig)})).default;
    console.log(JSON.stringify([...new Set(config.projects.map((p) => p.metadata?.product))]));
  `);
}

/** The `<name>` of every `playwright.<name>.config.ts` an npm script mentions. */
function entryConfigNames(script: string): string[] {
  return [...script.matchAll(/playwright\.([\w@-]+)\.config\.ts/g)].map(
    (match) => match[1] ?? "",
  );
}

const names = PRODUCTS.map((product) => product.name);

test.describe("PRODUCTS — against the repository", () => {
  test("names every folder of src/projects/ exactly once, by the folder's name", () => {
    const folders = readdirSync(join(REPO_ROOT, "src", "projects"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(new Set(names).size, "a product is listed twice").toBe(names.length);
    expect(
      [...names].sort(),
      "src/projects/ and PRODUCTS (src/projects/products.ts) must name the same products",
    ).toEqual(folders);
  });

  test("keeps every product's features and own steps inside its own folder", () => {
    for (const product of PRODUCTS) {
      const own = `src/projects/${product.name}/`;
      const features = [product.features].flat();
      const productSteps = product.steps.filter((glob) =>
        glob.startsWith("src/projects/"),
      );
      expect(features.length, product.name).toBeGreaterThan(0);
      for (const glob of [...features, ...productSteps]) {
        expect(glob.startsWith(own), `${product.name}: ${glob}`).toBe(true);
      }
    }
  });

  test("gives every product an entry config at the repository root that builds that product", async () => {
    const pairs = PRODUCTS.map((product) => ({
      name: product.name,
      entry: playwrightConfigFor(product),
    }));
    for (const { entry } of pairs) {
      expect(existsSync(join(REPO_ROOT, entry)), `${entry} exists`).toBe(true);
    }
    const built = await Promise.all(
      pairs.map(({ entry }) => productsBuiltBy(entry)),
    );
    pairs.forEach(({ name, entry }, index) => {
      expect(built[index], `${entry} builds only its product`).toEqual([name]);
    });
  });

  test("has no root entry config but the products' and the unit config", () => {
    const found = readdirSync(REPO_ROOT)
      .flatMap((file) => /^playwright\.(.+)\.config\.ts$/.exec(file)?.[1] ?? [])
      .sort();
    expect(
      found,
      "each root playwright.<name>.config.ts must be a listed product's, or the unit config",
    ).toEqual([...names, UNIT_ENTRY].sort());
  });

  test("gives every product a test:<name> script that generates and runs its entry config", () => {
    const { scripts } = JSON.parse(
      readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    for (const product of PRODUCTS) {
      const entry = playwrightConfigFor(product);
      const script = scripts[`test:${product.name}`] ?? "";
      expect(script, `test:${product.name}`).toContain(
        `bddgen --config ${entry}`,
      );
      expect(script, `test:${product.name}`).toContain(
        `playwright test --config ${entry}`,
      );
    }
    for (const [name, script] of Object.entries(scripts)) {
      for (const entry of entryConfigNames(script)) {
        expect([...names, UNIT_ENTRY], `script "${name}"`).toContain(entry);
      }
    }
  });
});

test.describe("productByName", () => {
  test("returns each listed product by its name", () => {
    for (const product of PRODUCTS) {
      expect(productByName(product.name)).toBe(product);
    }
  });

  test("refuses a name no product has, naming it and the known products", () => {
    expect(() => productByName("backwpu")).toThrow(
      'Unknown product "backwpu". Known products: wp-rocket, backwpup.',
    );
  });

  test("matches exactly — no trimming, no case folding", () => {
    expect(() => productByName(" backwpup")).toThrow('" backwpup"');
    expect(() => productByName("BackWPup")).toThrow('"BackWPup"');
  });
});

test.describe("productFromEnv — the bare config's PRODUCT", () => {
  test("runs WP Rocket when PRODUCT is unset or blank", () => {
    for (const value of [undefined, "", "  \t"]) {
      expect(productFromEnv(value).name, JSON.stringify(value)).toBe(
        "wp-rocket",
      );
    }
  });

  test("runs the named product, ignoring surrounding whitespace", () => {
    expect(productFromEnv("backwpup").name).toBe("backwpup");
    expect(productFromEnv(" backwpup\n").name).toBe("backwpup");
    expect(productFromEnv("wp-rocket").name).toBe("wp-rocket");
  });

  test("fails on a misspelt product instead of running WP Rocket", () => {
    expect(() => productFromEnv("backwpu")).toThrow(
      'PRODUCT="backwpu" names no product. Known products: wp-rocket, backwpup; ' +
        "leave it unset for wp-rocket.",
    );
  });
});

test.describe("Importing the product list", () => {
  test("leaves the process environment untouched: no .env loaded, no RUN_ID stamped", async () => {
    expect(await envChangedByImport("src/projects/products.ts")).toEqual([]);
  });

  test("is measured by a probe that sees run-context load .env and stamp RUN_ID", async () => {
    expect(
      await envChangedByImport("src/common/config/run-context.ts"),
    ).toEqual(expect.arrayContaining(["E2E_PROBE_SENTINEL", "RUN_ID"]));
  });
});
