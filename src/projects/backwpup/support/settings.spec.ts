import { test, expect } from "@playwright/test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { jobSettingValue, setJobSetting } from "./settings";
import type { LocalTransport } from "../../../common/config/types";

// A stub `wp` on PATH: `eval` keeps the snippet it was handed, so a case can decode what it would
// have written; `option get` answers with whatever the case says the site now holds.
const STUB_WP = `#!/usr/bin/env bash
case "$1" in
  eval) printf '%s' "$2" > "$WP_STUB_DIR/snippet" ;;
  option) printf '%s' "$WP_STUB_STORED" ;;
esac
exit 0
`;

let binDir: string;
let stubDir: string;
let originalPath: string | undefined;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "bwp-settings-bin-"));
  stubDir = mkdtempSync(join(tmpdir(), "bwp-settings-state-"));
  const wp = join(binDir, "wp");
  writeFileSync(wp, STUB_WP);
  chmodSync(wp, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  process.env.WP_STUB_DIR = stubDir;
});

test.afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.WP_STUB_DIR;
  delete process.env.WP_STUB_STORED;
  rmSync(binDir, { recursive: true, force: true });
  rmSync(stubDir, { recursive: true, force: true });
});

/** The stub site, run from this file's own state directory. */
const local = (): LocalTransport => ({ mode: "local", rootDir: stubDir });

/** The values the last snippet embedded, decoded the way PHP will decode them. */
function embedded(): unknown[] {
  const snippet = readFileSync(join(stubDir, "snippet"), "utf8");
  return [...snippet.matchAll(/base64_decode\( '([^']+)' \)/g)].map(
    (match) =>
      JSON.parse(Buffer.from(match[1] ?? "", "base64").toString()) as unknown,
  );
}

test.describe("jobSettingValue", () => {
  // The four values the screen's select offers, and what it stores for each.
  for (const [word, value] of [
    ["disabled", 0],
    ["minimum", 10_000],
    ["medium", 30_000],
    ["maximum", 90_000],
  ] as const) {
    test(`stores "Reduce server load" ${word} as ${String(value)}`, () => {
      expect(jobSettingValue("Reduce server load", word)).toEqual({
        option: "backwpup_cfg_jobwaittimems",
        value,
      });
    });
  }

  test("stores a maximum script execution time as its seconds, 0 included", () => {
    expect(
      jobSettingValue("Maximum number script execution time (in seconds)", "0"),
    ).toEqual({
      option: "backwpup_cfg_jobmaxexecutiontime",
      value: 0,
    });
    expect(
      jobSettingValue(
        "Maximum number script execution time (in seconds)",
        "300",
      ).value,
    ).toBe(300);
  });

  // A value the screen does not offer describes a site no user could have set up.
  for (const [label, word] of [
    ["Reduce server load", "fastest"],
    ["Reduce server load", "Maximum"],
    ["Maximum number script execution time (in seconds)", "301"],
    ["Maximum number script execution time (in seconds)", "-1"],
    ["Maximum number script execution time (in seconds)", "1.5"],
    ["Maximum number script execution time (in seconds)", ""],
  ] as const) {
    test(`refuses "${word}" for "${label}"`, () => {
      expect(() => jobSettingValue(label, word)).toThrow(
        /cannot be .* the screen accepts/,
      );
    });
  }

  test("refuses a setting the screen does not have, naming the ones it knows", () => {
    expect(() => jobSettingValue("Turbo mode", "on")).toThrow(
      /no job setting is labelled "Turbo mode".*Reduce server load/,
    );
  });
});

test.describe("setJobSetting", () => {
  test("writes the value into the setting's own option", async () => {
    process.env.WP_STUB_STORED = "90000";
    await setJobSetting(local(), "Reduce server load", "maximum");
    expect(readFileSync(join(stubDir, "snippet"), "utf8")).toContain(
      "update_site_option(",
    );
    expect(embedded()).toEqual(["backwpup_cfg_jobwaittimems", 90_000]);
  });

  // The write's own request answers from its cache, so only a second request can confirm it.
  test("fails when the site does not hold the value afterwards", async () => {
    process.env.WP_STUB_STORED = "30";
    await expect(
      setJobSetting(
        local(),
        "Maximum number script execution time (in seconds)",
        "0",
      ),
    ).rejects.toThrow(
      /should now be stored as 0 in backwpup_cfg_jobmaxexecutiontime, but the site holds "30"/,
    );
  });
});
