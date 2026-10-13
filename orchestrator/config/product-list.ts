import type {
  PRODUCTS,
  playwrightConfigFor,
  productByName,
} from "../../src/projects/products";
import { ConfigError } from "./errors";

/**
 * The suite's product list, as the orchestrator uses it. Importing `src/projects/products.ts` loads
 * every product's sites files: it prints a `[sites]` warning for a product with none and **throws**
 * on one it cannot read or validate. Imported statically, a broken WP Rocket sites file would end the
 * orchestrator with a stack trace before its own error handling exists, even when it runs only
 * BackWPup cells. So it is imported here, once, when the command asks for it, and a failure becomes a
 * {@link ConfigError}. Only a type is imported statically, and types are erased.
 */

/**
 * What the orchestrator takes from the product list — never `productFromEnv`, which reads the
 * environment.
 */
export interface ProductList {
  /** Every product the suite tests. */
  readonly PRODUCTS: typeof PRODUCTS;
  /** The product of that exact name; throws naming the known ones when none matches. */
  readonly productByName: typeof productByName;
  /** The Playwright entry config that runs a product, relative to the repository. */
  readonly playwrightConfigFor: typeof playwrightConfigFor;
}

/** Imports the product list: the module itself, or a stand-in in a spec. */
export type ProductListImporter = () => Promise<ProductList>;

/** The real importer. A literal path, so both import guards can judge it. */
const importSuiteProductList: ProductListImporter = () =>
  import("../../src/projects/products");

/**
 * Loads the product list, turning any failure into a {@link ConfigError} that names it — the sites
 * loader's own words name the file (`[sites] "…/sites.json" is not valid JSON.`). Only that message
 * is kept: its cause would quote the file (see {@link ConfigError}). Call it once, at start, inside
 * the command's error handling. Node keeps a module as its first import left it: the sites files are
 * read once per process, and a failure is final — a second call fails the same way even once the
 * file is fixed, so the fix is a restart.
 *
 * @param importList - imports the list; the suite's module by default.
 * @returns the list's three members, and nothing else the module exports.
 * @throws {@link ConfigError} when the import fails.
 *
 * @example
 * ```ts
 * const { productByName, playwrightConfigFor } = await loadProductList();
 * playwrightConfigFor(productByName("backwpup")); // "playwright.backwpup.config.ts"
 * ```
 */
export async function loadProductList(
  importList: ProductListImporter = importSuiteProductList,
): Promise<ProductList> {
  let list: ProductList;
  try {
    list = await importList();
  } catch (error) {
    throw new ConfigError(
      `The product list could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const { PRODUCTS, productByName, playwrightConfigFor } = list;
  return Object.freeze({ PRODUCTS, productByName, playwrightConfigFor });
}
