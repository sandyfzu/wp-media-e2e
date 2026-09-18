import type { Page, Response } from "@playwright/test";

import { isObject } from "../../../common/guards";

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
 * Verified against the ref under test by reading every `register_rest_route()` call: **26
 * registrations across two namespaces** — 22 under `backwpup/v1` and 4 under `backwpup/v2` — in
 * ten `src/**\/API/*.php` files. Re-measured: the route names **and their namespaces** are
 * identical in 5.7.4, 5.7.5 and the `develop` build the cells install (`9.99.99-90f93911`) — `src/`
 * is byte-identical between 5.7.5 and that build, carrying the same two namespace constants and the
 * same four `v2` registrations — so neither the names nor the split is version-fragile. (5.7.4's
 * `src/` does differ, but only in permission callbacks and one new file.)
 *
 * The namespace is therefore recorded **per route**, never assumed: three of the routes a reader
 * would expect under `v1` are served under `v2`, and a barrier built with the wrong namespace can
 * never match — failing as an opaque timeout instead of as the wrong name it is.
 */

/** BackWPup's original REST namespace, carrying all but four of its routes. */
const V1 = "backwpup/v1";

/** The namespace BackWPup's later routes were added under. */
const V2 = "backwpup/v2";

/**
 * Every route the plugin registers by name, mapped to the namespace it is served under — verified
 * exhaustively against the plugin source. Grouped by concern (job config, storages, backups,
 * licence/UI) rather than alphabetically, so a reader can find the one they need.
 *
 * One registration is deliberately absent: `v2`'s `/backups/(?P<id>\d+)/type` takes a path
 * parameter, so it cannot be addressed by a fixed name and no barrier could name it.
 */
export const BACKWPUP_ROUTES = {
  // Job lifecycle & configuration.
  addjob: V1,
  updatejob: V1,
  delete_job: V1,
  "update-job-title": V1,
  getjobslist: V1,
  save_job_settings: V1,
  save_job_format: V2,
  save_excluded_tables: V1,
  save_files_exclusions: V1,
  // Storage configuration & cloud authentication.
  storages: V2,
  storagelistcompact: V1,
  cloudsaveandtest: V1,
  authenticate_cloud: V1,
  cloud_is_authenticated: V1,
  delete_auth_cloud: V1,
  // Backups: running, listing, bulk operations.
  startbackup: V1,
  "job-abort-status": V1,
  backups: V1,
  process_bulk_actions: V1,
  pagination: V1,
  // Cross-cutting UI.
  getblock: V1,
  messages: V2,
  save_site_option: V1,
  license_update: V1,
  "chatbot-context": V1,
} as const;

/** A route BackWPup registers. Typo-proof: any other string fails to compile. */
export type BackWPupRoute = keyof typeof BACKWPUP_ROUTES;

/**
 * The namespace `route` is served under.
 *
 * Exists so callers and messages read the namespace from the one verified table rather than
 * hard-coding `backwpup/v1` and being right most of the time.
 */
export function routeNamespace(route: BackWPupRoute): string {
  return BACKWPUP_ROUTES[route];
}

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
 * True if `url` addresses `route` under the namespace {@link BACKWPUP_ROUTES} records for it.
 *
 * Matches both shapes WordPress serves — the pretty `…/wp-json/<namespace>/<route>` and the
 * fallback `…?rest_route=/<namespace>/<route>` (whose slashes arrive percent-encoded) — because
 * which one a site uses depends on its permalink settings, not on anything the test controls.
 * The namespace comes from {@link BACKWPUP_ROUTES}, so a `v2` route is matched as `v2`.
 *
 * The match is **boundary-anchored**: the route must be followed by end-of-string, `/`, `?` or
 * `&`. Without that, a barrier on a route would also fire for any longer route sharing its
 * prefix, silently resolving on the wrong call.
 *
 * Exported for unit testing — POMs should call {@link waitForRest}.
 */
export function matchesRoute(url: string, route: BackWPupRoute): boolean {
  // Decode so the `rest_route=/backwpup%2Fv2%2F…` form compares the same as the pretty form. A
  // malformed escape sequence would throw, and an unparseable URL simply cannot be a match.
  let decoded: string;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    decoded = url;
  }
  const needle = `${routeNamespace(route)}/${route}`;
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
      `[backwpup/rest] ${routeNamespace(route)}/${route} responded ${String(response.status())} ` +
        `(${response.statusText()}). The action was issued but the plugin rejected it.`,
    );
  }
  return response;
}

/**
 * Asserts a BackWPup REST call reported success **in its body**, not merely in its HTTP status.
 *
 * Several of the plugin's routes answer their own refusals with **HTTP 200** and the real outcome in
 * a `status` field — `startbackup` returns `{status: 500, message: "The backup process could not be
 * started!…"}` that way when the temp folder, the log folder or the destination is unusable
 * (`src/Backups/API/Rest.php`). A barrier that only checked the transport status would call that a
 * successful start, and the scenario would fail minutes later as "no backup appeared", pointing
 * nowhere.
 *
 * A body without a numeric `status` is accepted: not every route uses the convention, and inventing
 * a failure for one that does not would be worse than the gap.
 *
 * @param response - the response {@link waitForRest} returned.
 * @param route - the route it answered, for the message.
 * @throws {@link Error} if the body reports a status of 400 or more, quoting the plugin's own message.
 */
export async function expectRestPayloadOk(
  response: Response,
  route: BackWPupRoute,
): Promise<void> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return; // Not JSON, so it cannot be carrying this convention.
  }
  if (!isObject(body)) return;
  const status = typeof body.status === "number" ? body.status : undefined;
  if (status === undefined || status < 400) return;
  const message =
    typeof body.message === "string" ? body.message : "(no message)";
  throw new Error(
    `[backwpup/rest] "${route}" reported failure in its body (status ${String(status)}): ${message}`,
  );
}
