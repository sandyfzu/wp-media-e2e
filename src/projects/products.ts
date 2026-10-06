import type { ProductConfig } from "../common/config/types";
import { isNonEmptyString } from "../common/guards";
import { backwpup } from "./backwpup/config/backwpup.config";
import { wpRocket } from "./wp-rocket/config/wp-rocket.config";

/**
 * Every product the suite tests — the one list that the entry points spanning products read
 * (`playwright.config.ts`, the healthcheck, the artifact warm, and later the orchestrator), so a
 * product is added in one place. `products.spec.ts` checks it against the repository.
 *
 * Importing it loads every product's sites files and reads BackWPup's `BWP_*` storage
 * variables, but never loads `.env` or stamps `RUN_ID`: a long-lived process can import it
 * without changing its own environment. A product's own entry config imports only its
 * product, so a run never depends on another product's sites.
 */
export const PRODUCTS: readonly ProductConfig[] = [wpRocket, backwpup];

/** What the bare `playwright.config.ts` runs when `PRODUCT` is unset or blank. */
const DEFAULT_PRODUCT = "wp-rocket";

/** The listed product of that exact name, if any. */
function findProduct(name: string): ProductConfig | undefined {
  return PRODUCTS.find((product) => product.name === name);
}

/** The listed names, for an error message. */
function knownNames(): string {
  return PRODUCTS.map((product) => product.name).join(", ");
}

/**
 * The product named `name` — exactly, as a caller that has already validated its input
 * passes it.
 *
 * @throws {@link Error} naming `name` and the known products when none matches.
 */
export function productByName(name: string): ProductConfig {
  const product = findProduct(name);
  if (product === undefined) {
    throw new Error(
      `Unknown product "${name}". Known products: ${knownNames()}.`,
    );
  }
  return product;
}

/**
 * The product the bare `playwright.config.ts` runs, from the raw `PRODUCT` value: unset or
 * blank means {@link DEFAULT_PRODUCT}, surrounding whitespace is ignored, and anything else
 * must name a listed product — a typo used to run WP Rocket silently.
 *
 * @param value - `process.env.PRODUCT`, as read.
 * @throws {@link Error} naming the value and the known products when it names none.
 */
export function productFromEnv(value: string | undefined): ProductConfig {
  if (!isNonEmptyString(value)) return productByName(DEFAULT_PRODUCT);
  const product = findProduct(value.trim());
  if (product === undefined) {
    throw new Error(
      `PRODUCT="${value}" names no product. Known products: ${knownNames()}; ` +
        `leave it unset for ${DEFAULT_PRODUCT}.`,
    );
  }
  return product;
}

/**
 * The Playwright entry config that runs `product`, relative to the repository root. A run
 * starts there too. Playwright resolves the config's own paths against the config's folder,
 * but `.env` is read from the working directory and Allure writes its results under it.
 *
 * @example
 * ```ts
 * playwrightConfigFor(productByName("backwpup")); // "playwright.backwpup.config.ts"
 * ```
 */
export function playwrightConfigFor(product: ProductConfig): string {
  return `playwright.${product.name}.config.ts`;
}
