import { test, expect } from "@playwright/test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getOption, getOptionJson } from "./options";
import type { LocalTransport } from "../config/types";

// A stub `wp` on PATH exercises the readers plus the real exec layer, with no WordPress. The
// scenario is chosen per test via $WP_STUB_MODE; `not-set` reproduces WP-CLI's own wording for a
// missing option, which is the only non-zero exit these readers treat as an answer.
const STUB_WP = `#!/usr/bin/env bash
case "$WP_STUB_MODE" in
  value)     printf 'wp_' ;;
  empty)     printf '' ;;
  json)      printf '%s' '{"0":{"jobid":1},"2":{"jobid":3}}' ;;
  json-list) printf '%s' '[{"jobid":1}]' ;;
  json-bad)  printf 'not json at all' ;;
  not-set)   printf "Error: Could not get 'missing_option' option. Does it exist?" >&2; exit 1 ;;
  broken)    printf 'Error: Error establishing a database connection.' >&2; exit 1 ;;
esac
exit 0
`;

let binDir: string;
let rootDir: string;
let originalPath: string | undefined;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "wp-opt-stub-bin-"));
  rootDir = mkdtempSync(join(tmpdir(), "wp-opt-stub-root-"));
  const wp = join(binDir, "wp");
  writeFileSync(wp, STUB_WP);
  chmodSync(wp, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
});

test.afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(binDir, { recursive: true, force: true });
  rmSync(rootDir, { recursive: true, force: true });
});

const local = (): LocalTransport => ({ mode: "local", rootDir });

test.describe("getOption", () => {
  test("returns the option's raw value", async () => {
    process.env.WP_STUB_MODE = "value";
    expect(await getOption(local(), "table_prefix")).toBe("wp_");
  });

  // "present but empty" and "absent" are different states, and a plugin can rely on either.
  test("an option set to an empty string is not the same as absent", async () => {
    process.env.WP_STUB_MODE = "empty";
    expect(await getOption(local(), "blank")).toBe("");
  });

  test("a missing option reads as undefined, not as an error", async () => {
    process.env.WP_STUB_MODE = "not-set";
    expect(await getOption(local(), "missing_option")).toBeUndefined();
  });

  // The failure this API exists to keep distinct: a site that cannot answer must never be reported
  // as a site where the option is simply unset.
  test("a WordPress that cannot boot throws rather than reading as absent", async () => {
    process.env.WP_STUB_MODE = "broken";
    await expect(getOption(local(), "anything")).rejects.toThrow(
      /database connection/,
    );
  });
});

test.describe("getOptionJson", () => {
  // WP-CLI emits a PHP array as a JSON *object* as soon as its keys are not a 0-based sequence —
  // which is what a plugin deleting an entry from the middle of a list produces.
  test("decodes a sparse PHP array as an object", async () => {
    process.env.WP_STUB_MODE = "json";
    expect(
      await getOptionJson<Record<string, { jobid: number }>>(
        local(),
        "backwpup_jobs",
      ),
    ).toEqual({ "0": { jobid: 1 }, "2": { jobid: 3 } });
  });

  test("decodes a packed PHP array as an array", async () => {
    process.env.WP_STUB_MODE = "json-list";
    expect(
      await getOptionJson<{ jobid: number }[]>(local(), "backwpup_jobs"),
    ).toEqual([{ jobid: 1 }]);
  });

  test("a missing option reads as undefined", async () => {
    process.env.WP_STUB_MODE = "not-set";
    expect(await getOptionJson(local(), "missing_option")).toBeUndefined();
  });

  test("output that is not JSON throws instead of reading as unset", async () => {
    process.env.WP_STUB_MODE = "json-bad";
    await expect(getOptionJson(local(), "broken")).rejects.toThrow(
      /did not decode as JSON/,
    );
  });
});
