import { test, expect } from "@playwright/test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DebugLogFatalError, PluginActivationFailedError } from "../wp/errors";
import { DEFAULT_STAGING_DIR, PLUGINS_CATEGORY } from "../wp/staging";
import {
  HOOK_TIMEOUT_MS,
  MAX_ATTACHED_LOG_CHARS,
  boundLogForAttachment,
  extendedTimeout,
  installPluginUnderTest,
  teardownPluginUnderTest,
} from "./plugin-lifecycle";
import type { ScenarioReport } from "./plugin-lifecycle";
import type { ResolvedArtifact } from "../artifacts/types";
import type { LocalTransport } from "../config/types";

/**
 * The `@plugin` lifecycle policy, driven end to end on the `local` transport: a real WP-root-like
 * directory, a real staged zip, and a **stateful** stub `wp` on PATH whose install/deactivate/
 * uninstall calls actually change what `is-installed` and `is-active` report. Modelling that state
 * is what makes the interesting properties provable rather than asserted by inspection — the
 * WP-CLI call order, that the install reads the *staged* path, that a fatal fails the scenario, and
 * that the debug-log verdict outranks a cleanup failure without hiding it.
 */

let stubDir: string;
let wpRoot: string;
let sourceDir: string;
let stateDir: string;
let originalPath: string;
let local: LocalTransport;
let argvFile: string;
let warnings: string[];
let errors: string[];
let realWarn: typeof console.warn;
let realError: typeof console.error;

/** Root ignores directory permissions, so the "cannot be removed" cases cannot be provoked. */
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

/**
 * Stub `wp` that records every invocation and keeps plugin state in marker files, so the
 * lifecycle's re-assertions (`is-installed` after `uninstall`) see the effect of the call before
 * them — exactly as they would on a real site.
 *
 * Switches, all via the environment:
 *  - `WP_STUB_STATE_DIR` — holds the `installed` / `active` markers.
 *  - `WP_STUB_LOG` — what an `eval` debug.log read prints.
 *  - `WP_STUB_FAIL` — an argv prefix to fail (e.g. `"plugin uninstall"`), leaving state untouched.
 *  - `WP_STUB_SILENT_ACTIVATE_FAIL` — install succeeds and exits 0, but the plugin never becomes
 *    active: the failure mode an exit code alone would miss.
 */
const STUB_WP = `#!/usr/bin/env bash
echo "$@" >> "$WP_STUB_ARGV_FILE"
if [ -n "$WP_STUB_FAIL" ] && [[ "$*" == "$WP_STUB_FAIL"* ]]; then
  echo "stub: refusing $*" >&2
  exit 1
fi
S="$WP_STUB_STATE_DIR"
case "$1 $2" in
  "plugin is-installed") [ -e "$S/installed" ] && exit 0 || exit 1 ;;
  "plugin is-active")    [ -e "$S/active" ]    && exit 0 || exit 1 ;;
  "plugin deactivate")   rm -f "$S/active"; exit 0 ;;
  "plugin uninstall")    rm -f "$S/installed" "$S/active"; exit 0 ;;
  "plugin install")
    touch "$S/installed"
    if [[ "$*" == *--activate* ]] && [ -z "$WP_STUB_SILENT_ACTIVATE_FAIL" ]; then
      touch "$S/active"
    fi
    exit 0 ;;
esac
if [ "$1" = "eval" ]; then
  case "$2" in
    *file_get_contents*) printf '%s' "$WP_STUB_LOG" ;;
  esac
fi
exit 0
`;

/** Marks the plugin as already installed and active, as a crashed earlier run would leave it. */
function seedInstalled(): void {
  writeFileSync(join(stateDir, "installed"), "");
  writeFileSync(join(stateDir, "active"), "");
}

/** True when the stub site currently has the plugin installed. */
function isInstalled(): boolean {
  return existsSync(join(stateDir, "installed"));
}

/** True when the stub site currently has the plugin active. */
function isActive(): boolean {
  return existsSync(join(stateDir, "active"));
}

