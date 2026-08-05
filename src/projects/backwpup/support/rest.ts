import type { Page, Response } from "@playwright/test";

/**
 * Named REST barriers for BackWPup's own admin API.
 *
 * BackWPup drives nearly every admin interaction through `backwpup/v1`, so a REST response is
 * usually the *only* honest signal that an action finished — the DOM often changes before or
 * without it. Awaiting the specific call an action makes replaces the baseline's
 * `waitForLoadState("networkidle")`, which merely waits for the network to go quiet and so
 * passes just as happily when nothing was requested at all.
 *
 * Every route the plugin registers is listed in {@link BACKWPUP_ROUTES}, so a POM names a route
 * instead of inlining a URL, and a typo is a **compile error** rather than a barrier that can
 * never match and fails 30 s later as an opaque timeout.
 *
 * Verified against the ref under test (`9.99.99-c0dd22c2`, both editions): 24 routes, all under
 * the single namespace `backwpup/v1`, registered across ten `src/**\/API/Rest.php` files. The set
 * is identical in 5.7.4, so these names are not version-fragile.
 */

/** The one REST namespace BackWPup registers. */
export const REST_NAMESPACE = "backwpup/v1";

/**
 * Every route registered under {@link REST_NAMESPACE}, verified exhaustively against the plugin
 * source. Ordered as grouped by concern (job config, storages, backups, licence/UI) rather than
 * alphabetically, so a reader can find the one they need.
 */
export const BACKWPUP_ROUTES = [
  // Job lifecycle & configuration.
  "addjob",
  "updatejob",
  "delete_job",
  "update-job-title",
  "getjobslist",
  "save_job_settings",
  "save_job_format",
  "save_excluded_tables",
  "save_files_exclusions",
  // Storage configuration & cloud authentication.
  "storages",
  "storagelistcompact",
  "cloudsaveandtest",
  "authenticate_cloud",
  "cloud_is_authenticated",
  "delete_auth_cloud",
  // Backups: running, listing, bulk operations.
  "startbackup",
  "job-abort-status",
  "backups",
  "process_bulk_actions",
  "pagination",
  // Cross-cutting UI.
  "getblock",
  "messages",
  "save_site_option",
  "license_update",
] as const;

/** A route registered under {@link REST_NAMESPACE}. Typo-proof: any other string fails to compile. */
export type BackWPupRoute = (typeof BACKWPUP_ROUTES)[number];

/** Options for {@link waitForRest}. */
export interface WaitForRestOptions {
  /** How long to wait for the call, in ms. Defaults to Playwright's own navigation timeout. */
  readonly timeout?: number;
  /**
   * Require a 2xx/3xx response. Default `true`: a barrier that accepts a 500 would report an
   * action as complete precisely when it failed.
   */
  readonly expectOk?: boolean;
}

/**
 * True if `url` addresses `route` under {@link REST_NAMESPACE}.
 *
 * Matches both shapes WordPress serves — the pretty `…/wp-json/backwpup/v1/<route>` and the
 * fallback `…?rest_route=/backwpup/v1/<route>` (whose slashes arrive percent-encoded) — because
 * which one a site uses depends on its permalink settings, not on anything the test controls.
 *
 * The match is **boundary-anchored**: the route must be followed by end-of-string, `/`, `?` or
 * `&`. Without that, a barrier on a route would also fire for any longer route sharing its
 * prefix, silently resolving on the wrong call.
 *
 * Exported for unit testing — POMs should call {@link waitForRest}.
 */
export function matchesRoute(url: string, route: BackWPupRoute): boolean {
  // Decode so the `rest_route=/backwpup%2Fv1%2F…` form compares the same as the pretty form. A
  // malformed escape sequence would throw, and an unparseable URL simply cannot be a match.
  let decoded: string;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    decoded = url;
  }
  const needle = `${REST_NAMESPACE}/${route}`;
  const at = decoded.indexOf(needle);
  if (at === -1) return false;
  const after = decoded.charAt(at + needle.length);
  return after === "" || after === "/" || after === "?" || after === "&";
}

/**
 * Waits for the response to BackWPup's `route` call and returns it.
 *
 * Use it as a barrier around the action that triggers the call, so the wait starts before the
 * request is issued and cannot miss it:
 *
 * ```ts
 * const [response] = await Promise.all([
 *   waitForRest(page, "startbackup"),
 *   startButton.click(),
 * ]);
 * ```
 *
 * @throws {@link Error} if the response arrives with a non-ok status and `expectOk` is not
 * disabled — naming the route and status, so the failure reads as "the plugin's call failed"
 * rather than as a generic timeout.
 */
export async function waitForRest(
  page: Page,
  route: BackWPupRoute,
  options: WaitForRestOptions = {},
): Promise<Response> {
  const response = await page.waitForResponse(
    (candidate) => matchesRoute(candidate.url(), route),
    options.timeout === undefined ? undefined : { timeout: options.timeout },
  );
  if ((options.expectOk ?? true) && !response.ok()) {
    throw new Error(
      `[backwpup/rest] ${REST_NAMESPACE}/${route} responded ${String(response.status())} ` +
        `(${response.statusText()}). The action was issued but the plugin rejected it.`,
    );
  }
  return response;
}
