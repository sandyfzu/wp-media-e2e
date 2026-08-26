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

import {
  ensurePluginAbsent,
  ensurePluginDeactivated,
  isPluginActive,
  isPluginInstalled,
  uninstallPlugin,
} from "./plugin";
import {
  PluginDeactivationFailedError,
  PluginNotInstalledError,
  PluginUninstallFailedError,
} from "./errors";
import type { LocalTransport } from "../config/types";

// A stub `wp` on PATH exercises plugin.ts + the real exec layer with deterministic exit codes —
// no WordPress. Behavior is chosen per test via $WP_STUB_MODE. Two independent markers track
// install-state and active-state separately, so a test can observe deactivate flipping
// active → false while the plugin stays installed, ahead of a later, separate uninstall call.
const STUB_WP = `#!/usr/bin/env bash
# $WP_STUB_MODE: absent | stuck | stuck-inactive | stuck-active | vanishes
#   absent         → 'plugin is-installed'/'is-active' exit 1 (not installed, so not active either)
#   stuck          → 'plugin is-installed' exits 0 (uninstall never removes it); is-active exits 0
#   stuck-inactive → like 'stuck', but already inactive, so deactivate is a no-op
#   stuck-active   → 'plugin is-active' exits 0 always (deactivate never takes effect)
#   vanishes     → installed+active until 'plugin deactivate'/'plugin uninstall' record their
#                  effect via $WP_STUB_ACTIVE_MARKER / $WP_STUB_MARKER
[ -n "$WP_STUB_LOG" ] && printf '%s\\n' "$*" >> "$WP_STUB_LOG"
sub="$1 $2"
# $WP_STUB_CACHE_FAIL makes 'cache flush' refuse, in every mode — the flush is housekeeping that
# must never fail a removal, so it needs to be failable independently of the plugin's own state.
if [ "$sub" = "cache flush" ] && [ -n "$WP_STUB_CACHE_FAIL" ]; then
  echo "Error: The object cache could not be flushed." >&2
  exit 1
fi
case "$WP_STUB_MODE" in
  absent)
    [ "$sub" = "plugin is-installed" ] && exit 1
    [ "$sub" = "plugin is-active" ] && exit 1 ;;
  stuck)
    [ "$sub" = "plugin is-installed" ] && exit 0 ;;
  stuck-inactive)
    [ "$sub" = "plugin is-installed" ] && exit 0
    [ "$sub" = "plugin is-active" ] && exit 1 ;;
  stuck-active)
    [ "$sub" = "plugin is-installed" ] && exit 0
    [ "$sub" = "plugin is-active" ] && exit 0 ;;
  vanishes)
    if [ "$sub" = "plugin is-installed" ]; then
      [ -f "$WP_STUB_MARKER" ] && exit 1 || exit 0
    fi
    if [ "$sub" = "plugin is-active" ]; then
      [ -f "$WP_STUB_ACTIVE_MARKER" ] && exit 1 || exit 0
    fi
    if [ "$sub" = "plugin deactivate" ]; then
      : > "$WP_STUB_ACTIVE_MARKER"
      exit 0
    fi
    if [ "$sub" = "plugin uninstall" ]; then
      : > "$WP_STUB_MARKER"
      exit 0
    fi ;;
esac
exit 0
`;

let local: LocalTransport;
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
  // The stub `wp` ignores cwd; rootDir just needs to be a real directory for the exec layer.
  local = { mode: "local", rootDir: stubDir };
  originalPath = process.env.PATH ?? "";
  process.env.PATH = `${stubDir}:${originalPath}`;
});

test.afterAll(() => {
  process.env.PATH = originalPath;
  rmSync(stubDir, { recursive: true, force: true });
});

test.beforeEach(() => {
  delete process.env.WP_STUB_LOG;
  delete process.env.WP_STUB_CACHE_FAIL;
});

