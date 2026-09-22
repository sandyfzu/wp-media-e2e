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
  describeFootprint,
  isFootprintEmpty,
  listBackwpupArchives,
  readBackwpupFootprint,
} from "./footprint";
import type { BackwpupFootprint } from "./footprint";
import type { LocalTransport } from "../../../common/config/types";

/**
 * Reading back what BackWPup left on a site, against a stub `wp`.
 *
 * The cases that matter are the *malformed* replies. "Nothing of the plugin is left" is exactly the
 * answer the deletion scenarios are looking for, so a reader that turned a broken reply into an
 * empty footprint would make every one of them pass without testing anything.
 */

const STUB_WP = `#!/usr/bin/env bash
printf '%s' "$*" | tr '\\n' ' ' >> "$WP_STUB_CALLS"
printf '\\n' >> "$WP_STUB_CALLS"
printf '%s' "$WP_STUB_REPLY"
`;

let binDir: string;
let rootDir: string;
let originalPath: string | undefined;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "bwp-footprint-bin-"));
  rootDir = mkdtempSync(join(tmpdir(), "bwp-footprint-root-"));
  const wp = join(binDir, "wp");
  writeFileSync(wp, STUB_WP);
  chmodSync(wp, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  process.env.WP_STUB_CALLS = join(binDir, "calls.txt");
});

test.afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.WP_STUB_CALLS;
  delete process.env.WP_STUB_REPLY;
  rmSync(binDir, { recursive: true, force: true });
  rmSync(rootDir, { recursive: true, force: true });
});

test.beforeEach(() => {
  writeFileSync(join(binDir, "calls.txt"), "");
});

const local = (): LocalTransport => ({ mode: "local", rootDir });

/** Sets the single reply the stub prints for the next call. */
function reply(body: unknown): void {
  process.env.WP_STUB_REPLY =
    typeof body === "string" ? body : JSON.stringify(body);
}

/** Every `wp` invocation so far, one per line. */
function calls(): string[] {
  return readFileSync(join(binDir, "calls.txt"), "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

/** A footprint with every kind empty, which a site that never saw the plugin reports. */
const EMPTY: BackwpupFootprint = {
  options: [],
  tables: [],
  roles: [],
  adminCapabilities: [],
  userMeta: [],
};

test.describe("isFootprintEmpty / describeFootprint", () => {
  test("an untouched site reports nothing at all", () => {
    expect(isFootprintEmpty(EMPTY)).toBe(true);
    expect(describeFootprint(EMPTY)).toBe("  (nothing)");
  });

  // Each kind counts on its own: an uninstall that cleared the options and left the roles is still
  // a failure, and one that is only checked through `options` would be called a success.
  test("any single surviving kind makes the footprint non-empty", () => {
    for (const kind of [
      "options",
      "tables",
      "roles",
      "adminCapabilities",
      "userMeta",
    ] as const) {
      expect(isFootprintEmpty({ ...EMPTY, [kind]: ["x"] }), kind).toBe(false);
    }
  });

  // What survived is the diagnosis, so the message has to name it rather than count it.
  test("names what survived, and only what survived", () => {
    const described = describeFootprint({
      ...EMPTY,
      options: ["backwpup_version"],
      roles: ["backwpup_admin", "backwpup_check"],
    });
    expect(described).toContain("options: backwpup_version");
    expect(described).toContain("roles: backwpup_admin, backwpup_check");
    expect(described).not.toContain("tables");
  });
});

test.describe("readBackwpupFootprint", () => {
  test("reports every kind the site listed", async () => {
    reply({
      options: ["backwpup_version", "bwpup_backups_version"],
      tables: ["wp_bwpup_backups"],
      roles: ["backwpup_admin"],
      adminCapabilities: ["backwpup"],
      userMeta: ["backwpup_notification_boxes"],
    });
    expect(await readBackwpupFootprint(local())).toEqual({
      options: ["backwpup_version", "bwpup_backups_version"],
      tables: ["wp_bwpup_backups"],
      roles: ["backwpup_admin"],
      adminCapabilities: ["backwpup"],
      userMeta: ["backwpup_notification_boxes"],
    });
  });

  test("reads an untouched site as holding nothing", async () => {
    reply(EMPTY);
    expect(isFootprintEmpty(await readBackwpupFootprint(local()))).toBe(true);
  });

  // The reply is what the assertion rests on, so a field the site did not report must be an error
  // and must say which field — not quietly become an empty list.
  test("refuses a reply that is missing a kind, naming it", async () => {
    reply({ options: [], tables: [], roles: [], adminCapabilities: [] });
    await expect(readBackwpupFootprint(local())).rejects.toThrow(
      /did not report userMeta/,
    );
  });

  test("refuses a reply that is not JSON at all", async () => {
    reply("PHP Notice: something went wrong");
    await expect(readBackwpupFootprint(local())).rejects.toThrow(
      /reply was not JSON/,
    );
  });

  // The snippet's own guard, pinned because it can only fire if the shared fragment list is ever
  // emptied — and the failure it prevents is silent: a WHERE with no condition fails, get_col
  // returns an empty array, and the site reads as holding nothing of the plugin.
  test("refuses to match on an empty fragment list rather than reporting nothing", async () => {
    reply(EMPTY);
    await readBackwpupFootprint(local());
    expect(calls()[0]).toContain("no option-name fragments were supplied");
  });

  // Read with the plugin's own code out of the request, so the answer is what the site has
  // persisted rather than what something still running would put back while being asked.
  test("loads WordPress without its plugins", async () => {
    reply(EMPTY);
    await readBackwpupFootprint(local());
    expect(calls()[0]).toMatch(/^--skip-plugins eval /);
  });
});

test.describe("listBackwpupArchives", () => {
  test("reports the archive paths the site holds", async () => {
    reply(["/var/www/wp-content/uploads/backwpup/64bbd8/backups/a.tar"]);
    expect(await listBackwpupArchives(local())).toEqual([
      "/var/www/wp-content/uploads/backwpup/64bbd8/backups/a.tar",
    ]);
  });

  test("reads a site that has made none as holding none", async () => {
    reply([]);
    expect(await listBackwpupArchives(local())).toEqual([]);
  });

  // Same trap as above, and worse here: an unparsed reply read as "no archives" would turn the
  // assertion that backups outlive the plugin into one that passes when they do not.
  test("refuses a reply that does not list archives", async () => {
    reply({ paths: [] });
    await expect(listBackwpupArchives(local())).rejects.toThrow(
      /did not list its archives/,
    );
    reply("not json");
    await expect(listBackwpupArchives(local())).rejects.toThrow(
      /listing was not JSON/,
    );
  });

  // Only archives may be counted: the same directory holds a `.bwuidx` index beside each one, an
  // `index.php` guard and a `.donotbackup` marker, and counting those would inflate every count.
  // The filter is a plain extension match rather than a braced glob, which is not portable.
  test("counts only the archive extensions, under the site's own uploads directory", async () => {
    reply([]);
    await listBackwpupArchives(local());
    expect(calls()[0]).toContain("tar|tar\\.gz|zip");
    expect(calls()[0]).toContain("wp_upload_dir");
  });
});
