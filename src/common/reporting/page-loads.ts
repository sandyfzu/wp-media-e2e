import { plain, redactSecrets } from "../text";

/**
 * What a failed scenario says about **the site's own requests that never arrived** — a script, a
 * stylesheet, the document itself, a REST call.
 *
 * A page that lost its own scripts does not fail where it broke: it fails minutes later on whatever
 * it then cannot do — a toggle that never shows, a listing that never loads — as a locator timeout
 * that points nowhere. Measured on a cell whose HTTP/3 drops connections: every failed attempt had
 * a page missing 7–36 of its own scripts and styles, and nothing in the report said so. So every
 * browser context is watched (`watchPageLoads`), and when the scenario fails the losses become one
 * warning line and one small attachment (`reportPageLoads`). Only the site's own origin counts — a
 * third-party font or avatar is not the site under test — and only failures:
 *
 * - a request that failed in transport, except `net::ERR_ABORTED`, which is the browser or the page
 *   cancelling it (a navigation away, a script's `abort()`), not the site failing it;
 * - a document, script or stylesheet answered with a status of 500 or more.
 *
 * Reports are as sensitive as the sites file, so a URL is shown as its path only, every path run of
 * {@link HEX_RUN_MIN} or more hex digits masked (BackWPup's restore folder name, a capability, is 20),
 * the query cut to {@link KEPT_QUERY_KEYS} (nonces, `file_path=` and `logfile=` go), and the rest
 * through {@link redactSecrets}. Never throws into a scenario: diagnosis must not change a verdict.
 */

/** The attachment's name. */
export const PAGE_LOAD_ATTACHMENT = "page-load-failures";

/** At most this many failures are listed; the rest are only counted. */
export const MAX_LISTED_FAILURES = 50;

/** The shortest run of hex digits in a path that is masked: a token, never a word or a version. */
export const HEX_RUN_MIN = 16;

/** Query parameters whose value says which screen it was (`page=backwpup`, `step=6`); all others go. */
export const KEPT_QUERY_KEYS: readonly string[] = [
  "page",
  "step",
  "tab",
  "action",
];

/** A kept parameter's value must look like a screen's name; anything else is dropped too. */
const SCREEN_NAME = /^[\w-]{1,64}$/;

/** A run of {@link HEX_RUN_MIN} or more hex digits. */
const HEX_RUN = new RegExp(`[0-9a-f]{${String(HEX_RUN_MIN)},}`, "gi");

/** The transport failure that is a cancellation, not a loss. */
const ABORTED = "net::ERR_ABORTED";

/** Resource types whose 5xx answer is a page losing part of itself. */
const STATUS_TYPES: readonly string[] = ["document", "script", "stylesheet"];

/** The longest URL or reason shown, after masking. */
const MAX_TEXT = 300;

/** What a failure is shown as when its page cannot be told. */
const UNKNOWN_PAGE = "(unknown page)";

/** One of the site's own requests that never arrived. */
export interface PageLoadFailure {
  /** The page it belonged to, masked like {@link url}. */
  readonly page: string;
  readonly method: string;
  /** Playwright's resource type: `document`, `script`, `stylesheet`, `fetch`, … */
  readonly resourceType: string;
  /** The request's path and kept query, masked. */
  readonly url: string;
  /** The transport's error text, or `HTTP <status>`. */
  readonly reason: string;
}

/** The part of a Playwright `Request` read here; a frame-less request throws from `frame()`. */
export interface RequestLike {
  url(): string;
  method(): string;
  resourceType(): string;
  failure(): { readonly errorText: string } | null;
  isNavigationRequest(): boolean;
  frame(): { url(): string };
}

/** The part of a Playwright `Response` read here. */
export interface ResponseLike {
  status(): number;
  request(): RequestLike;
}

/** The part of a `BrowserContext` the watch subscribes to. */
export interface ContextEvents {
  on(event: "requestfailed", listener: (request: RequestLike) => void): unknown;
  on(event: "response", listener: (response: ResponseLike) => void): unknown;
  off(
    event: "requestfailed",
    listener: (request: RequestLike) => void,
  ): unknown;
  off(event: "response", listener: (response: ResponseLike) => void): unknown;
}

/** The part of `TestInfo` the report needs. */
export interface ScenarioOutcome {
  readonly title: string;
  readonly status?: string;
  readonly expectedStatus: string;
  attach(
    name: string,
    options: { body: string; contentType: string },
  ): Promise<void>;
}

