import { expect, test } from "@playwright/test";
import type { Route } from "@playwright/test";

import {
  MAX_LISTED_FAILURES,
  PAGE_LOAD_ATTACHMENT,
  PageLoadLog,
  attachmentBody,
  failedRequest,
  failedResponse,
  reportPageLoads,
  sameOriginPath,
  siteOrigin,
  summaryLine,
  watchPageLoads,
} from "./page-loads";
import type {
  PageLoadFailure,
  RequestLike,
  ScenarioOutcome,
} from "./page-loads";

const ORIGIN = "https://wp.example.test";

/** A request as Playwright hands it to `requestfailed`, with only what the module reads. */
function request(
  overrides: Partial<{
    url: string;
    method: string;
    type: string;
    error: string | null;
    navigation: boolean;
    frame: string | (() => never);
  }> = {},
): RequestLike {
  const o = {
    url: `${ORIGIN}/wp-includes/js/jquery/jquery.min.js?ver=3.7.1`,
    method: "GET",
    type: "script",
    error: "net::ERR_CONNECTION_CLOSED" as string | null,
    navigation: false,
    frame: `${ORIGIN}/wp-admin/admin.php?page=backwpup` as
      string | (() => never),
    ...overrides,
  };
  return {
    url: () => o.url,
    method: () => o.method,
    resourceType: () => o.type,
    failure: () => (o.error === null ? null : { errorText: o.error }),
    isNavigationRequest: () => o.navigation,
    frame: () => {
      if (typeof o.frame === "function") return o.frame();
      const url = o.frame;
      return { url: () => url };
    },
  };
}

/** A failure as the module records it. */
function failure(
  n: number,
  reason = "net::ERR_CONNECTION_CLOSED",
): PageLoadFailure {
  return {
    page: "/p",
    method: "GET",
    resourceType: "script",
    url: `/a${String(n)}.js`,
    reason,
  };
}

/** A `TestInfo` stand-in recording what was attached. */
function outcome(
  status: string,
  expectedStatus = "passed",
): ScenarioOutcome & {
  attached: { name: string; body: string }[];
} {
  const attached: { name: string; body: string }[] = [];
  return {
    title: "A scenario",
    status,
    expectedStatus,
    attached,
    attach: (name, { body }) => {
      attached.push({ name, body });
      return Promise.resolve();
    },
  };
}

test.describe("siteOrigin", () => {
  test("is the origin of an http(s) site, and nothing for anything else", () => {
    expect(siteOrigin("https://wp.test:8443/sub/")).toBe(
      "https://wp.test:8443",
    );
    expect(siteOrigin("ftp://wp.test")).toBeUndefined();
    expect(siteOrigin("not a url")).toBeUndefined();
    expect(siteOrigin(undefined)).toBeUndefined();
  });
});

test.describe("sameOriginPath", () => {
  test("keeps the path and a screen's name, drops every other query value", () => {
    expect(
      sameOriginPath(
        `${ORIGIN}/wp-admin/admin.php?page=backwpuprestore&step=6&backwpup_action_nonce=1ac51b669f`,
        ORIGIN,
      ),
    ).toBe("/wp-admin/admin.php?page=backwpuprestore&step=6&…");
    expect(
      sameOriginPath(
        `${ORIGIN}/wp-includes/css/buttons.min.css?ver=7.1.3`,
        ORIGIN,
      ),
    ).toBe("/wp-includes/css/buttons.min.css?…");
    expect(sameOriginPath(`${ORIGIN}/`, ORIGIN)).toBe("/");
  });

  test("masks a restore folder's 20-hex name in the path and in a dropped file_path", () => {
    const shown = sameOriginPath(
      `${ORIGIN}/wp-content/uploads/backwpup-restore-2d7d957772c37c0e106e/x.tar?action=decompress_upload&file_path=/var/www/backwpup-restore-2d7d957772c37c0e106e/u.tar`,
      ORIGIN,
    );
    expect(shown).toBe(
      "/wp-content/uploads/backwpup-restore-***/x.tar?action=decompress_upload&…",
    );
    expect(shown).not.toContain("2d7d957772c37c0e106e");
  });

  test("drops a kept key whose value is not a screen's name", () => {
    expect(
      sameOriginPath(`${ORIGIN}/a.php?page=a%20b%3Cscript%3E`, ORIGIN),
    ).toBe("/a.php?…");
  });

  test("is nothing for another origin, a lookalike host or a non-URL", () => {
    expect(
      sameOriginPath("https://secure.gravatar.com/avatar/x", ORIGIN),
    ).toBeUndefined();
    expect(
      sameOriginPath("https://wp.example.test.evil.test/a.js", ORIGIN),
    ).toBeUndefined();
    expect(
      sameOriginPath("http://wp.example.test/a.js", ORIGIN),
    ).toBeUndefined();
    expect(sameOriginPath("::", ORIGIN)).toBeUndefined();
  });

  test("is one bounded line", () => {
    const shown = sameOriginPath(`${ORIGIN}/${"z".repeat(1000)}`, ORIGIN) ?? "";
    expect(shown.length).toBeLessThanOrEqual(300);
    expect(shown.endsWith("…")).toBe(true);
  });
});

