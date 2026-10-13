import { test, expect } from "@playwright/test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { importable, runInChildNode } from "../common/__fixtures__/child-node";
import { probeImports, SETTLED } from "../common/__fixtures__/import-probe";
import {
  PRODUCTS,
  playwrightConfigFor,
  productByName,
  productFromEnv,
} from "./products";

/**
 * The product list against the repository it describes — so a product folder, entry config or
 * npm script nobody listed fails here, instead of being skipped by the healthcheck and the
 * artifact warm — and the guarantee that importing the list leaves the process as it was, which the
 * orchestrator relies on.
 */

/** The repository root, two levels above this file. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The unit config, the only root entry config that is not a product's. */
const UNIT_ENTRY = "unit";

/** A working directory of its own, so a child never reads the repository's `.env`. */
let probeDir = "";

test.beforeAll(() => {
  probeDir = mkdtempSync(join(tmpdir(), "e2e-products-"));
});

test.afterAll(() => {
  rmSync(probeDir, { recursive: true, force: true });
});

/** Runs `body` in a fresh Node from {@link probeDir}: see {@link runInChildNode}. */
function runInChild(body: string): Promise<unknown> {
  return runInChildNode(body, { cwd: probeDir });
}

/** The product names on the projects that a Playwright entry config builds. */
function productsBuiltBy(entryConfig: string): Promise<unknown> {
  return runInChild(`
    const config = (await import(${importable(join(REPO_ROOT, entryConfig))})).default;
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

  test("names every product as a lowercase path segment, never _-prefixed like _unit", () => {
    // A product names folders beside the unit tests' `<OUTPUT_ROOT>/_unit`, and npm scripts.
    for (const name of names) expect(name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
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
  test("leaves the process as it was: no .env loaded, no RUN_ID stamped, no listener added", async () => {
    const file = join(REPO_ROOT, "src/projects/products.ts");
    expect(await probeImports([file])).toEqual([
      { file, effects: [] },
      { file: SETTLED, effects: [] },
    ]);
  });
});