/**
 * The site's origin (`https://host:port`), or `undefined` when there is no http(s) site to watch.
 *
 * @param baseURL - the bound site's address.
 */
export function siteOrigin(baseURL: string | undefined): string | undefined {
  if (baseURL === undefined || !URL.canParse(baseURL)) return undefined;
  const url = new URL(baseURL);
  return url.protocol === "http:" || url.protocol === "https:"
    ? url.origin
    : undefined;
}

/**
 * `url` as safe to report, or `undefined` when it is not on `origin`: its path and kept query
 * parameters, hex runs masked, then {@link redactSecrets} and {@link plain}, cut to a bounded length.
 *
 * @param url - a request's or a page's URL.
 * @param origin - the site's origin ({@link siteOrigin}).
 * @example
 * ```ts
 * sameOriginPath("https://wp.test/wp-admin/admin.php?page=backwpup&_wpnonce=abc", "https://wp.test");
 * // "/wp-admin/admin.php?page=backwpup&…"
 * ```
 */
export function sameOriginPath(
  url: string,
  origin: string,
): string | undefined {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  if (parsed.origin !== origin) return undefined;
  const kept: string[] = [];
  let dropped = false;
  for (const [key, value] of parsed.searchParams) {
    if (KEPT_QUERY_KEYS.includes(key) && SCREEN_NAME.test(value))
      kept.push(`${key}=${value}`);
    else dropped = true;
  }
  const query =
    kept.length > 0 || dropped
      ? `?${[...kept, ...(dropped ? ["…"] : [])].join("&")}`
      : "";
  return bounded(`${parsed.pathname.replace(HEX_RUN, "***")}${query}`);
}

/** `text` masked, made one plain line, and cut to {@link MAX_TEXT} characters. */
function bounded(text: string): string {
  // Masked before cutting: a cut could split a credential from the shape that marks it.
  const line = plain(redactSecrets(text));
  return line.length > MAX_TEXT ? `${line.slice(0, MAX_TEXT - 1)}…` : line;
}

/** The page `request` belonged to: itself for a navigation, else its frame's document. */
function pageOf(request: RequestLike, origin: string): string {
  try {
    const url = request.isNavigationRequest()
      ? request.url()
      : request.frame().url();
    return sameOriginPath(url, origin) ?? "(another origin)";
  } catch {
    // A service worker's request has no frame.
    return UNKNOWN_PAGE;
  }
}

/** `request` as a {@link PageLoadFailure} with `reason`, or `undefined` when it is not the site's. */
function failureOf(
  request: RequestLike,
  origin: string,
  reason: string,
): PageLoadFailure | undefined {
  const url = sameOriginPath(request.url(), origin);
  if (url === undefined) return undefined;
  return {
    page: pageOf(request, origin),
    method: bounded(request.method()),
    resourceType: bounded(request.resourceType()),
    url,
    reason: bounded(reason),
  };
}

/**
 * A `requestfailed` event as a loss, or `undefined` when it is another origin's or a cancellation.
 *
 * @param request - the failed request.
 * @param origin - the site's origin.
 */
export function failedRequest(
  request: RequestLike,
  origin: string,
): PageLoadFailure | undefined {
  const reason = request.failure()?.errorText ?? "failed";
  if (reason === ABORTED) return undefined;
  return failureOf(request, origin, reason);
}

/**
 * A response as a loss — a document, script or stylesheet of the site answered 500 or more — or
 * `undefined`.
 *
 * @param response - the response.
 * @param origin - the site's origin.
 */
export function failedResponse(
  response: ResponseLike,
  origin: string,
): PageLoadFailure | undefined {
  const status = response.status();
  const request = response.request();
  if (status < 500 || !STATUS_TYPES.includes(request.resourceType()))
    return undefined;
  return failureOf(request, origin, `HTTP ${String(status)}`);
}

/** The losses of one scenario: the first {@link MAX_LISTED_FAILURES} kept, every one counted. */
export class PageLoadLog {
  private readonly listed: PageLoadFailure[] = [];
  private readonly reasons = new Map<string, number>();
  private count = 0;

  /** Records one loss. */
  record(failure: PageLoadFailure): void {
    this.count += 1;
    this.reasons.set(
      failure.reason,
      (this.reasons.get(failure.reason) ?? 0) + 1,
    );
    if (this.listed.length < MAX_LISTED_FAILURES) this.listed.push(failure);
  }