/** The resolved artifact under test: a real file on the "runner", named like an APVM build. */
function artifact(): ResolvedArtifact {
  const zipPath = join(sourceDir, "backwpup-pro-en-9.99.99-abc1234.zip");
  writeFileSync(zipPath, "zip bytes");
  return {
    role: "plugin",
    slug: "backwpup-pro",
    zipPath,
    zipFilename: "backwpup-pro-en-9.99.99-abc1234.zip",
    source: "default-ref",
    origin: "built",
    resolvedAt: "2026-07-28T00:00:00.000Z",
  };
}

/** Every `wp` invocation so far, one per line. */
function wpCalls(): string[] {
  return existsSync(argvFile)
    ? readFileSync(argvFile, "utf8").trim().split("\n").filter(Boolean)
    : [];
}

/** Stand-in scenario title, asserted on so a console line is traceable to its scenario. */
const SCENARIO_TITLE = "A backup lands in the history";

/** A report sink that records attachments; `failed` mirrors a scenario's own outcome. */
function reportSink(failed = false): ScenarioReport & {
  readonly attached: Map<string, string>;
} {
  const attached = new Map<string, string>();
  return {
    title: SCENARIO_TITLE,
    failed,
    attached,
    attach: (name, body) => {
      attached.set(name, body);
      return Promise.resolve();
    },
  };
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

test.beforeEach(() => {
  wpRoot = mkdtempSync(join(tmpdir(), "wp-root-"));
  sourceDir = mkdtempSync(join(tmpdir(), "wp-src-"));
  stateDir = join(sourceDir, "state");
  mkdirSync(stateDir, { recursive: true });
  local = { mode: "local", rootDir: wpRoot };
  argvFile = join(sourceDir, "wp-argv.log");
  process.env.WP_STUB_ARGV_FILE = argvFile;
  process.env.WP_STUB_STATE_DIR = stateDir;
  delete process.env.WP_STUB_LOG;
  delete process.env.WP_STUB_FAIL;
  delete process.env.WP_STUB_SILENT_ACTIVATE_FAIL;
  warnings = [];
  errors = [];
  realWarn = console.warn;
  realError = console.error;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]): void => {
    errors.push(args.map(String).join(" "));
  };
});

