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
  PROTECTED_OPTIONS,
  PROTECTED_TABLES,
  assertNoProtectedOptions,
  findSiteDbResidue,
  isEmptyDbResidue,
  normaliseOptionFragment,
  normaliseResidueTable,
  removeSiteDbResidue,
} from "./db-residue";
import { SiteDbResidueRemovalFailedError } from "./errors";
import type { LocalTransport } from "../config/types";

/**
 * The database-footprint sweep, driven over the `local` transport against a stub `wp`.
 *
 * The stub replies from a script — one line of JSON per call — because the interesting behaviour is
 * a *sequence*: scan, remove, then re-read to check. Only a stub that can answer differently the
 * third time can prove the verification is real rather than decorative.
 */

const STUB_WP = `#!/usr/bin/env bash
printf '%s' "$*" | tr '\\n' ' ' >> "$WP_STUB_CALLS"
printf '\\n' >> "$WP_STUB_CALLS"
n=$(cat "$WP_STUB_N" 2>/dev/null || echo 0)
n=$((n + 1))
printf '%s' "$n" > "$WP_STUB_N"
if [ -n "$WP_STUB_FAIL" ]; then printf '%s' "$WP_STUB_FAIL" >&2; exit 1; fi
reply=$(sed -n "\${n}p" "$WP_STUB_REPLIES")
if [ -z "$reply" ]; then reply=$(tail -n 1 "$WP_STUB_REPLIES"); fi
printf '%s' "$reply"
`;

let binDir: string;
let rootDir: string;
let originalPath: string | undefined;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "wp-dbres-stub-bin-"));
  rootDir = mkdtempSync(join(tmpdir(), "wp-dbres-stub-root-"));
  const wp = join(binDir, "wp");
  writeFileSync(wp, STUB_WP);
  chmodSync(wp, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  process.env.WP_STUB_CALLS = join(binDir, "calls.txt");
  process.env.WP_STUB_N = join(binDir, "n.txt");
  process.env.WP_STUB_REPLIES = join(binDir, "replies.txt");
});

test.afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.WP_STUB_CALLS;
  delete process.env.WP_STUB_N;
  delete process.env.WP_STUB_REPLIES;
  delete process.env.WP_STUB_FAIL;
  rmSync(binDir, { recursive: true, force: true });
  rmSync(rootDir, { recursive: true, force: true });
});

test.beforeEach(() => {
  writeFileSync(join(binDir, "calls.txt"), "");
  writeFileSync(join(binDir, "n.txt"), "0");
  writeFileSync(join(binDir, "replies.txt"), "");
  delete process.env.WP_STUB_FAIL;
});

const local = (): LocalTransport => ({ mode: "local", rootDir });

/** Queues the stub's replies, one per `wp` call; the last is repeated if calls outrun it. */
function replies(...docs: string[]): void {
  writeFileSync(join(binDir, "replies.txt"), `${docs.join("\n")}\n`);
}

/** A scan reply in the shape the snippet emits. */
function found(options: string[] = [], tables: string[] = []): string {
  return JSON.stringify({ prefix: "wp_", options, tables });
}

