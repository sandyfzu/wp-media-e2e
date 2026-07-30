import { isPlaceholderSite } from "../config/sites";
import { errorMessage } from "../guards";
import { disposeConnections } from "./exec";
import { cleanSiteStaging } from "./staging";
import type { SiteConfig } from "../config/types";

/**
 * Worker-scoped release of everything a worker acquired on its bound site: the staging area it
 * copied artifacts into, and the SSH connection it kept open.
 *
 * This runs once per worker, after its last scenario, wired as an auto worker fixture (see
 * `../fixtures.ts`). It is **best-effort by design**: by the time it runs every assertion has
 * already been made, so a cleanup failure must be reported but must never turn a passing run
 * red. Staging removal is therefore caught and logged, and the connection is closed either way
 * — a leaked SSH client would keep the worker process alive after the run.
 *
 * Cleanup is unconditional rather than tracked, so residue a *crashed* run left behind is
 * removed too. That is what makes "a re-run leaves nothing on the site" true even after a
 * process is killed mid-scenario.
 */

/**
 * Releases the worker's hold on `site`: remove its staging area, then close pooled connections.
 *
 * @param site - the worker's bound site, or `undefined` when the project has no pool (nothing
 * was ever staged, but connections are still closed so the call is safe to make unconditionally).
 */
export async function releaseSite(site: SiteConfig | undefined): Promise<void> {
  try {
    // A placeholder site has no reachable transport, so cleaning it would only produce a
    // guaranteed failure and a warning on every fresh-checkout run.
    if (site !== undefined && !isPlaceholderSite(site)) {
      await cleanSiteStaging(site.transport);
    }
  } catch (error) {
    // Reported, never thrown: every assertion is already done, and a site left with scratch
    // files is a nuisance rather than a test result.
    console.warn(
      `[wp/teardown] could not clean the staging area on ${site?.baseURL ?? "the bound site"} ` +
        `(continuing): ${errorMessage(error)}`,
    );
  } finally {
    disposeConnections();
  }
}
