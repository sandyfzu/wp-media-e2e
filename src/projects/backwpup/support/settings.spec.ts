import { test, expect } from "@playwright/test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ENCRYPTION_OPTIONS,
  jobSettingValue,
  saveEncryptionKey,
  setJobSetting,
} from "./settings";
import type { LocalTransport } from "../../../common/config/types";

// A stub `wp` on PATH: `eval` keeps the snippet it was handed, so a case can decode what it would
// have written; `option get` answers with whatever the case says the site now holds.
const STUB_WP = `#!/usr/bin/env bash
case "$1" in
  eval)
    printf '%s' "$2" > "$WP_STUB_DIR/snippet"
    count=$(( $(cat "$WP_STUB_DIR/count" 2>/dev/null || echo 0) + 1 ))
    printf '%s' "$count" > "$WP_STUB_DIR/count"
    printf '%s' "$2" > "$WP_STUB_DIR/snippet-$count"
    case "$2" in *hash_equals*) printf '%s' "$WP_STUB_READBACK" ;; esac ;;
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
  delete process.env.WP_STUB_READBACK;
  rmSync(binDir, { recursive: true, force: true });
  rmSync(stubDir, { recursive: true, force: true });
});

/** The stub site, run from this file's own state directory. */
const local = (): LocalTransport => ({ mode: "local", rootDir: stubDir });

/** The values a snippet embedded — the last one by default — decoded the way PHP will decode them. */
function embedded(file = "snippet"): unknown[] {
  const snippet = readFileSync(join(stubDir, file), "utf8");
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

test.describe("saveEncryptionKey", () => {
  const KEY = "3f".repeat(32);
  const HELD = JSON.stringify({
    type: "symmetric",
    archive_encryption: false,
    key: true,
  });

  test.beforeEach(() => {
    rmSync(join(stubDir, "count"), { force: true });
    process.env.WP_STUB_READBACK = HELD;
  });

  // The three options EncryptionSettingUpdater::update() stores for a symmetric key given and the
  // "encryption activated" switch left off.
  test("stores the type, archive encryption off and the key, as the Encryption panel saves them", async () => {
    await saveEncryptionKey(local(), KEY);
    const write = readFileSync(join(stubDir, "snippet-1"), "utf8");
    expect(write).toMatch(
      /^update_site_option\( .+, 'symmetric' \);\nupdate_site_option\( .+, false \);\nupdate_site_option\( .+, .+ \);$/,
    );
    expect(embedded("snippet-1")).toEqual([
      ENCRYPTION_OPTIONS.type,
      ENCRYPTION_OPTIONS.archiveEncryption,
      ENCRYPTION_OPTIONS.key,
      KEY,
    ]);
  });

  // The write's own request answers from its cache; the key is compared where it is stored.
  test("reads all three back by a second request, comparing the key on the site", async () => {
    await saveEncryptionKey(local(), KEY);
    const read = readFileSync(join(stubDir, "snippet-2"), "utf8");
    expect(read).toContain("'archive_encryption' => (bool) get_site_option(");
    expect(read).toContain("'key' => hash_equals(");
    expect(embedded("snippet-2")).toEqual([
      ENCRYPTION_OPTIONS.type,
      ENCRYPTION_OPTIONS.archiveEncryption,
      KEY,
      ENCRYPTION_OPTIONS.key,
    ]);
  });

  for (const held of [
    { type: false, archive_encryption: false, key: true },
    { type: "asymmetric", archive_encryption: false, key: true },
    { type: "symmetric", archive_encryption: true, key: true },
    { type: "symmetric", archive_encryption: false, key: false },
  ]) {
    test(`fails when the site does not hold what was saved (${JSON.stringify(held)}), without quoting the key`, async () => {
      process.env.WP_STUB_READBACK = JSON.stringify(held);
      const failure = saveEncryptionKey(local(), KEY);
      await expect(failure).rejects.toThrow(
        /should now hold a symmetric encryption type, archive encryption off and the key saved/,
      );
      await failure.catch((error: unknown) => {
        expect(String(error)).not.toContain(KEY);
      });
    });
  }

  test("refuses a read-back that is not JSON", async () => {
    process.env.WP_STUB_READBACK = "Warning: x";
    await expect(saveEncryptionKey(local(), KEY)).rejects.toThrow(
      /did not come back as JSON/,
    );
  });

  // Anything else the panel would store differently, or the commands could not use as it is.
  for (const [what, key] of [
    ["32 hex characters", "3f".repeat(16)],
    ["upper-case hex", "3F".repeat(32)],
    ["66 hex characters", "3f".repeat(33)],
    ["not hex", "zz".repeat(32)],
    ["empty", ""],
  ] as const) {
    test(`refuses a key the panel would not save as it is (${what}), before asking the site`, async () => {
      await expect(saveEncryptionKey(local(), key)).rejects.toThrow(
        /64 lower-case hex characters/,
      );
      expect(existsSync(join(stubDir, "count"))).toBe(false);
    });
  }
});
