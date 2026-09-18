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

import { nextScheduled, triggerScheduledEvent } from "./cron";
import type { LocalTransport } from "../config/types";

/**
 * A stub `wp` on PATH exercises the readers plus the real exec layer, with no WordPress. It also
 * **records the PHP it was handed**, which is what lets the round-trip test below prove that
 * arbitrary hook names and argument values survive the trip into a `wp eval` snippet — the property
 * that makes building that snippet safe in the first place.
 */
const STUB_WP = `#!/usr/bin/env bash
printf '%s' "$2" > "$WP_STUB_CAPTURE"
case "$WP_STUB_MODE" in
  scheduled)   printf '1788238800' ;;
  unscheduled) printf '0' ;;
  garbage)     printf 'Warning: something printed first' ;;
  ok)          printf '' ;;
  failing)     printf 'Error: no event is scheduled for this hook and arguments' >&2; exit 1 ;;
esac
exit 0
`;

let binDir: string;
let rootDir: string;
let capture: string;
let originalPath: string | undefined;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "wp-cron-stub-bin-"));
  rootDir = mkdtempSync(join(tmpdir(), "wp-cron-stub-root-"));
  capture = join(binDir, "captured-php.txt");
  const wp = join(binDir, "wp");
  writeFileSync(wp, STUB_WP);
  chmodSync(wp, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  process.env.WP_STUB_CAPTURE = capture;
});

test.afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.WP_STUB_CAPTURE;
  rmSync(binDir, { recursive: true, force: true });
  rmSync(rootDir, { recursive: true, force: true });
});

const local = (): LocalTransport => ({ mode: "local", rootDir });

/** Every `base64_decode('…')` literal in the captured snippet, decoded back to its JSON value. */
function decodedLiterals(): unknown[] {
  const php = readFileSync(capture, "utf8");
  return [...php.matchAll(/base64_decode\( '([^']*)' \)/g)].map(
    (match): unknown =>
      JSON.parse(Buffer.from(match[1] ?? "", "base64").toString("utf8")),
  );
}

test.describe("nextScheduled", () => {
  test("returns the timestamp WordPress reports", async () => {
    process.env.WP_STUB_MODE = "scheduled";
    expect(await nextScheduled(local(), "backwpup_cron", { arg: 2 })).toBe(
      1788238800,
    );
  });

  test("reports an unscheduled event as undefined, not as zero", async () => {
    // `wp_next_scheduled` returns false, which the snippet casts to 0. Collapsing that to
    // `undefined` is what lets a caller write `toBeDefined()` and mean "it is scheduled".
    process.env.WP_STUB_MODE = "unscheduled";
    expect(
      await nextScheduled(local(), "backwpup_cron", { arg: 2 }),
    ).toBeUndefined();
  });

  test("throws when the output is not a timestamp at all", async () => {
    // A notice or warning printed ahead of the value would otherwise become `NaN` and quietly
    // compare false against every expectation.
    process.env.WP_STUB_MODE = "garbage";
    await expect(nextScheduled(local(), "backwpup_cron")).rejects.toThrow(
      /expected a timestamp/,
    );
  });

  test("throws with WP-CLI's own message when the command fails", async () => {
    process.env.WP_STUB_MODE = "failing";
    await expect(nextScheduled(local(), "backwpup_cron")).rejects.toThrow(
      /no event is scheduled/,
    );
  });

  test("throws on an empty reply instead of reading it as 'not scheduled'", async () => {
    // `Number("")` is 0, so a command that exits zero having printed nothing would otherwise be
    // indistinguishable from an event that does not exist — the one confusion this reader's
    // contract promises never to make.
    process.env.WP_STUB_MODE = "ok";
    await expect(nextScheduled(local(), "backwpup_cron")).rejects.toThrow(
      /expected a timestamp/,
    );
  });

  test("an argument-less event round-trips as an empty array", async () => {
    process.env.WP_STUB_MODE = "scheduled";
    await nextScheduled(local(), "wp_version_check");
    expect(decodedLiterals()).toEqual(["wp_version_check", {}]);
  });
});

