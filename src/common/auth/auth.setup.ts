import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { test as setup } from "@playwright/test";

import { getPool, readRouting } from "../config/metadata";
import { isPlaceholderSite } from "../config/sites";
import { verifyPool } from "../setup/preflight";
import { loginViaUi } from "./login";

/**
 * Authentication setup project (plain Playwright, not BDD). For each real site in the
 * cell's pool it:
 *   1. Verifies the site's transport (SSH/Docker/local) is reachable and functional.
 *   2. Logs in once through the WordPress UI and saves the session to that site's
 *      `storageState` file, which the BDD project reuses (one site per worker — see
 *      fixtures.ts).
 *
 * The BDD project declares this as a `dependency`, so it always runs first.
 * Logins run in isolated browser contexts, so saved sessions never bleed across sites.
 *
 * When the pool holds only placeholder/example sites (no sites.json yet), the whole
 * setup is skipped so the scaffold's `@noauth` smoke tests stay green on a fresh checkout.
 *
 * Pre-flight failures (transport unreachable, WP-CLI missing, wrong path) surface here
 * with actionable guidance — not as cryptic per-scenario failures later.
 */
setup("authenticate site pool", async ({ browser }, testInfo) => {
  const { product, cell } = readRouting(testInfo.project.metadata);
  const pool = getPool(product, cell);
  const real = pool.filter((site) => !isPlaceholderSite(site));

  setup.skip(
    real.length === 0,
    `No real sites configured for "${product}/${cell}" (placeholder example data ` +
      "in use). Create sites.json for real runs.",
  );

  // Preflight (concurrent, but SSH round-trips add up) plus one SERIAL UI login per
  // site can far exceed the default per-test timeout on slow remote sites, so the
  // budget scales with the pool instead of failing spuriously on a healthy fleet.
  setup.setTimeout(60_000 + real.length * 60_000);

  // Verify every site's transport before attempting authentication. A failure here
  // throws a formatted report, which Playwright surfaces as a setup error and uses
  // to skip the dependent BDD project — preventing cascading failures.
  await verifyPool(pool, product, cell);

  for (const site of real) {
    const context = await browser.newContext({ baseURL: site.baseURL });
    try {
      const page = await context.newPage();
      await loginViaUi(page, site);

      await mkdir(dirname(site.storageState), { recursive: true });
      await context.storageState({ path: site.storageState });
    } finally {
      await context.close();
    }
  }
});