  /** How many losses were seen, listed or not. */
  get total(): number {
    return this.count;
  }

  /** The listed losses, in the order they happened. */
  get failures(): readonly PageLoadFailure[] {
    return this.listed;
  }

  /** Each reason with its count, most frequent first (ties in order of first appearance). */
  get byReason(): readonly (readonly [string, number])[] {
    return [...this.reasons].sort((a, b) => b[1] - a[1]);
  }
}

/**
 * Watches `context` for the site's lost requests until the returned `stop` is called.
 *
 * @param context - the scenario's browser context.
 * @param origin - the site's origin.
 * @returns the log, filled as events arrive, and `stop`, which unsubscribes.
 */
export function watchPageLoads(
  context: ContextEvents,
  origin: string,
): { readonly log: PageLoadLog; stop(): void } {
  const log = new PageLoadLog();
  // A listener must never throw into Playwright's event loop: a failure to classify is a lost
  // diagnosis, never a broken run.
  const onFailed = (request: RequestLike): void => {
    try {
      const failure = failedRequest(request, origin);
      if (failure !== undefined) log.record(failure);
    } catch {
      /* diagnosis only */
    }
  };
  const onResponse = (response: ResponseLike): void => {
    try {
      const failure = failedResponse(response, origin);
      if (failure !== undefined) log.record(failure);
    } catch {
      /* diagnosis only */
    }
  };
  context.on("requestfailed", onFailed);
  context.on("response", onResponse);
  return {
    log,
    stop: () => {
      context.off("requestfailed", onFailed);
      context.off("response", onResponse);
    },
  };
}

/**
 * The warning line for a failed scenario that lost requests, or `undefined` when it lost none.
 *
 * @param log - the scenario's losses.
 * @param title - the scenario's title.
 */
export function summaryLine(
  log: PageLoadLog,
  title: string,
): string | undefined {
  if (log.total === 0) return undefined;
  const top = log.byReason
    .slice(0, 3)
    .map(([reason, n]) => `${String(n)} ${reason}`)
    .join(", ");
  const more = log.byReason.length > 3 ? ", …" : "";
  return (
    `[page-loads] "${plain(title)}": ${String(log.total)} of the site's own requests failed ` +
    `(${top}${more}). A page missing its own scripts or styles fails on whatever it then cannot ` +
    `do; listed in the "${PAGE_LOAD_ATTACHMENT}" attachment.`
  );
}

/**
 * The attachment's text, the losses grouped by page in the order pages first lost one, or
 * `undefined` when there were none.
 *
 * @param log - the scenario's losses.
 */
export function attachmentBody(log: PageLoadLog): string | undefined {
  if (log.total === 0) return undefined;
  const pages = new Map<string, PageLoadFailure[]>();
  for (const failure of log.failures) {
    const group = pages.get(failure.page) ?? [];
    group.push(failure);
    pages.set(failure.page, group);
  }
  const unlisted = log.total - log.failures.length;
  const lines = [
    `${String(log.total)} of the site's own requests failed while this scenario ran` +
      (unlisted > 0
        ? ` (the first ${String(log.failures.length)} listed).`
        : "."),
    `Shown as paths: queries cut to ${KEPT_QUERY_KEYS.join("/")}, hex runs of ${String(HEX_RUN_MIN)}+ masked.`,
  ];
  for (const [page, failures] of pages) {
    lines.push("", page);
    for (const f of failures)
      lines.push(`  ${f.method} ${f.resourceType} ${f.url} — ${f.reason}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * When the scenario failed and lost requests, warns once and attaches the list. Never throws.
 *
 * @param log - the scenario's losses.
 * @param outcome - the scenario's `TestInfo`.
 * @param warn - where the line goes (`console.warn`).
 */
export async function reportPageLoads(
  log: PageLoadLog,
  outcome: ScenarioOutcome,
  warn: (line: string) => void = (line) => {
    console.warn(line);
  },
): Promise<void> {
  try {
    if (outcome.status === outcome.expectedStatus) return;
    const line = summaryLine(log, outcome.title);
    const body = attachmentBody(log);
    if (line === undefined || body === undefined) return;
    warn(line);
    await outcome.attach(PAGE_LOAD_ATTACHMENT, {
      body,
      contentType: "text/plain",
    });
  } catch {
    warn(
      `[page-loads] could not report the failed requests of "${plain(outcome.title)}".`,
    );
  }
}
