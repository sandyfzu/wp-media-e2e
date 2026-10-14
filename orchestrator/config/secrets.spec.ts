import { test, expect } from "@playwright/test";

import type { CheckedTask } from "./check";
import {
  allSecretValues,
  hostSecretForms,
  secretValues,
  siteSecretValues,
} from "./secrets";

/** A Slack incoming webhook, as Slack gives it. */
const WEBHOOK = "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXX";

test.describe("secretValues", () => {
  test("lists the runs' secrets, the webhook whole, its path and its token alone, and Datator's key", () => {
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
      "XXXXXXXXXXXXXXXX",
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

/**
 * A cell of one SSH site.
 *
 * @param password - its WordPress password.
 * @param overrides - its storage overrides.
 * @param host - its SSH host, as written.
 * @returns the task's cell, as the checks join it.
 */
function cellOf(
  password: string,
  overrides?: CheckedTask["cell"]["sites"][number]["overrides"],
  host = "qa",
): Pick<CheckedTask, "cell"> {
  return {
    cell: {
      sites: [
        {
          baseURL: "https://a.qa.test",
          username: "admin",
          password,
          transport: {
            mode: "ssh",
            host,
            username: "u",
            privateKeyPath: "/k",
            rootDir: "/w",
          },
          ...(overrides === undefined ? {} : { overrides }),
        },
      ],
    },
  };
}

test.describe("siteSecretValues", () => {
  test("lists each site's password, FTP password and S3 keys, each once, none empty", () => {
    expect(
      siteSecretValues([
        cellOf("wp-pass-0001", {
          storage: {
            ftp: { password: "ftp-0002", host: "f" },
            s3: { accessKeyId: "id-0003", secretAccessKey: "", bucket: "b" },
          },
        }),
        cellOf("wp-pass-0001"),
        cellOf("wp-pass-0004", {
          storage: { s3: { secretAccessKey: "sk-5" } },
        }),
      ]),
    ).toEqual(["wp-pass-0001", "ftp-0002", "id-0003", "wp-pass-0004", "sk-5"]);
  });

  test("lists nothing without tasks", () => {
    expect(siteSecretValues([])).toEqual([]);
  });
});

test.describe("allSecretValues", () => {
  test("the config's first, then the sites', each once", () => {
    expect(
      allSecretValues(
        {
          secrets: { GITHUB_TOKEN: "same-value" },
          notifications: {
            datator: { url: "https://d.test/", apiKey: "k3y-value" },
          },
        },
        [cellOf("same-value"), cellOf("wp-pass-0001")],
      ),
    ).toEqual(["same-value", "k3y-value", "wp-pass-0001"]);
  });
});

test.describe("hostSecretForms", () => {
  test("an SSH host holding a secret, lowercased; none for a host without one, already lowercase, or a short secret", () => {
    const tasks = [
      cellOf("pw", undefined, "QA-Host-Secret-0009.test"),
      cellOf("pw", undefined, "QA-LNMP"),
      cellOf("pw", undefined, "lower-host-secret-0009"),
      cellOf("pw", undefined, "SHORT-Ab1"),
    ];
    expect(
      hostSecretForms(tasks, ["Host-Secret-0009", "host-secret-0009", "Ab1"]),
    ).toEqual(["qa-host-secret-0009.test"]);
  });

  test("allSecretValues adds them, and never a secret merely lowercased", () => {
    const all = allSecretValues({ secrets: { BWP_X: "BackWPup1" } }, [
      cellOf("Site-Pass-0001", undefined, "Site-Pass-0001.Host"),
    ]);
    expect(all).toEqual(["BackWPup1", "Site-Pass-0001", "site-pass-0001.host"]);
    expect(all).not.toContain("backwpup1");
  });
});
