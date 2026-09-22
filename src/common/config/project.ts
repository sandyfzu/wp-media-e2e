import { defineConfig } from "@playwright/test";
import type { PlaywrightTestConfig, Project } from "@playwright/test";
import { defineBddConfig } from "playwright-bdd";

import { registerManifest } from "../artifacts/registry";
import { DESKTOP } from "./devices";
import { intEnv } from "./env";
import {
  registerDebugLogOptions,
  registerPool,
  registerSiteDbResidue,
  registerSiteResidue,
  routingMetadata,
} from "./metadata";
import { reporters } from "./reporting";
import { dirs, seedSelectedCells, selectedCells } from "./run-context";
import { VISUAL_EXPECT, snapshotPathTemplateFor } from "./visual";
import type { Edition, ProductConfig, SiteConfig, SitePool } from "./types";

/** Per-product Playwright config factory: expands a {@link ProductConfig} into a runnable Playwright config. */

// True when running under CI (the `CI` env var is present and non-empty).
const isCI = process.env.CI !== undefined && process.env.CI !== "";

/**
 * How many times a failed scenario is retried — **the single place retries are configured.**
 *
 * Two by default, so a scenario gets three attempts, everywhere rather than only on CI. These
 * scenarios drive a real WordPress over a network: an SSH hiccup, a slow first backup, a cell that
 * was briefly busy. Failing a run on the first such blip taught us to re-run by hand, which is the
 * same retry with a worse feedback loop and no record of having happened. Playwright marks a
 * scenario that only passed on a retry **flaky** rather than green, so the noise stays visible
 * instead of being laundered into a pass.
 *
 * A retry is a genuinely fresh attempt, not a resumption: the `@plugin` lifecycle hooks are
 * per-scenario (`Before`/`After` run as `beforeEach`/`afterEach`), so every attempt reinstalls the
 * plugin, clears `debug.log`, and sweeps residue before it starts.
 *
 * Override with `E2E_RETRIES` — `0` to fail fast while debugging, higher to ride out a sick cell.
 * Deliberately applied to the scenario projects only: the auth and artifact setups are not tests,
 * and a setup that cannot succeed should say so at once rather than three times.
 */
const RETRIES = intEnv("E2E_RETRIES", 2, 0, 10);

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
 * Builds the config for one product. Each `cell` becomes three projects: two sibling setup
 * projects — one authenticates the cell's site pool, one resolves & verifies its plugin
 * artifacts — and the BDD project that depends on both (either failing skips the
 * scenarios). A run targets exactly one cell via `--project=<cell>`, which keeps
 * the global `parallelIndex` in range for the worker→site binding; selecting more than
 * one cell at once is rejected fail-fast below.
 */
export function createProductConfig(
  product: ProductConfig,
): PlaywrightTestConfig {
  const cells = Object.keys(product.sites);

  // Publish the CLI's cell selection to the environment before anything reads it: worker
  // processes rebuild this config with an empty argv, so this is their only way to tell an
  // explicitly selected cell from a broad serial run (see run-context.ts).
  seedSelectedCells();

  // Publish the product's artifact manifest to the per-process registry the artifacts setup
  // reads by product name (it never imports product configs — see artifacts/registry.ts).
  registerManifest(product.name, product.artifacts);

  // Same channel for the product's debug-log preset: its `ignore`/`source` patterns are RegExps,
  // which cannot ride project metadata (Playwright serializes that into reports), and the shared
  // scenario hooks must not import product code.
  registerDebugLogOptions(product.name, product.debugLog);

  // Same channel for the paths this product leaves on a site after it is uninstalled: the shared
  // scenario hooks clear them, and must not import product code to learn what they are.
  registerSiteResidue(product.name, product.siteResidue);

  // And for the footprint it leaves in the site's *database* when its files go without its own
  // uninstall running — swept off what is found, not off whether the plugin is installed.
  registerSiteDbResidue(product.name, product.siteDbResidue);

  // Resolve the targeted cell. Selecting multiple cells in one invocation is unsafe
  // (parallelIndex is global), so fail fast instead of silently mis-sizing workers.
  const requested = selectedCells().filter((c) => cells.includes(c));
  if (requested.length > 1) {
    throw new Error(
      `Multiple cells selected (${requested.join(", ")}). Run one cell per ` +
        "invocation, e.g. --project=<cell>, so parallelIndex stays in range.",
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
    const artifactsName = `artifacts:${cell}`;
    const firstSite = pooled[0];
    const tags = editionFilter(edition);
    const routing = routingMetadata(product.name, cell, edition);

    return [
      {
        name: setupName,
        testDir: "src/common/auth",
        testMatch: /auth\.setup\.ts$/,
        use: { ...DESKTOP },
        metadata: routing,
      },
      {
        // Sibling of the auth setup (no dependency between them): resolves & verifies the
        // cell's plugin artifacts. Needs no browser. Skips on placeholder-only pools.
        name: artifactsName,
        testDir: "src/common/artifacts",
        testMatch: /artifacts\.setup\.ts$/,
        metadata: routing,
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
        dependencies: [setupName, artifactsName],
        // Defensive upper bound only: per-project `workers` caps how many workers a
        // project uses, not which parallelIndex slots it sees, so it cannot by itself
        // keep parallelIndex within a smaller pool. Correctness rests on the
        // single-cell global `workers` below.
        workers: pool.length > 0 ? pool.length : 1,
        retries: RETRIES,
        metadata: routing,
      },
    ];
  });

  return defineConfig({
    forbidOnly: isCI,
    fullyParallel: true,
    // Global workers = the SELECTED cell's pool size, so parallelIndex ∈ 0…N-1 and
    // `pool[parallelIndex]` is always in range for a single-cell invocation.
    workers:
      selectedCellConfig && selectedCellConfig.sites.length > 0
        ? selectedCellConfig.sites.length
        : 1,
    reporter: reporters(dirs(product.name, reportCell).report),
    // Committed-baseline visual checks (`toHaveScreenshot`): comparison tolerance + where the
    // per-product/cell baselines live. WP Rocket's A/B check (visual/ab.ts) diffs live renders and
    // does NOT use this — it is the wiring for the general committed-baseline capability.
    expect: VISUAL_EXPECT,
    snapshotPathTemplate: snapshotPathTemplateFor(product.name),
    use: {
      trace: "retain-on-failure",
      screenshot: "only-on-failure",
      video: "retain-on-failure",
    },
    projects,
  });
}
