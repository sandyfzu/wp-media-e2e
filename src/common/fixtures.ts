import { test as base, createBdd } from "playwright-bdd";

import { readResolvedArtifact } from "./artifacts/consume";
import type { ArtifactRole, ResolvedArtifact } from "./artifacts/types";
import { getPool, readRouting } from "./config/metadata";
import { isPlaceholderSite } from "./config/sites";
import type { Edition, SiteConfig } from "./config/types";

/**
 * Shared test instance. It binds each worker to one site from its project's pool
 * (by `parallelIndex`) and reuses that site's `storageState`, so scenarios run
 * authenticated against an isolated WordPress instance. Scenarios tagged `@noauth`
 * start unauthenticated (e.g. login/logout flows).
 */

interface TestFixtures {
  /** The WordPress site bound to the current worker. Throws if the scenario needs one but none is configured. */
  site: SiteConfig;
  /** The bound cell's edition (Free/Pro). Throws if read in a cell that declares no edition. */
  edition: Edition;
  /**
   * Looks up a resolved plugin zip for this cell by role — `pluginArtifact("plugin").zipPath`
   * is the artifact under test, `"previous"` the version to compare against. The artifacts
   * setup resolved and verified it; this reads that result. Throws if the role is
   * unsupported or the setup did not run for this cell.
   */
  pluginArtifact: (role: ArtifactRole) => ResolvedArtifact;
}

interface WorkerFixtures {
  /** The site this worker is pinned to (by parallelIndex), or `undefined` when the project has no pool. */
  boundSite: SiteConfig | undefined;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  boundSite: [
    // Worker-scoped: pin this worker to one pooled site by its global parallelIndex.
    // eslint-disable-next-line no-empty-pattern -- Playwright derives deps from this destructuring; this fixture has none.
    async ({}, use, workerInfo) => {
      const { product, cell } = readRouting(workerInfo.project.metadata);
      const pool = getPool(product, cell);
      if (pool.length === 0) {
        await use(undefined);
        return;
      }
      const site = pool[workerInfo.parallelIndex];
      if (site === undefined) {
        throw new Error(
          `No site for parallelIndex ${String(workerInfo.parallelIndex)} in a pool of ${String(pool.length)}. ` +
            "Run one cell per invocation with workers = pool size.",
        );
      }
      await use(site);
    },
    { scope: "worker" },
  ],

  // Scenario-facing handle to the bound site; fails loudly when the project has no pool.
  site: async ({ boundSite }, use) => {
    if (boundSite === undefined) {
      throw new Error(
        "This scenario requires a bound WordPress site, but the project has no site pool. " +
          "Configure the product's sites.json, or tag the scenario @noauth if it needs no site.",
      );
    }
    await use(boundSite);
  },

  // The bound cell's edition (BackWPup Free/Pro), read from the project's routing metadata.
  // Throws if a scenario reads it but the cell declares none — editionless products never do.
  // eslint-disable-next-line no-empty-pattern -- no fixture deps; edition comes from testInfo.
  edition: async ({}, use, testInfo) => {
    const { edition } = readRouting(testInfo.project.metadata);
    if (edition === undefined) {
      throw new Error(
        "Fixture `edition` was requested, but this cell declares no edition. " +
          "Editions are configured per cell for edition-ful products.",
      );
    }
    await use(edition);
  },

  // Role → resolved zip lookup for this cell. Returns a plain function (fixtures cannot take
  // arguments), so a step calls `pluginArtifact("plugin").zipPath`. Reading comes from the
  // per-process memo or `resolution.json` (see artifacts/consume.ts); routing is from testInfo.
  // eslint-disable-next-line no-empty-pattern -- no fixture deps; routing comes from testInfo.
  pluginArtifact: async ({}, use, testInfo) => {
    const { product, cell } = readRouting(testInfo.project.metadata);
    await use((role) => readResolvedArtifact(product, cell, role));
  },

  // Override: point Playwright's baseURL at the bound site, so relative navigations target it.
  baseURL: async ({ boundSite, baseURL }, use) => {
    await use(boundSite?.baseURL ?? baseURL);
  },

  // Override: `@noauth` scenarios start with an empty session; all others reuse the site's saved login.
  storageState: async ({ $tags, boundSite, storageState }, use) => {
    if ($tags.includes("@noauth")) {
      await use({ cookies: [], origins: [] });
      return;
    }
    // The auth setup skips placeholder sites, so no storageState file exists for one; failing
    // here with the cause beats the ENOENT Playwright would otherwise throw reading that file.
    if (boundSite !== undefined && isPlaceholderSite(boundSite)) {
      throw new Error(
        "This scenario needs an authenticated session, but this worker is bound to a " +
          `placeholder/example site (${boundSite.baseURL}) that the auth setup skips. ` +
          "Create the product's sites.json for real runs, or tag the scenario @noauth.",
      );
    }
    await use(boundSite?.storageState ?? storageState);
  },
});

export const { Given, When, Then, Step, Before, After, BeforeAll, AfterAll } =
  createBdd(test);
