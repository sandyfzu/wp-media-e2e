import { isNonEmptyString, isObject } from "../guards";
import type { Edition, SiteConfig } from "./types";

/**
 * Owns the project-metadata contract and the per-process site-pool registry.
 *
 * Playwright serializes a project's `metadata` verbatim into its reports, so it must
 * never carry secrets. We put only non-secret routing (`product`, `cell`) in metadata
 * and hand the credential-bearing pool to workers through this in-memory registry
 * instead. The registry is populated as a side effect of building the config
 * (`createProductConfig`), which Playwright re-executes in every worker process, so
 * each worker resolves its pool locally from sites.json — never from a report-bound
 * channel.
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
