import { test, expect } from "@playwright/test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { flushObjectCache } from "./cache";
import type { LocalTransport } from "../config/types";

/**
 * `flushObjectCache` is defined by what it does with **failure**, so that is what these cover: the
 * three ways a flush can go, and the promise that none of them throws. A stub `wp` on PATH gives
 * deterministic exit codes with no WordPress involved.
 */
const STUB_WP = `#!/usr/bin/env bash
# $WP_STUB_CACHE_MODE: ok | refuse
#   ok     → exit 0, the way real WP-CLI answers both a flushed drop-in and a site with none
#   refuse → exit 1 with WP-CLI's own wording for a drop-in that returned false
if [ "$1 $2" = "cache flush" ] && [ "$WP_STUB_CACHE_MODE" = "refuse" ]; then
  echo "Error: The object cache could not be flushed." >&2
  exit 1
fi
exit 0
`;

let local: LocalTransport;
let stubDir: string;
let originalPath: string;

/** Captures `console.warn` so a test can assert on it, and so the suite's output stays readable. */
function captureWarnings(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.warn = original;
    },
  };
}

test.beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), "wp-cache-stub-"));
  writeFileSync(join(stubDir, "wp"), STUB_WP);
  chmodSync(join(stubDir, "wp"), 0o755);
  // The stub ignores cwd; rootDir only has to be a real directory for the exec layer.
  local = { mode: "local", rootDir: stubDir };
  originalPath = process.env.PATH ?? "";
  process.env.PATH = `${stubDir}:${originalPath}`;
});

test.afterAll(() => {
  process.env.PATH = originalPath;
  rmSync(stubDir, { recursive: true, force: true });
});

test.describe("flushObjectCache", () => {
  test("reports 'flushed' when WP-CLI exits 0", async () => {
    process.env.WP_STUB_CACHE_MODE = "ok";
    const warnings = captureWarnings();
    try {
      expect(await flushObjectCache(local)).toBe("flushed");
    } finally {
      warnings.restore();
    }
    // The expected path on our own cells, where no persistent cache exists at all — so it must be
    // silent, or every scenario would print a warning about a non-problem.
    expect(warnings.lines).toEqual([]);
  });

  test("reports 'refused' and warns when the drop-in will not flush, without throwing", async () => {
    process.env.WP_STUB_CACHE_MODE = "refuse";
    const warnings = captureWarnings();
    try {
      expect(await flushObjectCache(local)).toBe("refused");
    } finally {
      warnings.restore();
    }
    expect(warnings.lines).toHaveLength(1);
    expect(warnings.lines[0]).toContain("[wp/cache]");
    // The operator needs WP-CLI's own reason, not just "it failed".
    expect(warnings.lines[0]).toContain("could not be flushed");
  });

  test("reports 'refused' when `wp` cannot run at all, without throwing", async () => {
    // The other failure mode, and the one that would otherwise escape: the exec layer *throws*
    // when a command never started, rather than returning a non-zero code.
    process.env.WP_STUB_CACHE_MODE = "ok";
    const emptyDir = mkdtempSync(join(tmpdir(), "wp-cache-nopath-"));
    process.env.PATH = emptyDir;
    const warnings = captureWarnings();
    try {
      expect(await flushObjectCache(local)).toBe("refused");
    } finally {
      warnings.restore();
      process.env.PATH = `${stubDir}:${originalPath}`;
      rmSync(emptyDir, { recursive: true, force: true });
    }
    expect(warnings.lines).toHaveLength(1);
    expect(warnings.lines[0]).toContain("[wp/cache]");
  });
});