test.afterEach(() => {
  console.warn = realWarn;
  console.error = realError;
  // Clear every switch this file may have set: a worker runs several spec files in turn, and
  // `WP_STUB_LOG` / `WP_STUB_FAIL` are names other stubs read too.
  for (const key of [
    "WP_STUB_ARGV_FILE",
    "WP_STUB_STATE_DIR",
    "WP_STUB_LOG",
    "WP_STUB_FAIL",
    "WP_STUB_SILENT_ACTIVATE_FAIL",
  ] as const) {
    Reflect.deleteProperty(process.env, key);
  }
  for (const dir of [wpRoot, sourceDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.describe("extendedTimeout", () => {
  test("adds room for both hooks on top of the scenario's own budget", () => {
    expect(extendedTimeout(30_000)).toBe(30_000 + 2 * HOOK_TIMEOUT_MS);
    // A scenario that asked for more keeps all of it.
    expect(extendedTimeout(600_000)).toBe(600_000 + 2 * HOOK_TIMEOUT_MS);
  });

  test("leaves 0 alone, because 0 means no timeout", () => {
    expect(extendedTimeout(0)).toBe(0);
  });
});

test.describe("boundLogForAttachment", () => {
  test("passes a normal log through untouched", () => {
    const log = "PHP Warning: something\n".repeat(10);
    expect(boundLogForAttachment(log)).toBe(log);
  });

  test("caps a runaway log, keeping the start and saying what it dropped", () => {
    // A fatal inside a loop is the realistic case: megabytes of the same line.
    const log = `PHP Fatal error:  first and only interesting line\n${"x".repeat(MAX_ATTACHED_LOG_CHARS * 2)}`;

    const bounded = boundLogForAttachment(log);

    expect(bounded.length).toBeLessThan(log.length);
    // The root cause is at the start, which is why the head is what survives.
    expect(bounded).toContain("first and only interesting line");
    expect(bounded).toContain(`of ${String(log.length)} characters`);
  });
});

test.describe("installPluginUnderTest", () => {
  test("clears the log, removes any existing copy, then installs the staged zip", async () => {
    seedInstalled();
    const resolved = artifact();

    await installPluginUnderTest(local, resolved);

    // Asserted as an ordering contract rather than an exact call list: the removal's own WP-CLI
    // sequence (deactivate as its own call, then a plain uninstall) belongs to `wp/plugin.ts` and
    // is pinned by its spec — re-pinning it here would only make this test brittle.
    const calls = wpCalls();
    // Clearing first scopes the log to this scenario yet still records the removal's own output.
    // Matched on what the call is *for*, not on the PHP it happens to run — that snippet belongs to
    // `wp/log.ts` and is pinned by its own spec.
    expect(calls[0]).toMatch(/^eval .*debug\.log/);
    const removed = calls.findIndex((c) => c.startsWith("plugin uninstall "));
    const installed = calls.findIndex((c) => c.startsWith("plugin install "));
    expect(removed).toBeGreaterThan(0);
    expect(installed).toBeGreaterThan(removed);

    const staged = join(
      wpRoot,
      DEFAULT_STAGING_DIR,
      PLUGINS_CATEGORY,
      resolved.zipFilename,
    );
    // Installed from the SITE's staged copy — a runner path means nothing to a remote `wp`.
    expect(calls[installed]).toBe(`plugin install ${staged} --activate`);
    expect(calls[installed]).not.toContain(sourceDir);
    expect(readFileSync(staged, "utf8")).toBe("zip bytes");
    // …and the hook signs off by re-asserting the state, never trusting the install's exit code.
    expect(calls.slice(installed + 1)).toEqual([
      "plugin is-active backwpup-pro",
    ]);
  });

  // The hook is what makes the product's data directories usable by *both* users sharing the
  // docroot; leaving it out let whichever user wrote first lock the other out, which surfaced as a
  // PHP fatal from the plugin rather than as anything a scenario could explain.
  test("opens the product's declared data directories after installing", async () => {
    await installPluginUnderTest(local, artifact(), [
      "wp-content/uploads/backwpup-restore",
    ]);
    const dir = join(wpRoot, "wp-content/uploads/backwpup-restore");
    expect(existsSync(dir)).toBe(true);
    expect((statSync(dir).mode & 0o777).toString(8)).toBe("777");
  });

  test("prepares nothing when the product declares no data paths", async () => {
    await installPluginUnderTest(local, artifact());
    expect(existsSync(join(wpRoot, "wp-content/uploads"))).toBe(false);
  });

  test("skips the removal entirely when the plugin is absent", async () => {
    await installPluginUnderTest(local, artifact());
    expect(
      wpCalls().filter((call) => call.startsWith("plugin uninstall")),
    ).toEqual([]);
    expect(
      wpCalls().some((c) => /^plugin install .* --activate$/.test(c)),
    ).toBe(true);
    expect(isActive()).toBe(true);
  });

  test("fails loudly when the install fails, rather than leaving a plugin-less scenario", async () => {
    process.env.WP_STUB_FAIL = "plugin install";
    await expect(installPluginUnderTest(local, artifact())).rejects.toThrow(
      /install .* failed/,
    );
  });

  test("fails when a stale copy cannot be removed, so no scenario runs on a dirty baseline", async () => {
    seedInstalled();
    process.env.WP_STUB_FAIL = "plugin uninstall";
    await expect(installPluginUnderTest(local, artifact())).rejects.toThrow(
      /still installed after uninstall/,
    );
  });

  test("fails when the plugin installs but never becomes active", async () => {
    // The failure an exit code alone would miss. It is also how a zip whose top-level directory
    // is not the promised slug shows up: `is-active <slug>` simply never becomes true.
    process.env.WP_STUB_SILENT_ACTIVATE_FAIL = "1";
    await expect(installPluginUnderTest(local, artifact())).rejects.toThrow(
      PluginActivationFailedError,
    );
  });
});

test.describe("teardownPluginUnderTest", () => {
  test("removes the plugin and attaches nothing when the log is clean", async () => {
    seedInstalled();
    const report = reportSink();

    await teardownPluginUnderTest(local, "backwpup-pro", {}, [], report);

    expect(isInstalled()).toBe(false);
    expect(report.attached.size).toBe(0);
    expect(warnings).toEqual([]);
  });

  test("fails the scenario on a PHP fatal and attaches the log", async () => {
    process.env.WP_STUB_LOG =
      "[28-Jul-2026 10:00:00 UTC] PHP Fatal error:  Uncaught Error: boom in /wp-content/plugins/backwpup-pro/x.php:12\n";

    const report = reportSink();
    const failure = await teardownPluginUnderTest(
      local,
      "backwpup-pro",
      {},
      [],
      report,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DebugLogFatalError);
    expect((failure as DebugLogFatalError).message).toContain(
      "Uncaught Error: boom",
    );
    expect(report.attached.get("debug.log")).toContain("PHP Fatal error");
  });

  test("still removes the plugin when the log gate fails", async () => {
    seedInstalled();
    process.env.WP_STUB_LOG = "PHP Parse error: syntax error\n";

    await expect(
      teardownPluginUnderTest(local, "backwpup-pro", {}, [], reportSink()),
    ).rejects.toThrow(DebugLogFatalError);

    // The fatal must not cost the next scenario its clean site.
    expect(isInstalled()).toBe(false);
  });

  test("reports warnings and notices without failing the scenario", async () => {
    process.env.WP_STUB_LOG =
      "PHP Warning:  something odd\nPHP Deprecated:  old call\n";
    const report = reportSink();

    await expect(
      teardownPluginUnderTest(local, "backwpup-pro", {}, [], report),
    ).resolves.toBeUndefined();
    // Named, so the line is traceable to its scenario when workers share a terminal.
    expect(warnings.join("\n")).toMatch(
      new RegExp(
        `debug\\.log for "${SCENARIO_TITLE}": 1 warning\\(s\\), 1 notice\\(s\\)`,
      ),
    );
    // Noise alone does not bloat the report with a log attachment.
    expect(report.attached.size).toBe(0);
  });

  test("honours the product's ignore preset", async () => {
    process.env.WP_STUB_LOG = "PHP Fatal error:  known-benign teardown race\n";
    await expect(
      teardownPluginUnderTest(
        local,
        "backwpup-pro",
        { ignore: [/known-benign/] },
        [],
        reportSink(),
      ),
    ).resolves.toBeUndefined();
  });

  test("attaches the log when the scenario failed for an unrelated reason", async () => {
    process.env.WP_STUB_LOG = "PHP Notice:  undefined index\n";
    const report = reportSink(true);

    await teardownPluginUnderTest(local, "backwpup-pro", {}, [], report);

    // The log is usually where a failing scenario's real cause is.
    expect(report.attached.get("debug.log")).toContain("PHP Notice");
  });

  test("throws a cleanup failure when it is the only failure", async () => {
    seedInstalled();
    process.env.WP_STUB_FAIL = "plugin uninstall";
    await expect(
      teardownPluginUnderTest(local, "backwpup-pro", {}, [], reportSink()),
    ).rejects.toThrow(/still installed after uninstall/);
  });

  test("prefers the fatal over a cleanup failure, but logs the cleanup failure too", async () => {
    seedInstalled();
    process.env.WP_STUB_FAIL = "plugin uninstall";
    process.env.WP_STUB_LOG = "PHP Fatal error:  the real defect\n";

    await expect(
      teardownPluginUnderTest(local, "backwpup-pro", {}, [], reportSink()),
    ).rejects.toThrow(DebugLogFatalError);
    // Secondary, but never silent.
    expect(errors.join("\n")).toMatch(/a cleanup step also failed/);
  });

  // The third duty. It exists because uninstalling a plugin does not delete what it wrote, so the
  // site would otherwise collect one copy of the product's output per scenario.
  test("clears the leftovers the product declared", async () => {
    seedInstalled();
    const leftovers = join(wpRoot, "wp-content/uploads/backwpup");
    mkdirSync(join(leftovers, "abc123/backups"), { recursive: true });
    writeFileSync(join(leftovers, "abc123/backups/site.tar"), "x");

    await teardownPluginUnderTest(
      local,
      "backwpup-pro",
      {},
      ["wp-content/uploads/backwpup"],
      reportSink(),
    );

    expect(existsSync(leftovers)).toBe(false);
  });

  // The property this duty is built around: the runs that fail to uninstall are exactly the ones
  // most likely to have left a mess, so the sweep must not be conditional on the removal.
  test("clears them even when the plugin removal fails", async () => {
    seedInstalled();
    process.env.WP_STUB_FAIL = "plugin uninstall";
    const leftovers = join(wpRoot, "wp-content/uploads/backwpup");
    mkdirSync(leftovers, { recursive: true });

    await expect(
      teardownPluginUnderTest(
        local,
        "backwpup-pro",
        {},
        ["wp-content/uploads/backwpup"],
        reportSink(),
      ),
    ).rejects.toThrow(/still installed/);

    expect(existsSync(leftovers)).toBe(false);
  });

  // Leftovers the transport's user is not *permitted* to remove are an ownership fact about the
  // cell, not something the scenario did — and they break no later scenario, unlike a half-removed
  // plugin. Failing every run over them would be a poor trade, so they are reported instead.
  test("reports a leftover it is not allowed to remove, without failing the scenario", async () => {
    test.skip(isRoot, "root ignores directory permissions, so rm -rf succeeds");
    seedInstalled();
    const leftovers = join(wpRoot, "wp-content/uploads/backwpup");
    mkdirSync(join(leftovers, "abc123"), { recursive: true });
    chmodSync(leftovers, 0o500);
    const report = reportSink();
    try {
      await expect(
        // Unprivileged on purpose: the sweep escalates when it can, so allowing it here would make
        // the outcome depend on whether this machine has passwordless sudo (CI does).
        teardownPluginUnderTest(
          { ...local, elevate: false },
          "backwpup-pro",
          {},
          ["wp-content/uploads/backwpup"],
          report,
        ),
      ).resolves.toBeUndefined();

      // Loud enough to act on, in the run output and in the report.
      expect(warnings.join("\n")).toContain(leftovers);
      expect(report.attached.get("uncleared-site-data")).toContain(leftovers);
    } finally {
      if (existsSync(leftovers)) chmodSync(leftovers, 0o700);
    }
  });

  // The other half of that split: a path we should never have declared is our own defect, and is
  // thrown rather than warned about.
  test("throws when a declared residue path is not a usable one", async () => {
    seedInstalled();
    await expect(
      teardownPluginUnderTest(
        local,
        "backwpup-pro",
        {},
        ["wp-content/uploads"],
        reportSink(),
      ),
    ).rejects.toThrow(/WordPress itself owns/);
  });

  test("a fatal still outranks an unusable residue declaration", async () => {
    seedInstalled();
    process.env.WP_STUB_LOG = "PHP Fatal error:  the real defect\n";
    await expect(
      teardownPluginUnderTest(
        local,
        "backwpup-pro",
        {},
        ["../escape"],
        reportSink(),
      ),
    ).rejects.toThrow(DebugLogFatalError);
    expect(errors.join("\n")).toMatch(/a cleanup step also failed/);
  });

  test("an attachment fault never replaces the verdict", async () => {
    process.env.WP_STUB_LOG = "PHP Fatal error:  boom\n";
    const failing: ScenarioReport = {
      title: SCENARIO_TITLE,
      failed: false,
      attach: () => Promise.reject(new Error("reporter is gone")),
    };

    await expect(
      teardownPluginUnderTest(local, "backwpup-pro", {}, [], failing),
    ).rejects.toThrow(DebugLogFatalError);
    expect(warnings.join("\n")).toMatch(/could not attach debug\.log/);
  });
});