test.describe("triggerScheduledEvent", () => {
  test("throws when WordPress reports it could not run", async () => {
    process.env.WP_STUB_MODE = "failing";
    await expect(
      triggerScheduledEvent(local(), "backwpup_cron", { arg: 2 }),
    ).rejects.toThrow(/no event is scheduled/);
  });

  test("hook and args reach PHP unchanged, whatever they contain", async () => {
    // The snippet embeds both as base64, so nothing a caller passes can end a PHP string literal or
    // change the code being run. This asserts the round-trip on values that would break naive
    // quoting: a single quote, a backslash, a `$`, and a newline.
    process.env.WP_STUB_MODE = "ok";
    const hook = "a'hook\\with$weird\nchars";
    const args = { arg: 'it\'s "quoted"', n: 7, on: true };
    await triggerScheduledEvent(local(), hook, args);
    expect(decodedLiterals()).toEqual([hook, args]);
  });

  test("a positional argument list round-trips as a PHP list", async () => {
    // Core's own events carry positional args (`wp_schedule_event($t,'daily','hook',[123])`), and
    // WordPress keys an event by the hash of that array — so the shape has to survive, not just the
    // values.
    process.env.WP_STUB_MODE = "ok";
    await triggerScheduledEvent(local(), "core_hook", [123, "x"]);
    expect(decodedLiterals()).toEqual(["core_hook", [123, "x"]]);
  });

  test("a recurring event is re-scheduled as recurring, a single one as single", async () => {
    // The snippet decides at run time from the event WordPress hands back, so what a unit test can
    // pin is that both branches exist and that neither is the unconditional single-event call that
    // would silently strip a recurrence.
    process.env.WP_STUB_MODE = "ok";
    await triggerScheduledEvent(local(), "backwpup_cron", { arg: 2 });
    const php = readFileSync(capture, "utf8");
    expect(php).toContain("wp_get_scheduled_event(");
    expect(php).toMatch(
      /\$event->schedule\s*\?\s*wp_schedule_event\(.*\s*:\s*wp_schedule_single_event\(/,
    );
  });

  test("the lock is never deleted, so a slow cron run cannot be truncated", async () => {
    // WordPress declines to spawn only while a lock is *younger* than WP_CRON_LOCK_TIMEOUT
    // (`spawn_cron()`: `if ( $lock + WP_CRON_LOCK_TIMEOUT > $gmt_time ) return false;`), so deleting
    // a stale one cannot change the outcome — while deleting one a merely slow run still holds
    // truncates that run, because `wp-cron.php` re-reads the lock between events and returns once it
    // has changed.
    process.env.WP_STUB_MODE = "ok";
    await triggerScheduledEvent(local(), "backwpup_cron", { arg: 2 });
    expect(readFileSync(capture, "utf8")).not.toContain("delete_transient");
  });

  test("the spawn budget is taken from the site's own lock timeout", async () => {
    // A site may raise WP_CRON_LOCK_TIMEOUT, and a hard-coded budget that cannot outlast it would
    // fail scenarios for a property of the host; the cap stops an extreme value hanging the caller.
    process.env.WP_STUB_MODE = "ok";
    await triggerScheduledEvent(local(), "backwpup_cron", { arg: 2 });
    const php = readFileSync(capture, "utf8");
    expect(php).toMatch(
      /\$budget = min\( 300, max\( 70, WP_CRON_LOCK_TIMEOUT \+ 10 \) \);/,
    );
    expect(php).toContain("$deadline = time() + $budget;");
  });

  test("re-reads the cron array before deciding another runner took the event", async () => {
    // Pins the *ordering* of two statements, because that ordering is the whole of the fix and no
    // stub can reproduce it: WordPress autoloads the cron array once per process and never re-reads
    // it, so asking `wp_next_scheduled` without dropping the cache first returns the value this very
    // snippet wrote — measured on a live cell as zero queries, with `wp_load_alloptions( true )` not
    // forcing one either. Without the drop the branch below is unreachable and the loop waits out
    // its whole budget on a host whose system cron has already run the event.
    process.env.WP_STUB_MODE = "ok";
    await triggerScheduledEvent(local(), "backwpup_cron", { arg: 2 });
    const php = readFileSync(capture, "utf8");
    expect(php).toMatch(
      /wp_cache_delete\( 'alloptions', 'options' \);\s*\$pending = wp_next_scheduled\( \$hook, \$args \);/,
    );
    expect(php).toMatch(
      /if \( false === \$pending \|\| \$pending > \$due \) \{\s*break;/,
    );
  });

  test("an event that cannot be made due is put back where it was", async () => {
    // It is unscheduled before it is moved, so a failure at that point would otherwise leave the
    // site with no event at all — a worse state than the one the trigger was asked to change.
    process.env.WP_STUB_MODE = "ok";
    await triggerScheduledEvent(local(), "backwpup_cron", { arg: 2 });
    const php = readFileSync(capture, "utf8");
    expect(php).toMatch(/\$restored = \$event->schedule/);
    expect(php).toMatch(/wp_schedule_event\( \$event->timestamp,/);
    expect(php).toMatch(/wp_schedule_single_event\( \$event->timestamp,/);
  });
});
