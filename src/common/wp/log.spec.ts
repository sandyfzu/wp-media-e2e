import { test, expect } from "@playwright/test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearDebugLog, readDebugLog, scanDebugLog } from "./log";
import type { LocalTransport } from "../config/types";

// Stub `wp`: `eval` echoes $WP_STUB_EVAL_OUT (exit 0), or simulates a broken WordPress bootstrap
// (exit 255) when $WP_STUB_EVAL=fail. `cat`/`rm` are NOT stubbed — the fallback uses the real
// ones — so a failing `eval` forces log.ts down its direct-file path.
const STUB_WP = `#!/usr/bin/env bash
if [ "$1" = "eval" ]; then
  if [ "$WP_STUB_EVAL" = "fail" ]; then
    echo "PHP Fatal error: simulated bootstrap failure" >&2
    exit 255
  fi
  printf '%s' "$WP_STUB_EVAL_OUT"
  exit 0
fi
exit 0
`;

let stubDir: string;
let wpRoot: string;
let originalPath: string;
let local: LocalTransport;

const debugLogPath = (): string => join(wpRoot, "wp-content", "debug.log");

test.beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), "wp-stub-"));
  writeFileSync(join(stubDir, "wp"), STUB_WP);
  chmodSync(join(stubDir, "wp"), 0o755);
  // A WP-root-like dir whose wp-content/ holds the debug.log the fallback reads/removes.
  wpRoot = mkdtempSync(join(tmpdir(), "wp-root-"));
  mkdirSync(join(wpRoot, "wp-content"));
  local = { mode: "local", rootDir: wpRoot };
  originalPath = process.env.PATH ?? "";
  process.env.PATH = `${stubDir}:${originalPath}`;
});

test.afterAll(() => {
  process.env.PATH = originalPath;
  rmSync(stubDir, { recursive: true, force: true });
  rmSync(wpRoot, { recursive: true, force: true });
});

test.describe("debug.log — primary `wp eval` path", () => {
  test("readDebugLog returns what wp eval emits", async () => {
    process.env.WP_STUB_EVAL = "ok";
    process.env.WP_STUB_EVAL_OUT = "first line\nPHP Warning: something";
    expect(await readDebugLog(local)).toBe(
      "first line\nPHP Warning: something",
    );
  });

  test("scanDebugLog categorises lines by severity tier", async () => {
    process.env.WP_STUB_EVAL = "ok";
    process.env.WP_STUB_EVAL_OUT =
      "PHP Fatal error: boom\nPHP Warning: slow\nPHP Notice: fyi\nall good";
    const scan = await scanDebugLog(local);
    expect(scan.fatals).toEqual(["PHP Fatal error: boom"]);
    expect(scan.warnings).toEqual(["PHP Warning: slow"]);
    expect(scan.notices).toEqual(["PHP Notice: fyi"]);
  });

  test("scanDebugLog `ignore` excludes matching lines from all categories", async () => {
    process.env.WP_STUB_EVAL = "ok";
    process.env.WP_STUB_EVAL_OUT =
      "PHP Notice: a\nPHP Warning: b\nPHP Fatal error: boom";
    const scan = await scanDebugLog(local, { ignore: [/Notice/, /Warning/] });
    expect(scan.notices).toEqual([]);
    expect(scan.warnings).toEqual([]);
    expect(scan.fatals).toEqual(["PHP Fatal error: boom"]);
  });

  test("scanDebugLog `source` attributes entries by path, excluding other plugins", async () => {
    process.env.WP_STUB_EVAL = "ok";
    process.env.WP_STUB_EVAL_OUT =
      "PHP Fatal error: boom in /var/www/html/wp-content/plugins/wp-rocket/inc/a.php on line 1\n" +
      "PHP Fatal error: other in /var/www/html/wp-content/plugins/backwpup/b.php on line 2\n" +
      "PHP Warning: w in /var/www/html/wp-content/plugins/wp-rocket/inc/c.php on line 3";
    const scan = await scanDebugLog(local, {
      source: [/wp-content\/plugins\/wp-rocket\//],
    });
    expect(scan.fatals).toEqual([
      "PHP Fatal error: boom in /var/www/html/wp-content/plugins/wp-rocket/inc/a.php on line 1",
    ]);
    expect(scan.warnings).toEqual([
      "PHP Warning: w in /var/www/html/wp-content/plugins/wp-rocket/inc/c.php on line 3",
    ]);
    // The BackWPup fatal is excluded by the source filter; `raw` still holds the full log.
    expect(scan.notices).toEqual([]);
    expect(scan.raw).toContain("backwpup");
  });
});

test.describe("debug.log — direct-file fallback when `wp eval` fails", () => {
  test("readDebugLog falls back to a direct read (and logs the fallback)", async () => {
    process.env.WP_STUB_EVAL = "fail"; // simulate a fatal that breaks WP bootstrap
    writeFileSync(debugLogPath(), "PHP Fatal error: captured via fallback");

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      expect(await readDebugLog(local)).toBe(
        "PHP Fatal error: captured via fallback",
      );
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((w) => w.includes("falling back"))).toBe(true);
  });

  test("readDebugLog returns '' when the file is also absent", async () => {
    process.env.WP_STUB_EVAL = "fail";
    rmSync(debugLogPath(), { force: true });
    expect(await readDebugLog(local)).toBe("");
  });

  test("clearDebugLog removes the file directly", async () => {
    process.env.WP_STUB_EVAL = "fail";
    writeFileSync(debugLogPath(), "stale contents");
    await clearDebugLog(local);
    expect(existsSync(debugLogPath())).toBe(false);
  });
});