test.describe("failedRequest / failedResponse", () => {
  test("a lost script of the site is recorded with its page", () => {
    expect(failedRequest(request(), ORIGIN)).toEqual({
      page: "/wp-admin/admin.php?page=backwpup",
      method: "GET",
      resourceType: "script",
      url: "/wp-includes/js/jquery/jquery.min.js?…",
      reason: "net::ERR_CONNECTION_CLOSED",
    });
  });

  test("a lost document is its own page", () => {
    const lost = failedRequest(
      request({
        url: `${ORIGIN}/wp-admin/admin.php?page=backwpup`,
        type: "document",
        navigation: true,
        error: "net::ERR_QUIC_PROTOCOL_ERROR.QUIC_PUBLIC_RESET",
      }),
      ORIGIN,
    );
    expect(lost?.page).toBe("/wp-admin/admin.php?page=backwpup");
  });

  test("a cancellation, another origin's loss and a frame-less request", () => {
    expect(
      failedRequest(request({ error: "net::ERR_ABORTED" }), ORIGIN),
    ).toBeUndefined();
    expect(
      failedRequest(request({ url: "https://fonts.example/f.woff" }), ORIGIN),
    ).toBeUndefined();
    const workerRequest = request({
      frame: () => {
        throw new Error(
          "Service Worker requests do not have an associated frame.",
        );
      },
    });
    expect(failedRequest(workerRequest, ORIGIN)?.page).toBe("(unknown page)");
  });

  test("a 5xx counts only for a document, script or stylesheet", () => {
    const answer = (status: number, type: string) => ({
      status: () => status,
      request: () => request({ type, error: null }),
    });
    expect(failedResponse(answer(502, "stylesheet"), ORIGIN)?.reason).toBe(
      "HTTP 502",
    );
    expect(failedResponse(answer(500, "document"), ORIGIN)?.reason).toBe(
      "HTTP 500",
    );
    expect(failedResponse(answer(499, "script"), ORIGIN)).toBeUndefined();
    expect(failedResponse(answer(503, "fetch"), ORIGIN)).toBeUndefined();
  });
});

