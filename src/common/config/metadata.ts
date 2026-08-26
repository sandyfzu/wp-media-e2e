import { isNonEmptyString, isObject } from "../guards";
import type { ScanDebugLogOptions } from "../wp/log";
import type { Edition, SiteConfig } from "./types";

/**
 * Owns the project-metadata contract and the per-process registries that back it.
 *
 * Playwright serializes a project's `metadata` verbatim into its reports, so it must
 * never carry secrets — and it can only carry JSON. We put only non-secret routing
 * (`product`, `cell`, `edition`) in metadata and hand everything else to workers through
 * in-memory registries: the credential-bearing site pool (secrets), the product's debug-log
 * preset (RegExps, which JSON cannot express) and its residue paths. That last one *would* fit in
 * metadata, and still does not go there — the registry is also how **product policy reaches the
 * shared hooks without those hooks importing product code**, and one channel for that is easier to
 * follow than two. All are populated as a side effect of building the config
 * (`createProductConfig`), which Playwright re-executes in every worker process, so each worker
 * resolves them locally — never from a report-bound channel.
 */

/** Non-secret routing carried in a project's `metadata`. */
export interface ProjectRouting {
  readonly product: string;
  readonly cell: string;
  /** The cell's edition, for edition-ful products; absent for editionless ones. */
  readonly edition?: Edition;
}

/** Builds the non-secret `metadata` object for a (product, cell[, edition]) project. */
export function routingMetadata(
  product: string,
  cell: string,
  edition?: Edition,
): ProjectRouting {
  return edition === undefined ? { product, cell } : { product, cell, edition };
}

/** Validates an optional `edition` value, returning it narrowed; throws on an unknown value. */
function parseEdition(value: unknown): Edition | undefined {
  if (value === undefined || value === "free" || value === "pro") return value;
  throw new Error(
    '[metadata] project metadata `edition` must be "free" | "pro" when present.',
  );
}

/** Reads and validates the routing carried in a Playwright project's `metadata`. */
export function readRouting(metadata: unknown): ProjectRouting {
  if (!isObject(metadata)) {
    throw new Error(
      "[metadata] project metadata is missing or not an object; expected { product, cell }.",
    );
  }
  if (!isNonEmptyString(metadata.product) || !isNonEmptyString(metadata.cell)) {
    throw new Error(
      "[metadata] project metadata must carry non-empty string `product` and `cell`.",
    );
  }
  const edition = parseEdition(metadata.edition);
  return edition === undefined
    ? { product: metadata.product, cell: metadata.cell }
    : { product: metadata.product, cell: metadata.cell, edition };
}

// Per-process registry: (product, cell) -> resolved site pool (with credentials).
const pools = new Map<string, readonly SiteConfig[]>();

/** Composite key for the pool registry. */
function poolKey(product: string, cell: string): string {
  return `${product}::${cell}`;
}

/** Registers a cell's resolved pool. Called while building the config, in each process. */
export function registerPool(
  product: string,
  cell: string,
  sites: readonly SiteConfig[],
): void {
  pools.set(poolKey(product, cell), sites);
}

/**
 * Returns the resolved pool for a (product, cell). Throws if it was never registered,
 * which means the config was not built in this process — a programming error, not bad input.
 */
export function getPool(product: string, cell: string): readonly SiteConfig[] {
  const pool = pools.get(poolKey(product, cell));
  if (pool === undefined) {
    throw new Error(
      `[metadata] no site pool registered for "${product}/${cell}". ` +
        "The Playwright config must be built in this process before the pool is read.",
    );
  }
  return pool;
}

// Per-process registry: product -> its debug-log scan preset (RegExp-bearing, so not JSON).
const debugLogOptions = new Map<string, ScanDebugLogOptions>();

/**
 * Registers a product's debug-log scan preset (its verified-benign `ignore` patterns and any
 * `source` restriction). Called while building the config, in each process. A product that
 * declares none is simply not registered — see {@link getDebugLogOptions} for what that means.
 */
export function registerDebugLogOptions(
  product: string,
  options: ScanDebugLogOptions | undefined,
): void {
  if (options === undefined) return;
  debugLogOptions.set(product, options);
}

/**
 * The debug-log preset for a product, or `{}` when it declares none.
 *
 * Unlike {@link getPool} this never throws: `{}` means "categorise every line, ignore nothing",
 * which is the **strictest** reading of the log. A product that forgot to declare a preset
 * therefore gets a gate that is too strict rather than one that silently passes.
 */
export function getDebugLogOptions(product: string): ScanDebugLogOptions {
  return debugLogOptions.get(product) ?? {};
}

// Per-process registry: product -> the paths it leaves on the site after being uninstalled.
const siteResidue = new Map<string, readonly string[]>();

/**
 * Registers the paths a product leaves on the site's filesystem, for the shared teardown to clear.
 * Called while building the config, in each process. A product that declares none is not
 * registered.
 */
export function registerSiteResidue(
  product: string,
  paths: readonly string[] | undefined,
): void {
  if (paths === undefined) return;
  siteResidue.set(product, paths);
}

/**
 * The residue paths for a product, or an empty list when it declares none.
 *
 * Never throws: unlike a missing site pool, "this product leaves nothing behind" is a legitimate
 * state — WP Rocket declares none today — and the teardown then does nothing at all.
 */
export function getSiteResidue(product: string): readonly string[] {
  return siteResidue.get(product) ?? [];
}
