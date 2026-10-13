import { test, expect } from "@playwright/test";

import { secretValues } from "./secrets";

/** A Slack incoming webhook, as Slack gives it. */
const WEBHOOK = "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXX";

test.describe("secretValues", () => {
  test("lists the runs' secrets, the webhook whole and its path alone, and Datator's key", () => {
    expect(
      secretValues({
        secrets: { GITHUB_TOKEN: "ghp_x", BWP_FTP_PASSWORD: " pass word " },
        notifications: {
          slack: { webhookUrl: WEBHOOK },
          datator: { url: "https://datator.test/r/", apiKey: "k3y-value" },
        },
      }),
    ).toEqual([
      "ghp_x",
      " pass word ",
      WEBHOOK,
      "/services/T000/B000/XXXXXXXXXXXXXXXX",
      "k3y-value",
    ]);
  });

  test("lists each value once", () => {
    expect(
      secretValues({ secrets: { GITHUB_TOKEN: "same", GH_TOKEN: "same" } }),
    ).toEqual(["same"]);
  });

  test("lists nothing for a config without secrets or notifications", () => {
    expect(secretValues({})).toEqual([]);
    expect(secretValues({ notifications: {} })).toEqual([]);
  });
});