test.describe("PageLoadLog and its report", () => {
  test("lists the first failures, counts every one, and ranks reasons", () => {
    const log = new PageLoadLog();
    for (let n = 0; n < MAX_LISTED_FAILURES + 5; n++) log.record(failure(n));
    log.record(failure(999, "HTTP 502"));
    expect(log.total).toBe(MAX_LISTED_FAILURES + 6);
    expect(log.failures).toHaveLength(MAX_LISTED_FAILURES);
    expect(log.byReason).toEqual([
      ["net::ERR_CONNECTION_CLOSED", MAX_LISTED_FAILURES + 5],
      ["HTTP 502", 1],
    ]);
    expect(attachmentBody(log)).toContain(
      `(the first ${String(MAX_LISTED_FAILURES)} listed)`,
    );
  });

  test("the line names the count, the top reasons and the attachment", () => {
    const log = new PageLoadLog();
    for (const reason of ["a", "a", "b", "c", "d"])
      log.record(failure(1, reason));
    expect(summaryLine(log, "Restore\nit")).toBe(
      `[page-loads] "Restore it": 5 of the site's own requests failed (2 a, 1 b, 1 c, …). A page ` +
        `missing its own scripts or styles fails on whatever it then cannot do; listed in the ` +
        `"${PAGE_LOAD_ATTACHMENT}" attachment.`,
    );
    expect(summaryLine(new PageLoadLog(), "x")).toBeUndefined();
    expect(attachmentBody(new PageLoadLog())).toBeUndefined();
  });

  test("a failed scenario with losses warns once and attaches; a passing or clean one stays quiet", async () => {
    const log = new PageLoadLog();
    log.record(failure(1));
    const lines: string[] = [];
    const failed = outcome("timedOut");
    await reportPageLoads(log, failed, (line) => lines.push(line));
    expect(lines).toHaveLength(1);
    expect(failed.attached.map((a) => a.name)).toEqual([PAGE_LOAD_ATTACHMENT]);

    const passed = outcome("passed");
    await reportPageLoads(log, passed, (line) => lines.push(line));
    const clean = outcome("failed");
    await reportPageLoads(new PageLoadLog(), clean, (line) => lines.push(line));
    expect(lines).toHaveLength(1);
    expect([...passed.attached, ...clean.attached]).toEqual([]);
  });

  test("an attachment that fails is a warning, never a throw", async () => {
    const log = new PageLoadLog();
    log.record(failure(1));
    const lines: string[] = [];
    const broken: ScenarioOutcome = {
      ...outcome("failed"),
      attach: () => Promise.reject(new Error("disk full")),
    };
    await reportPageLoads(log, broken, (line) => lines.push(line));
    expect(lines.at(-1)).toBe(
      '[page-loads] could not report the failed requests of "A scenario".',
    );
  });
});

test.describe("watchPageLoads in a real browser", () => {
  test("records the site's own lost script, its 5xx stylesheet and a lost REST call, nothing else", async ({
    page,
  }) => {
    await page.route("**/*", async (route: Route) => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) return route.abort("connectionclosed");
      switch (url.pathname) {
        case "/wp-admin/admin.php":
          return route.fulfill({
            contentType: "text/html",
            body: `<link rel="stylesheet" href="/s.css?ver=1">
                   <link rel="stylesheet" href="https://cdn.other.test/x.css">
                   <script src="/ok.js"></script>
                   <script src="/lost.js?ver=abc"></script>
                   <script>fetch("/wp-json/backwpup/v1/backups").catch(() => {});</script>`,
          });
        case "/s.css":
          return route.fulfill({ status: 502, body: "" });
        case "/ok.js":
          return route.fulfill({ contentType: "text/javascript", body: "" });
        default:
          return route.abort("connectionclosed");
      }
    });
    const watch = watchPageLoads(page.context(), ORIGIN);
    await page.goto(
      `${ORIGIN}/wp-admin/admin.php?page=backwpup&_wpnonce=0123456789`,
    );
    // The page's fetch settles after `load`; wait for the log rather than for time.
    await expect.poll(() => watch.log.total).toBe(3);
    watch.stop();
    await page.evaluate(() => fetch("/wp-json/late").catch(() => undefined));

    expect(watch.log.total).toBe(3);
    const body = attachmentBody(watch.log) ?? "";
    expect(body).toContain("/wp-admin/admin.php?page=backwpup&…\n");
    expect(body).toContain("GET stylesheet /s.css?… — HTTP 502");
    expect(body).toContain(
      "GET script /lost.js?… — net::ERR_CONNECTION_CLOSED",
    );
    expect(body).toContain(
      "GET fetch /wp-json/backwpup/v1/backups — net::ERR_CONNECTION_CLOSED",
    );
    expect(body).not.toContain("cdn.other.test");
    expect(body).not.toContain("0123456789");
    if (process.env.SHOW_BODY) console.log(body);
  });
});
