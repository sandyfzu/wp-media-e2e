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
  DATABASE_MARKER_OPTION,
  FILE_MARKER_NAME,
  newMarkerValue,
  removeMarkers,
  seedMarkers,
} from "./markers";
import type { LocalTransport } from "../../../common/config/types";

/**
 * A stub `wp` on PATH stands in for the site. The seeding snippet echoes back what it stored, so the
 * stub can reply as a site that stored the values faithfully, as one that stored something else, and
 * as one that put the file somewhere a backup of the WordPress root would never reach.
 *
 * The `honest` mode is the interesting one: it parses the two markers back out of the snippet it was
 * handed and returns them, which is what a working site does — so the tests below exercise the real
 * round-trip rather than a hard-coded pair that would pass even if nothing were embedded.
 */
const STUB_WP = `#!/usr/bin/env bash
printf '%s' "$2" > "$WP_STUB_CAPTURE"
case "$WP_STUB_MODE" in
  honest | outside)
    node -e '
      const php = require("fs").readFileSync(process.env.WP_STUB_CAPTURE, "utf8");
      const values = [...php.matchAll(/base64_decode\\( .([^"'"'"']*). \\)/g)]
        .map((m) => JSON.parse(Buffer.from(m[1], "base64").toString("utf8")));
      const hex = values.filter((v) => typeof v === "string" && /^[0-9a-f]{32}$/.test(v));
      process.stdout.write(JSON.stringify({
        path: process.env.MARKER_PATH || "/srv/site/wp-content/e2e-backup-marker.txt",
        root: "/srv/site/",
        file: hex[0],
        database: hex[1],
      }));
    '
    ;;
  wrong)
    printf '{"path":"/srv/site/wp-content/e2e-backup-marker.txt","root":"/srv/site/","file":"deadbeef","database":"deadbeef"}'
    ;;
  partial)
    printf '{"path":"/srv/site/wp-content/e2e-backup-marker.txt","root":"/srv/site/"}'
    ;;
  garbage)
    printf 'PHP Warning: something' ;;
  failing)
    printf 'Error: could not write the file marker to /srv/site/wp-content/x' >&2; exit 1 ;;
  clean)
    printf 'clean' ;;
  stuck)
    printf 'file-remains' ;;
  removefail)
    printf 'Error: boom' >&2; exit 1 ;;
esac
exit 0
`;

let binDir: string;
let rootDir: string;
let capture: string;
let originalPath: string | undefined;
const warnings: string[] = [];
let originalWarn: typeof console.warn;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "bwp-markers-stub-bin-"));
  rootDir = mkdtempSync(join(tmpdir(), "bwp-markers-stub-root-"));
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

test.beforeEach(() => {
  warnings.length = 0;
  originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
});

test.afterEach(() => {
  console.warn = originalWarn;
});

const local = (): LocalTransport => ({ mode: "local", rootDir });

test.describe("newMarkerValue", () => {
  test("is a single line of 32 hex characters", () => {
    // Single-line and alphanumeric so it crosses a SQL dump's quoting, a tar member and a shell
    // pipeline unchanged, and can be searched for literally at the far end.
    const value = newMarkerValue();
    expect(value).toMatch(/^[0-9a-f]{32}$/);
    expect(value).not.toContain("\n");
  });

  test("differs every time, so an archive cannot satisfy a later scenario", () => {
    const values = new Set(Array.from({ length: 50 }, () => newMarkerValue()));
    expect(values.size).toBe(50);
  });
});

test.describe("seedMarkers", () => {
  test("returns the values the site read back", async () => {
    process.env.WP_STUB_MODE = "honest";
    const markers = await seedMarkers(local());
    expect(markers.file).toMatch(/^[0-9a-f]{32}$/);
    expect(markers.database).toMatch(/^[0-9a-f]{32}$/);
    expect(markers.file).not.toBe(markers.database);
  });

  test("replaces a marker rather than failing on one a crashed run left behind", async () => {
    // `add_option` refuses when the option exists, which would strand every later run on a site that
    // died mid-scenario. `update_option` is what makes seeding idempotent.
    process.env.WP_STUB_MODE = "honest";
    await seedMarkers(local());
    const php = readFileSync(capture, "utf8");
    expect(php).toContain("update_option(");
    expect(php).not.toContain("add_option(");
  });

  test("names the option and writes beside the content directory", async () => {
    process.env.WP_STUB_MODE = "honest";
    await seedMarkers(local());
    const php = readFileSync(capture, "utf8");
    // The path is built from the site's own WP_CONTENT_DIR, not from an assumption about layout.
    expect(php).toContain("WP_CONTENT_DIR");
    const decoded = [...php.matchAll(/base64_decode\( '([^']*)' \)/g)].map(
      (match): unknown =>
        JSON.parse(Buffer.from(match[1] ?? "", "base64").toString("utf8")),
    );
    expect(decoded).toContain(DATABASE_MARKER_OPTION);
    expect(decoded).toContain(FILE_MARKER_NAME);
  });

  test("throws when the site stored something other than what it was given", async () => {
    // Verified rather than assumed: a write that silently did nothing would otherwise leave every
    // later assertion hunting for a value the site never held.
    process.env.WP_STUB_MODE = "wrong";
    await expect(seedMarkers(local())).rejects.toThrow(/did not read back/);
  });

  test("refuses a content directory outside the WordPress root", async () => {
    // A site keeping wp-content elsewhere would produce a marker no backup of the root could ever
    // contain, and the scenario would fail as "the backup missed it" — blaming the product.
    process.env.WP_STUB_MODE = "outside";
    process.env.MARKER_PATH = "/elsewhere/e2e-backup-marker.txt";
    try {
      await expect(seedMarkers(local())).rejects.toThrow(
        /outside the WordPress root/,
      );
    } finally {
      delete process.env.MARKER_PATH;
    }
  });

  test("throws on a partial reply instead of defaulting the missing halves", async () => {
    process.env.WP_STUB_MODE = "partial";
    await expect(seedMarkers(local())).rejects.toThrow(/unexpected shape/);
  });

  test("throws when the reply is not JSON at all", async () => {
    process.env.WP_STUB_MODE = "garbage";
    await expect(seedMarkers(local())).rejects.toThrow(/did not return JSON/);
  });

  test("throws with the site's own words when the write failed", async () => {
    process.env.WP_STUB_MODE = "failing";
    await expect(seedMarkers(local())).rejects.toThrow(
      /could not write the file marker/,
    );
  });
});

test.describe("removeMarkers", () => {
  test("removes both and says nothing when it worked", async () => {
    process.env.WP_STUB_MODE = "clean";
    await removeMarkers(local());
    expect(warnings).toEqual([]);
    const php = readFileSync(capture, "utf8");
    expect(php).toContain("delete_option(");
    expect(php).toContain("wp_delete_file(");
  });

  test("warns rather than throws when the file will not go", async () => {
    // Teardown: a scenario that already failed must report its own reason, not a tidy-up problem
    // stacked on top of it.
    process.env.WP_STUB_MODE = "stuck";
    await removeMarkers(local());
    expect(warnings.join(" ")).toMatch(/could not be removed/);
  });

  test("warns rather than throws when the command itself fails", async () => {
    process.env.WP_STUB_MODE = "removefail";
    await removeMarkers(local());
    expect(warnings.join(" ")).toMatch(/removing the markers failed/);
  });
});
