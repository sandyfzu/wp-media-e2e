import { test, expect } from "@playwright/test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deletePlugin,
  ensurePluginAbsent,
  isPluginActive,
  isPluginInstalled,
} from "./plugin";
import { PluginDeletionFailedError, PluginNotInstalledError } from "./errors";
import type { LocalTransport } from "../config/types";

// A stub `wp` on PATH exercises plugin.ts + the real exec layer with deterministic exit codes —
// no WordPress. Behavior is chosen per test via $WP_STUB_MODE.
const STUB_WP = `#!/usr/bin/env bash
# $WP_STUB_MODE: absent | stuck | vanishes
#   absent   → 'plugin is-installed' exits 1 (not installed)
#   stuck    → 'plugin is-installed' exits 0 (delete never removes it)
#   vanishes → installed (exit 0) until 'plugin delete' records removal via $WP_STUB_MARKER
sub="$1 $2"
case "$WP_STUB_MODE" in
  absent)
    [ "$sub" = "plugin is-installed" ] && exit 1 ;;
  stuck)
    [ "$sub" = "plugin is-installed" ] && exit 0 ;;
  vanishes)
    if [ "$sub" = "plugin is-installed" ]; then
      [ -f "$WP_STUB_MARKER" ] && exit 1 || exit 0
    fi
    if [ "$sub" = "plugin delete" ]; then
      : > "$WP_STUB_MARKER"
      exit 0
    fi ;;
esac
exit 0
`;

const local: LocalTransport = { mode: "local" };

let stubDir: string;
let originalPath: string;
let markerSeq = 0;

/** A unique, not-yet-existing marker path for a `vanishes`-mode test. */
function freshMarker(): string {
  markerSeq += 1;
  return join(stubDir, `marker-${String(markerSeq)}`);
}

test.beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), "wp-stub-"));
  writeFileSync(join(stubDir, "wp"), STUB_WP);
  chmodSync(join(stubDir, "wp"), 0o755);
  originalPath = process.env.PATH ?? "";
  process.env.PATH = `${stubDir}:${originalPath}`;
});

test.afterAll(() => {
  process.env.PATH = originalPath;
  rmSync(stubDir, { recursive: true, force: true });
});

test.describe("plugin lifecycle over a stub wp", () => {
  test("isPluginInstalled / isPluginActive reflect the exit code", async () => {
    process.env.WP_STUB_MODE = "absent";
    expect(await isPluginInstalled(local, "x")).toBe(false);
    process.env.WP_STUB_MODE = "stuck"; // is-installed → 0
    expect(await isPluginInstalled(local, "x")).toBe(true);
    expect(await isPluginActive(local, "x")).toBe(true);
  });

  test("ensurePluginAbsent is a no-op when already gone", async () => {
    process.env.WP_STUB_MODE = "absent";
    await expect(ensurePluginAbsent(local, "x")).resolves.toBeUndefined();
  });

  test("ensurePluginAbsent deletes a present plugin, then verifies it gone", async () => {
    process.env.WP_STUB_MODE = "vanishes";
    process.env.WP_STUB_MARKER = freshMarker();
    await expect(ensurePluginAbsent(local, "x")).resolves.toBeUndefined();
  });

  test("deletePlugin on an absent plugin throws PluginNotInstalledError", async () => {
    process.env.WP_STUB_MODE = "absent";
    await expect(deletePlugin(local, "x")).rejects.toBeInstanceOf(
      PluginNotInstalledError,
    );
  });

  test("deletePlugin that does not take effect throws PluginDeletionFailedError", async () => {
    process.env.WP_STUB_MODE = "stuck"; // is-installed stays 0 after delete
    await expect(deletePlugin(local, "x")).rejects.toBeInstanceOf(
      PluginDeletionFailedError,
    );
  });

  test("deletePlugin succeeds when the plugin is present then removed", async () => {
    process.env.WP_STUB_MODE = "vanishes";
    process.env.WP_STUB_MARKER = freshMarker();
    await expect(deletePlugin(local, "x")).resolves.toBeUndefined();
  });
});