test.describe("plugin lifecycle over a stub wp", () => {
  test("isPluginInstalled / isPluginActive reflect the exit code", async () => {
    process.env.WP_STUB_MODE = "absent";
    expect(await isPluginInstalled(local, "x")).toBe(false);
    process.env.WP_STUB_MODE = "stuck"; // is-installed → 0
    expect(await isPluginInstalled(local, "x")).toBe(true);
    expect(await isPluginActive(local, "x")).toBe(true);
  });

  test("ensurePluginDeactivated is a no-op when already inactive", async () => {
    process.env.WP_STUB_MODE = "absent"; // is-active → 1 (not installed ⇒ not active)
    await expect(ensurePluginDeactivated(local, "x")).resolves.toBeUndefined();
  });

  test("ensurePluginDeactivated deactivates an active plugin, then verifies it inactive", async () => {
    process.env.WP_STUB_MODE = "vanishes";
    process.env.WP_STUB_MARKER = freshMarker();
    process.env.WP_STUB_ACTIVE_MARKER = freshMarker();
    expect(await isPluginActive(local, "x")).toBe(true);
    await expect(ensurePluginDeactivated(local, "x")).resolves.toBeUndefined();
    expect(await isPluginActive(local, "x")).toBe(false);
  });

  test("ensurePluginDeactivated throws PluginDeactivationFailedError when deactivate has no effect", async () => {
    process.env.WP_STUB_MODE = "stuck-active"; // is-active stays 0 after deactivate
    await expect(ensurePluginDeactivated(local, "x")).rejects.toBeInstanceOf(
      PluginDeactivationFailedError,
    );
  });

  test("ensurePluginAbsent is a no-op when already gone", async () => {
    process.env.WP_STUB_MODE = "absent";
    await expect(ensurePluginAbsent(local, "x")).resolves.toBeUndefined();
  });

  test("ensurePluginAbsent uninstalls a present plugin, then verifies it gone", async () => {
    process.env.WP_STUB_MODE = "vanishes";
    process.env.WP_STUB_MARKER = freshMarker();
    process.env.WP_STUB_ACTIVE_MARKER = freshMarker();
    await expect(ensurePluginAbsent(local, "x")).resolves.toBeUndefined();
  });

  test("uninstallPlugin on an absent plugin throws PluginNotInstalledError", async () => {
    process.env.WP_STUB_MODE = "absent";
    await expect(uninstallPlugin(local, "x")).rejects.toBeInstanceOf(
      PluginNotInstalledError,
    );
  });

  test("uninstallPlugin that does not take effect throws PluginUninstallFailedError", async () => {
    process.env.WP_STUB_MODE = "stuck-inactive"; // already inactive; is-installed stays 0 after uninstall
    await expect(uninstallPlugin(local, "x")).rejects.toBeInstanceOf(
      PluginUninstallFailedError,
    );
  });

  test("uninstallPlugin succeeds when the plugin is present then removed", async () => {
    process.env.WP_STUB_MODE = "vanishes";
    process.env.WP_STUB_MARKER = freshMarker();
    process.env.WP_STUB_ACTIVE_MARKER = freshMarker();
    await expect(uninstallPlugin(local, "x")).resolves.toBeUndefined();
  });

  test("uninstallPlugin deactivates as its own call, before an `uninstall` with no --deactivate", async () => {
    // Pins down the actual bug fix: `--deactivate` must never reach `plugin uninstall`, because
    // WP-CLI would then deactivate and uninstall in the same PHP process, where the plugin's
    // main class is still loaded from that process's bootstrap — see plugin.ts's module doc.
    process.env.WP_STUB_MODE = "vanishes";
    process.env.WP_STUB_MARKER = freshMarker();
    process.env.WP_STUB_ACTIVE_MARKER = freshMarker();
    process.env.WP_STUB_LOG = freshMarker();
    await uninstallPlugin(local, "x");

    const calls = readFileSync(process.env.WP_STUB_LOG, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("plugin "));
    const deactivateIndex = calls.indexOf("plugin deactivate x");
    const uninstallIndex = calls.indexOf("plugin uninstall x");

    expect(deactivateIndex).toBeGreaterThanOrEqual(0);
    expect(uninstallIndex).toBeGreaterThan(deactivateIndex);
    expect(calls).not.toContain("plugin uninstall x --deactivate");
  });

  test("ensurePluginAbsent flushes the object cache after removing the plugin", async () => {
    // "Absent" has to mean absent to WordPress too: a plugin that clears its options with raw SQL
    // leaves a persistent cache serving rows that no longer exist. See wp/cache.ts.
    process.env.WP_STUB_MODE = "vanishes";
    process.env.WP_STUB_MARKER = freshMarker();
    process.env.WP_STUB_ACTIVE_MARKER = freshMarker();
    process.env.WP_STUB_LOG = freshMarker();
    await ensurePluginAbsent(local, "x");

    const calls = readFileSync(process.env.WP_STUB_LOG, "utf8")
      .split("\n")
      .filter((line) => line !== "");
    expect(calls).toContain("cache flush");
    expect(calls.indexOf("cache flush")).toBeGreaterThan(
      calls.indexOf("plugin uninstall x"),
    );
  });

  test("ensurePluginAbsent flushes even when the plugin was already gone", async () => {
    // The cheap path must not skip it: state that outlives a removal was not necessarily written by
    // *this* call's removal — a run killed before teardown leaves exactly that.
    process.env.WP_STUB_MODE = "absent";
    process.env.WP_STUB_LOG = freshMarker();
    await expect(ensurePluginAbsent(local, "x")).resolves.toBeUndefined();

    const calls = readFileSync(process.env.WP_STUB_LOG, "utf8").split("\n");
    expect(calls).toContain("cache flush");
    expect(calls).not.toContain("plugin uninstall x");
  });

  test("ensurePluginAbsent still succeeds when the object cache refuses to flush", async () => {
    // The whole point of the flush being best-effort: housekeeping must never turn a removal red.
    process.env.WP_STUB_MODE = "vanishes";
    process.env.WP_STUB_MARKER = freshMarker();
    process.env.WP_STUB_ACTIVE_MARKER = freshMarker();
    process.env.WP_STUB_CACHE_FAIL = "1";
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      await expect(ensurePluginAbsent(local, "x")).resolves.toBeUndefined();
    } finally {
      console.warn = originalWarn;
    }
    // Stepped over, but never silently: an operator has to be able to see which cell did this.
    expect(warnings.some((line) => line.includes("[wp/cache]"))).toBe(true);
  });
});
