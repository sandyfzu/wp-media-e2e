import { defineConfig, devices } from "@playwright/test";
import type { PlaywrightTestConfig, Project } from "@playwright/test";
import { defineBddConfig } from "playwright-bdd";

import { registerPool, routingMetadata } from "./metadata";
import { reporters } from "./reporting";
import { dirs, selectedCells } from "./run-context";
import type { Edition, ProductConfig, SiteConfig, SitePool } from "./types";

/** Per-product Playwright config factory: expands a {@link ProductConfig} into a runnable Playwright config. */

// True when running under CI (the `CI` env var is present and non-empty).
const isCI = process.env.CI !== undefined && process.env.CI !== "";

/**
 * Default desktop viewport for every project (the suite's baseline desktop size). Mobile
 * emulation is applied per-scenario via the `@mobile` tag — a later phase (plan §7.7).
 */
const DESKTOP_VIEWPORT = { width: 1600, height: 700 };

/** The desktop device profile every project runs under: Desktop Chrome at {@link DESKTOP_VIEWPORT}. */
const DESKTOP = { ...devices["Desktop Chrome"], viewport: DESKTOP_VIEWPORT };

/** Assigns each pooled site its per-run `storageState` path under the cell's auth dir. */
function withState(pool: SitePool, authDir: string): SiteConfig[] {
  return pool.map((site, index) => ({
    ...site,
    storageState: `${authDir}/site-${String(index)}.json`,
  }));
}

/**
 * The Cucumber tag expression that scopes a cell to its edition: a Pro cell excludes
 * `@free`, a Free cell excludes `@pro`. Editionless cells get no filter (run everything).
 */
function editionFilter(edition: Edition | undefined): string | undefined {
  if (edition === "pro") return "not @free";
  if (edition === "free") return "not @pro";
  return undefined;
}

/**
 * Builds the config for one product. Each `cell` becomes a pair of projects: a setup
 * project that authenticates the cell's site pool, and the BDD project that depends on
 * it. A run targets exactly one cell via `--project=<cell>` (plan §3.2), which keeps
 * the global `parallelIndex` in range for the worker→site binding; selecting more than
 * one cell at once is rejected fail-fast below.
 */
export function createProductConfig(
  product: ProductConfig,
): PlaywrightTestConfig {
  const cells = Object.keys(product.sites);

  // Resolve the targeted cell. Selecting multiple cells in one invocation is unsafe
  // (parallelIndex is global), so fail fast instead of silently mis-sizing workers.
  const requested = selectedCells().filter((c) => cells.includes(c));
  if (requested.length > 1) {
    throw new Error(
      `Multiple cells selected (${requested.join(", ")}). Run one cell per ` +
        "invocation, e.g. --project=<cell>, so parallelIndex stays in range (plan §3.2).",
    );
  }
  const selected = requested[0];
  const selectedCellConfig =
    selected === undefined ? undefined : product.sites[selected];
  // A cell-less run (no / `*` / unknown --project) is serial and safe; its report goes
  // to an `_all` bucket so it is never mislabeled as belonging to a single cell.
  const reportCell = selected ?? "_all";

  const projects: Project[] = cells.flatMap((cell): Project[] => {
    const cellConfig = product.sites[cell];
    const pool = cellConfig?.sites ?? [];
    const edition = cellConfig?.edition;
    const cellDirs = dirs(product.name, cell);
    const pooled = withState(pool, cellDirs.auth);
    // Hand the credential-bearing pool to workers in-process; never via metadata,
    // which Playwright serializes into reports (see config/metadata.ts).
    registerPool(product.name, cell, pooled);
    const setupName = `setup:${cell}`;
    const firstSite = pooled[0];
    const tags = editionFilter(edition);

    return [
      {
        name: setupName,
        testDir: "src/common/auth",
        testMatch: /auth\.setup\.ts$/,
        use: { ...DESKTOP },
        metadata: routingMetadata(product.name, cell, edition),
      },
      {
        name: cell,
        testDir: defineBddConfig({
          outputDir: cellDirs.bdd,
          features: product.features,
          steps: product.steps,
          // Edition-ful cells generate only their edition's scenarios (untagged run on both).
          ...(tags !== undefined ? { tags } : {}),
        }),
        use: {
          ...DESKTOP,
          ...(firstSite ? { baseURL: firstSite.baseURL } : {}),
        },
        outputDir: cellDirs.output,
        dependencies: [setupName],
        // Defensive upper bound only: per-project `workers` caps how many workers a
        // project uses, not which parallelIndex slots it sees, so it cannot by itself
        // keep parallelIndex within a smaller pool. Correctness rests on the
        // single-cell global `workers` below.
        workers: pool.length > 0 ? pool.length : 1,
        retries: isCI ? 2 : 0,
        metadata: routingMetadata(product.name, cell, edition),
      },
    ];
  });

  return defineConfig({
    forbidOnly: isCI,
    fullyParallel: true,
    // Global workers = the SELECTED cell's pool size, so parallelIndex ∈ 0…N-1 and
    // `pool[parallelIndex]` is always in range for a single-cell invocation (plan §3.2).
    workers:
      selectedCellConfig && selectedCellConfig.sites.length > 0
        ? selectedCellConfig.sites.length
        : 1,
    reporter: reporters(dirs(product.name, reportCell).report),
    use: {
      trace: "retain-on-failure",
      screenshot: "only-on-failure",
      video: "retain-on-failure",
    },
    projects,
  });
}
