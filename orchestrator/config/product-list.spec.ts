import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

import {
  importable,
  runInChildNode,
} from "../../src/common/__fixtures__/child-node";
import { loadSites } from "../../src/common/config/sites";
import * as suiteProductList from "../../src/projects/products";
import { ConfigError } from "./errors";
import { loadProductList, type ProductList } from "./product-list";

/** A stand-in list: what an importer returns, checked member by member. */
const STAND_IN: ProductList = {
  PRODUCTS: [],
  productByName: () => {
    throw new Error("not in this list");
  },
  playwrightConfigFor: () => "playwright.stand-in.config.ts",
};

/** What `loadProductList` throws when importing fails, asynchronously as `import()` does, with `thrown`. */
async function failureOf(thrown: unknown): Promise<unknown> {
  const importList = (): Promise<ProductList> =>
    Promise.resolve().then(() => {
      throw thrown;
    });
  return loadProductList(importList).then(
    () => "resolved",
    (error: unknown) => error,
  );
}

/** What `run` throws; fails the test when it throws nothing. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (thrown) {
    return thrown;
  }
  throw new Error("expected a throw");
}

test.describe("loadProductList", () => {
  test("returns the importer's three members as they are", async () => {
    const list = await loadProductList(() => Promise.resolve(STAND_IN));
    expect(list.PRODUCTS).toBe(STAND_IN.PRODUCTS);
    expect(list.productByName).toBe(STAND_IN.productByName);
    expect(list.playwrightConfigFor).toBe(STAND_IN.playwrightConfigFor);
  });

  test("returns nothing else the module exports, and a list that cannot be changed", async () => {
    const list = await loadProductList(() =>
      Promise.resolve({ ...STAND_IN, productFromEnv: () => undefined }),
    );
    expect(Object.keys(list).sort()).toEqual([
      "PRODUCTS",
      "playwrightConfigFor",
      "productByName",
    ]);
    expect(Object.isFrozen(list)).toBe(true);
  });

  test("turns a failed import into a ConfigError that keeps its words and nothing else", async () => {
    const cause = new Error("the cause's own cause", { cause: "deeper" });
    const error = await failureOf(
      new Error('[sites] "/x/sites.json" is not valid JSON.', { cause }),
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toMatchObject({
      name: "ConfigError",
      message:
        'The product list could not be loaded: [sites] "/x/sites.json" is not valid JSON.',
    });
    expect((error as ConfigError).cause).toBeUndefined();
  });

  test("names a thrown value that is not an Error", async () => {
    expect(await failureOf("no list")).toMatchObject({
      message: "The product list could not be loaded: no list",
    });
  });

  test.describe("against the sites loader", () => {
    /** A product config folder holding a sites file that is not valid JSON. */
    let dir = "";

    test.beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "e2e-product-list-"));
      writeFileSync(
        join(dir, "sites.json"),
        '{ "apache": [{ "password": s3cret-in-the-file } ] }',
      );
    });

    test.afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    test("names the broken sites file and never quotes it, as the loader's own error does", async () => {
      const raw = thrownBy(() => loadSites(dir));
      // The premise: the loader's cause, JSON.parse's error, quotes the file.
      expect(inspect(raw)).toContain("s3cret");
      const error = await failureOf(raw);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toBe(
        `The product list could not be loaded: [sites] "${join(dir, "sites.json")}" is not valid JSON.`,
      );
      expect(inspect(error)).not.toContain("s3cret");
    });
  });

  test("loads nothing of the suite as it is imported: a list that cannot load fails the call alone", async () => {
    // An invalid BWP_FTP_PORT makes the product list throw as it loads, so a static import of it
    // would fail the import.
    const productList = importable(
      fileURLToPath(new URL("product-list.ts", import.meta.url)),
    );
    const outcome = await runInChildNode(
      `const { loadProductList } = await import(${productList});
      const called = await loadProductList().then(
        () => "loaded",
        (error) => error.name + ": " + error.message,
      );
      console.log(JSON.stringify({ imported: true, called }));`,
      { cwd: tmpdir(), env: { BWP_FTP_PORT: "not-a-port" } },
    );
    expect(outcome).toEqual({
      imported: true,
      called:
        'ConfigError: The product list could not be loaded: Environment variable "BWP_FTP_PORT" must be an integer in [1, 65535], got "not-a-port".',
    });
  });

  test("loads the suite's own list by default", async () => {
    const list = await loadProductList();
    expect(list.PRODUCTS).toBe(suiteProductList.PRODUCTS);
    expect(list.playwrightConfigFor(list.productByName("backwpup"))).toBe(
      "playwright.backwpup.config.ts",
    );
  });
});