/** Every `wp` invocation so far, as the stub recorded it. */
function calls(): string[] {
  return readFileSync(join(binDir, "calls.txt"), "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

const BACKWPUP = { optionsContaining: ["backwpup"], tables: ["bwpup_backups"] };

test.describe("normaliseOptionFragment", () => {
  test("accepts a plugin-shaped fragment and trims it", () => {
    expect(normaliseOptionFragment("  backwpup  ")).toBe("backwpup");
  });

  // A fragment is matched anywhere in a name, so a very short one reaches options that belong to
  // the site rather than the product. Refused where it can still be explained.
  test("refuses a fragment too short to identify a product", () => {
    expect(() => normaliseOptionFragment("id")).toThrow(
      /shorter than 3 characters/,
    );
  });

  // The fragment is escaped before it reaches SQL, so a `%` here cannot widen the match — it would
  // silently match nothing instead. Either way it is not what the author meant.
  test("refuses anything that looks like a wildcard", () => {
    expect(() => normaliseOptionFragment("backwpup%")).toThrow(
      /matched literally/,
    );
    expect(() => normaliseOptionFragment("back'wpup")).toThrow(
      /matched literally/,
    );
  });
});

test.describe("normaliseResidueTable", () => {
  test("accepts an unprefixed table name", () => {
    expect(normaliseResidueTable(" bwpup_backups ")).toBe("bwpup_backups");
  });

  // The name is spliced into `DROP TABLE` as an identifier, which no placeholder can carry, so the
  // charset restriction is the whole guard rather than a tidiness rule.
  test("refuses a name that is not a bare identifier", () => {
    expect(() => normaliseResidueTable("wp_posts; DROP")).toThrow(
      /letters, digits and underscores/,
    );
    expect(() => normaliseResidueTable("a`b")).toThrow(
      /letters, digits and underscores/,
    );
  });

  test("refuses WordPress's own tables, however they are cased", () => {
    expect(() => normaliseResidueTable("posts")).toThrow(
      /one of WordPress's own tables/,
    );
    expect(() => normaliseResidueTable("Users")).toThrow(
      /one of WordPress's own tables/,
    );
    expect(PROTECTED_TABLES).toContain("options");
  });
});

test.describe("assertNoProtectedOptions", () => {
  /** The guard under test, wrapped so a void call can be handed to `toThrow`. */
  const check =
    (options: string[], prefix: string): (() => void) =>
    () => {
      assertNoProtectedOptions(options, prefix);
    };

  test("passes for options that belong to a product", () => {
    expect(
      check(["backwpup_version", "bwpup_backups_version"], "wp_"),
    ).not.toThrow();
  });

  test("refuses when the match reached an option WordPress owns", () => {
    expect(check(["backwpup_version", "siteurl"], "wp_")).toThrow(
      /belong to WordPress itself — siteurl/,
    );
    expect(PROTECTED_OPTIONS).toContain("active_plugins");
  });

  // `user_roles` carries the site's prefix, so it can only be recognised once the prefix is known —
  // and losing it locks every user out of wp-admin.
  test("recognises the protected options that carry the site's prefix", () => {
    expect(check(["wp_user_roles"], "wp_")).toThrow(/wp_user_roles/);
    expect(check(["xy_user_roles"], "xy_")).toThrow(/xy_user_roles/);
    // The same name under a different prefix is not this site's roles option.
    expect(check(["xy_user_roles"], "wp_")).not.toThrow();
  });
});

test.describe("findSiteDbResidue", () => {
  // A product that declares nothing must not pay a round-trip for it, mirroring the filesystem
  // sweep's contract.
  test("asks the site nothing when nothing is declared", async () => {
    expect(await findSiteDbResidue(local(), {})).toEqual({
      options: [],
      tables: [],
    });
    expect(calls()).toEqual([]);
  });

  test("reports what the site said it holds", async () => {
    replies(found(["backwpup_version"], ["wp_bwpup_backups"]));
    expect(await findSiteDbResidue(local(), BACKWPUP)).toEqual({
      options: ["backwpup_version"],
      tables: ["wp_bwpup_backups"],
    });
  });

  // Plugins stay out of the request: the product's own plugin re-creates its footprint on `init`,
  // so a sweep that loaded it could undo itself. Pinned because the flag is invisible in the result.
  test("loads WordPress without its plugins", async () => {
    replies(found());
    await findSiteDbResidue(local(), BACKWPUP);
    expect(calls()[0]).toMatch(/^--skip-plugins eval /);
  });

  // The declaration has to reach the snippet, and it travels as a base64 literal rather than as
  // interpolated text — so the check is that the snippet decodes to the fragments.
  test("carries the declared fragments and tables into the snippet", async () => {
    replies(found());
    await findSiteDbResidue(local(), BACKWPUP);
    const encoded = [
      ...(calls()[0] ?? "").matchAll(/base64_decode\( '([^']+)' \)/g),
    ];
    const decoded = encoded.map((match) =>
      Buffer.from(match[1] ?? "", "base64").toString("utf8"),
    );
    expect(decoded).toContain('["backwpup"]');
    expect(decoded).toContain('["bwpup_backups"]');
  });

  // A site that printed a notice before its JSON must not be read as "nothing found" — that is the
  // one wrong answer that makes a sweep silently skip a dirty site.
  test("refuses a reply that is not the expected shape", async () => {
    replies("Notice: something\n{}");
    await expect(findSiteDbResidue(local(), BACKWPUP)).rejects.toThrow(
      /reply was not JSON/,
    );
    replies(JSON.stringify({ prefix: "wp_", options: [1], tables: [] }));
    await expect(findSiteDbResidue(local(), BACKWPUP)).rejects.toThrow(
      /did not describe a footprint/,
    );
  });

  test("reports a site that could not answer at all", async () => {
    process.env.WP_STUB_FAIL = "Error: Cannot connect to the database";
    await expect(findSiteDbResidue(local(), BACKWPUP)).rejects.toThrow(
      /Cannot connect to the database/,
    );
  });
});

test.describe("removeSiteDbResidue", () => {
  test("does nothing at all when nothing is declared", async () => {
    expect(await removeSiteDbResidue(local(), {})).toEqual({
      options: [],
      tables: [],
    });
    expect(calls()).toEqual([]);
  });

  // The common case by far. A site that was left clean should cost one read and no write — and in
  // particular must not run a `DELETE` that matches nothing.
  test("stops after the scan when the site is already clean", async () => {
    replies(found());
    expect(isEmptyDbResidue(await removeSiteDbResidue(local(), BACKWPUP))).toBe(
      true,
    );
    expect(calls()).toHaveLength(1);
  });

  test("removes what it found and reports it", async () => {
    replies(
      found(["backwpup_version"], ["wp_bwpup_backups"]),
      found(),
      found(),
    );
    expect(await removeSiteDbResidue(local(), BACKWPUP)).toEqual({
      options: ["backwpup_version"],
      tables: ["wp_bwpup_backups"],
    });
    // Scan, remove, verify — and the middle one is the only call that deletes.
    expect(calls()).toHaveLength(3);
    expect(calls()[1]).toContain("delete_option");
    expect(calls()[1]).toContain("DROP TABLE IF EXISTS");
    expect(calls()[2]).not.toContain("delete_option");
  });

  // Removal is verified by re-reading rather than inferred from an exit code: `DROP` succeeds for a
  // table it never touched, and `delete_option` reports false both for "absent" and for "refused".
  test("fails when the footprint survived the removal", async () => {
    replies(
      found(["backwpup_version"], ["wp_bwpup_backups"]),
      found(),
      found(["backwpup_version"], ["wp_bwpup_backups"]),
    );
    const error = await removeSiteDbResidue(local(), BACKWPUP).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SiteDbResidueRemovalFailedError);
    expect((error as SiteDbResidueRemovalFailedError).options).toEqual([
      "backwpup_version",
    ]);
    expect((error as Error).message).toMatch(/re-creates its own/);
  });

  // The guard has to fire *before* anything is deleted, or it is only a nicer way to describe a
  // site that has already lost its home URL.
  test("refuses the whole sweep when the match reached a protected option", async () => {
    replies(found(["backwpup_version", "siteurl"]));
    await expect(removeSiteDbResidue(local(), BACKWPUP)).rejects.toThrow(
      /nothing has been removed/,
    );
    expect(calls()).toHaveLength(1);
  });

  // A declaration is validated in full before the site is touched, so one bad entry cannot leave a
  // site half-swept.
  test("refuses a bad declaration without asking the site anything", async () => {
    await expect(
      removeSiteDbResidue(local(), {
        optionsContaining: ["backwpup"],
        tables: ["users"],
      }),
    ).rejects.toThrow(/one of WordPress's own tables/);
    expect(calls()).toEqual([]);
  });
});
