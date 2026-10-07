import type { Page, Request, Response } from "@playwright/test";

/**
 * Watches the restore wizard's own traffic for the ways it fails without saying so on screen.
 *
 * Armed when the page object is made — before the wizard opens anything — and remembered: a failure
 * that came before a wait began must still fail that wait. Pro's first stream, for one, opens as step
 * 1 loads, long before anything waits for step 2.
 *
 *  - **A stream answered with something else.** Each streamed action sends `text/event-stream` and
 *    flushes before doing any work, so another type, or a status other than 200, means it failed
 *    before it began — and the browser's `EventSource` then closes for good, silently (one request,
 *    measured in Chromium).
 *  - **A stream asked for again.** A stream that ends without its `done` — PHP failing after the
 *    headers went out, as the registry fatal on an unwritable `restore.dat` does — is reconnected by
 *    the browser, which re-runs the action every few seconds for ever (20 requests in 6 s, measured).
 *    The wizard opens each stream once per page and closes it on `done`, so a second request on one
 *    page is that loop.
 *  - **A wizard call that failed.** Steps 2–5 `POST` `controller=job` calls (`save_strategy`,
 *    `get_strategy`, `db_test`, `fetch_url`, `save_migration`) that answer through
 *    `wp_send_json_*`; an error status or an HTML page there leaves the wizard where it is, its own
 *    failure handler then throwing instead of printing, and `success: false` is the wizard's handled
 *    failure.
 *  - **An uncaught error in the plugin's own scripts** — that failure handler's `TypeError`, for one.
 *    Errors from other plugins' scripts on the page are not the wizard's, and are left alone.
 */

/** The admin-ajax actions the wizard opens as event streams. */
export const STREAMED_ACTIONS: ReadonlySet<string> = new Set([
  "download",
  "decompress_upload",
  "restore_dir",
  "restore_db",
]);

/**
 * The streamed action a request URL opens, or `undefined` for any other request.
 *
 * @param url - the request's URL.
 */
export function streamAction(url: string): string | undefined {
  const parsed = new URL(url);
  if (!parsed.pathname.endsWith("/admin-ajax.php")) return undefined;
  const action = parsed.searchParams.get("action");
  return action !== null && STREAMED_ACTIONS.has(action) ? action : undefined;
}

/**
 * Whether a response to one of the wizard's streams is not a stream: a status other than 200, or a
 * type other than `text/event-stream` (PHP appends a charset, so it is matched as a prefix).
 *
 * @param response - any response the page received.
 */
export function isBrokenStream(
  response: Pick<Response, "url" | "status" | "headers">,
): boolean {
  if (streamAction(response.url()) === undefined) return false;
  const type = response.headers()["content-type"] ?? "";
  return response.status() !== 200 || !type.startsWith("text/event-stream");
}

/**
 * The action of one of the wizard's own calls — a form `POST` to admin-ajax carrying
 * `controller=job` — or `undefined` for any other request, WordPress's heartbeat included.
 *
 * @param request - any request the page made.
 */
export function wizardCall(
  request: Pick<Request, "method" | "url" | "headers" | "postData">,
): string | undefined {
  if (request.method() !== "POST") return undefined;
  if (!new URL(request.url()).pathname.endsWith("/admin-ajax.php")) {
    return undefined;
  }
  const type = request.headers()["content-type"] ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded")) return undefined;
  const body = new URLSearchParams(request.postData() ?? "");
  return body.get("controller") === "job"
    ? (body.get("action") ?? "(none)")
    : undefined;
}

/**
 * Why a wizard call's answer is a failure, or `undefined` when it is a success: an error status, a
 * type other than JSON, or `wp_send_json_error`'s `success: false` with its message.
 *
 * @param status - the answer's status.
 * @param type - its content type.
 * @param body - its body, or `undefined` when it could not be read.
 */
export function wizardCallFailure(
  status: number,
  type: string,
  body: string | undefined,
): string | undefined {
  if (status >= 400) return `status ${String(status)}`;
  if (!type.startsWith("application/json")) {
    return `${type || "no type"} instead of JSON — PHP likely failed; see debug.log`;
  }
  if (body === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "a body that is not JSON";
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "success" in parsed &&
    parsed.success === false
  ) {
    const data = "data" in parsed ? parsed.data : undefined;
    const message =
      typeof data === "object" &&
      data !== null &&
      "message" in data &&
      typeof data.message === "string"
        ? data.message
        : "no message";
    return `success: false (${message})`;
  }
  return undefined;
}

/**
 * Whether an uncaught page error was thrown by the plugin's own scripts — either edition's directory,
 * never a neighbour such as `backwpup-helper` — by its stack.
 *
 * @param error - the error the page raised.
 */
export function isPluginError(error: Pick<Error, "stack">): boolean {
  return /\/wp-content\/plugins\/backwpup(?:-pro)?\//.test(error.stack ?? "");
}

/**
 * The watch itself: listeners on the page, and the first failure they saw.
 */
export class WizardWatch {
  /** Requests for each streamed action since the main frame last navigated. */
  private readonly streams = new Map<string, number>();

  /** Rejects with the first failure seen, its message a bare reason for a wait to quote; never resolves. */
  readonly failed: Promise<never>;

  /** Rejects {@link WizardWatch.failed}, once. */
  private reject: (error: Error) => void = () => undefined;

  /** Whether a failure has been seen. */
  private tripped = false;

  /**
   * @param page - the wizard's page; listened to from now on, for as long as it lives.
   */
  constructor(page: Page) {
    this.failed = new Promise<never>((_, reject) => {
      this.reject = reject;
    });
    // Handled here so a failure nobody is waiting for is never an unhandled rejection; a wait races
    // the same promise and so still sees it.
    this.failed.catch(() => undefined);
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.streams.clear();
    });
    page.on("request", (request) => {
      this.onRequest(request);
    });
    page.on("response", (response) => {
      void this.onResponse(response);
    });
    page.on("pageerror", (error) => {
      if (isPluginError(error)) {
        this.fail(`the plugin's script threw: ${error.message}`);
      }
    });
  }

  /** Counts a stream request, failing on the second for one action on one page. */
  private onRequest(request: Request): void {
    const action = streamAction(request.url());
    if (action === undefined) return;
    const seen = (this.streams.get(action) ?? 0) + 1;
    this.streams.set(action, seen);
    if (seen === 2) {
      this.fail(
        `the "${action}" stream was opened again on the same page — the browser reconnects only a ` +
          "stream that ended without finishing, so PHP likely failed mid-stream; see debug.log",
      );
    }
  }

  /** Fails on a broken stream or a failed wizard call. */
  private async onResponse(response: Response): Promise<void> {
    if (isBrokenStream(response)) {
      const action = streamAction(response.url()) ?? "?";
      this.fail(
        `the "${action}" stream answered ${String(response.status())} ` +
          `${response.headers()["content-type"] ?? "(no type)"} instead of an event stream — PHP ` +
          "likely failed; see debug.log",
      );
      return;
    }
    const call = wizardCall(response.request());
    if (call === undefined) return;
    const body = await response.text().catch(() => undefined);
    const failure = wizardCallFailure(
      response.status(),
      response.headers()["content-type"] ?? "",
      body,
    );
    if (failure !== undefined) {
      this.fail(`the wizard's "${call}" call answered with ${failure}`);
    }
  }

  /** Records the first failure. */
  private fail(reason: string): void {
    if (this.tripped) return;
    this.tripped = true;
    this.reject(new Error(reason));
  }
}
