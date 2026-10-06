import { test, expect } from "@playwright/test";

import {
  STREAMED_ACTIONS,
  isBrokenStream,
  isPluginError,
  streamAction,
  wizardCall,
  wizardCallFailure,
} from "./wizard-watch";

/**
 * The restore wizard's traffic, judged request by request. The watch that applies these to a live
 * page is driven against the captured wizard in `restore.wizard.spec.ts`; here each judgement is
 * pinned on its own, against plain request and response shapes.
 */

const AJAX = "http://bwp.test/wp-admin/admin-ajax.php";

/** Headers holding a content type, or none. */
function headers(type: string | undefined): Record<string, string> {
  return type === undefined ? {} : { "content-type": type };
}

/** A response as the judgements read one. */
function response(
  url: string,
  status: number,
  type: string | undefined,
): { url(): string; status(): number; headers(): Record<string, string> } {
  return {
    url: () => url,
    status: () => status,
    headers: () => headers(type),
  };
}

/** A request as {@link wizardCall} reads one. */
function request(
  method: string,
  url: string,
  type: string | undefined,
  body: string | null,
): {
  method(): string;
  url(): string;
  headers(): Record<string, string>;
  postData(): string | null;
} {
  return {
    method: () => method,
    url: () => url,
    headers: () => headers(type),
    postData: () => body,
  };
}

test.describe("streamAction", () => {
  test("names each streamed action the wizard opens, and nothing else", () => {
    for (const action of STREAMED_ACTIONS) {
      expect(
        streamAction(`${AJAX}?action=${action}&context=event_source`),
      ).toBe(action);
    }
    expect([...STREAMED_ACTIONS].sort()).toEqual([
      "decompress_upload",
      "download",
      "restore_db",
      "restore_dir",
    ]);
    for (const url of [
      `${AJAX}?action=heartbeat`,
      `${AJAX}?action=upload`,
      AJAX,
      "http://bwp.test/wp-admin/admin.php?page=backwpuprestore&action=download",
    ]) {
      expect(streamAction(url), url).toBeUndefined();
    }
  });
});

test.describe("isBrokenStream", () => {
  // PHP appends a charset to every text type; a stream answered so is healthy.
  test("passes a stream, with or without a charset", () => {
    for (const type of [
      "text/event-stream",
      "text/event-stream; charset=UTF-8",
    ]) {
      expect(
        isBrokenStream(response(`${AJAX}?action=restore_dir`, 200, type)),
      ).toBe(false);
    }
  });

  test("flags a stream answered with another type, no type, or another status", () => {
    for (const [status, type] of [
      [200, "text/html; charset=UTF-8"],
      [200, undefined],
      [500, "text/event-stream"],
      [403, "text/html"],
    ] as const) {
      expect(
        isBrokenStream(response(`${AJAX}?action=download`, status, type)),
        `${String(status)} ${String(type)}`,
      ).toBe(true);
    }
  });

  test("leaves every other request alone", () => {
    expect(
      isBrokenStream(response(`${AJAX}?action=heartbeat`, 500, "text/html")),
    ).toBe(false);
    expect(
      isBrokenStream(
        response(
          "http://bwp.test/wp-admin/admin.php?page=backwpuprestore&action=download",
          200,
          "text/html",
        ),
      ),
    ).toBe(false);
  });
});

test.describe("wizardCall", () => {
  const FORM = "application/x-www-form-urlencoded; charset=UTF-8";

  test("names the action of a wizard call", () => {
    expect(
      wizardCall(
        request(
          "POST",
          AJAX,
          FORM,
          "controller=job&action=save_strategy&strategy=x",
        ),
      ),
    ).toBe("save_strategy");
  });

  test("leaves the heartbeat, other controllers, other methods and uploads alone", () => {
    for (const [method, url, type, body] of [
      ["POST", AJAX, FORM, "action=heartbeat&data=x"],
      ["POST", AJAX, FORM, "controller=decrypt&action=decrypt"],
      ["GET", `${AJAX}?controller=job&action=get_strategy`, undefined, null],
      ["POST", AJAX, "multipart/form-data; boundary=x", "controller=job"],
      [
        "POST",
        "http://bwp.test/wp-admin/admin.php",
        FORM,
        "controller=job&action=x",
      ],
    ] as const) {
      expect(
        wizardCall(request(method, url, type, body)),
        `${method} ${body ?? ""}`,
      ).toBe(undefined);
    }
  });
});

test.describe("wizardCallFailure", () => {
  const JSON_TYPE = "application/json; charset=UTF-8";

  test("passes a JSON success", () => {
    expect(
      wizardCallFailure(
        200,
        JSON_TYPE,
        '{"success":true,"data":{"message":""}}',
      ),
    ).toBeUndefined();
    expect(wizardCallFailure(200, JSON_TYPE, undefined)).toBeUndefined();
  });

  test("names an error status, an HTML page, a body that is no JSON, and success: false", () => {
    expect(wizardCallFailure(500, JSON_TYPE, "{}")).toBe("status 500");
    expect(
      wizardCallFailure(200, "text/html", "<p>critical error</p>"),
    ).toMatch(/^text\/html instead of JSON/);
    expect(wizardCallFailure(200, JSON_TYPE, "<p>")).toBe(
      "a body that is not JSON",
    );
    expect(
      wizardCallFailure(
        200,
        JSON_TYPE,
        '{"success":false,"data":{"state":"error","message":"No database"}}',
      ),
    ).toBe("success: false (No database)");
    expect(wizardCallFailure(200, JSON_TYPE, '{"success":false}')).toBe(
      "success: false (no message)",
    );
  });
});

test.describe("isPluginError", () => {
  test("is the plugin's when its scripts are on the stack, either edition", () => {
    for (const slug of ["backwpup", "backwpup-pro"]) {
      expect(
        isPluginError({
          stack: `TypeError: x\n    at Object.onFail (https://site/wp-content/plugins/${slug}/vendor/inpsyde/backwpup-restore-shared/resources/js/strategy.min.js?ver=1:1:9)`,
        }),
      ).toBe(true);
    }
  });

  test("is not when only another plugin's, or nothing, is", () => {
    expect(
      isPluginError({
        stack:
          "Error: y\n    at https://site/wp-content/plugins/query-monitor/x.js:1:1",
      }),
    ).toBe(false);
    expect(
      isPluginError({
        stack:
          "Error: y\n    at https://site/wp-content/plugins/backwpup-helper/x.js:1:1",
      }),
    ).toBe(false);
    expect(isPluginError({ stack: undefined })).toBe(false);
  });
});
