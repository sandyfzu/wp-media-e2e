import { test, expect } from "@playwright/test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dbQuery, tablePrefix } from "./db";
import type { LocalTransport } from "../config/types";

// A stub `wp` on PATH, so the readers run through the real exec layer with no WordPress.
const STUB_WP = `#!/usr/bin/env bash
case "$WP_STUB_MODE" in
  prefix)        printf 'e2e_\\n' ;;
  prefix-empty)  printf '\\n' ;;
  prefix-noise)  printf 'PHP Notice: something\\nwp_\\n' ;;
  rows)          printf 'id\\n1\\n' ;;
  fail)          printf 'Error: boom' >&2; exit 1 ;;
esac
exit 0
`;

let binDir: string;
let rootDir: string;
let originalPath: string | undefined;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "wp-db-stub-bin-"));
  rootDir = mkdtempSync(join(tmpdir(), "wp-db-stub-root-"));
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

test.describe("tablePrefix", () => {
  // Trailing whitespace matters: the prefix is concatenated onto table names, and WP-CLI prints a
  // newline after it.
  test("returns the prefix without the trailing newline", async () => {
    process.env.WP_STUB_MODE = "prefix";
    expect(await tablePrefix(local())).toBe("e2e_");
  });

  // An empty prefix would make every "belongs to this install" comparison match everything.
  test("an empty prefix throws rather than being reported as valid", async () => {
    process.env.WP_STUB_MODE = "prefix-empty";
    await expect(tablePrefix(local())).rejects.toThrow(
      /without a usable prefix/,
    );
  });

  // WordPress allows letters, digits and underscores only, so anything else means the command
  // printed something that is not a prefix — a notice, a banner — and callers build selectors and
  // table-name comparisons out of this. Silently accepting it would target the wrong tables.
  test("output that cannot be a prefix throws instead of being used", async () => {
    process.env.WP_STUB_MODE = "prefix-noise";
    await expect(tablePrefix(local())).rejects.toThrow(
      /without a usable prefix/,
    );
  });

  test("a failed command throws with its output", async () => {
    process.env.WP_STUB_MODE = "fail";
    await expect(tablePrefix(local())).rejects.toThrow(/boom/);
  });
});

test.describe("dbQuery", () => {
  test("returns the query's stdout", async () => {
    process.env.WP_STUB_MODE = "rows";
    expect(await dbQuery(local(), "SELECT 1")).toContain("id");
  });

  test("a failed query throws with its output", async () => {
    process.env.WP_STUB_MODE = "fail";
    await expect(dbQuery(local(), "SELECT 1")).rejects.toThrow(
      /query failed \(exit 1\): Error: boom/,
    );
  });
});
