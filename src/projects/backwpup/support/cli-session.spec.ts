import { test, expect } from "@playwright/test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliSession, parseCommandText } from "./cli-session";
import type { LocalTransport } from "../../../common/config/types";

// The same house pattern as `cli.spec.ts`: a stub `wp` on PATH exercises the session over the real
// exec layer, with no WordPress. `argv` echoes what it was called with, so the namespace the runner
// supplies is observable; `refuse` reproduces the shape of a command that declined.
const STUB_WP = `#!/usr/bin/env bash
case "$WP_STUB_MODE" in
  argv)   printf '%s' "$*" ;;
  refuse) printf 'Error: Invalid field: nope\\n' >&2; exit 1 ;;
esac
exit 0
`;

let binDir: string;
let rootDir: string;
let originalPath: string | undefined;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "bwp-session-bin-"));
  rootDir = mkdtempSync(join(tmpdir(), "bwp-session-root-"));
  const wp = join(binDir, "wp");
  writeFileSync(wp, STUB_WP);
  chmodSync(wp, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
});

test.afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.WP_STUB_MODE;
  rmSync(binDir, { recursive: true, force: true });
  rmSync(rootDir, { recursive: true, force: true });
});

const local = (): LocalTransport => ({ mode: "local", rootDir });

test.describe("parseCommandText", () => {
  test("splits a command and its flags on whitespace", () => {
    expect(parseCommandText("job --format=count")).toEqual([
      "job",
      "--format=count",
    ]);
  });

  test("tolerates the padding a feature file's alignment can introduce", () => {
    expect(parseCommandText("  log   --limit=1  ")).toEqual([
      "log",
      "--limit=1",
    ]);
  });

  test("keeps a single-word command as one argument", () => {
    expect(parseCommandText("version")).toEqual(["version"]);
  });

  test("refuses an empty command rather than running a bare namespace", () => {
    expect(() => parseCommandText("   ")).toThrow(/no command was given/);
  });

  // Each of these would otherwise run `wp backwpup wp backwpup …` and fail as an unregistered
  // subcommand, several lines away from the line that is actually wrong.
  for (const prefix of ["wp backwpup job", "backwpup job"]) {
    test(`refuses "${prefix}", which repeats a prefix the runner supplies`, () => {
      expect(() => parseCommandText(prefix)).toThrow(/already supplied/);
    });
  }

  test("refuses a quoted argument instead of splitting it in half", () => {
    expect(() => parseCommandText("log-show 'two words.html'")).toThrow(
      /quotes or escapes an argument/,
    );
  });

  // A shell-style escaped space would otherwise reach WP-CLI as two arguments, the first ending in a
  // literal backslash.
  test("refuses a backslash-escaped argument for the same reason", () => {
    expect(() => parseCommandText("log-show two\\ words.html")).toThrow(
      /quotes or escapes an argument/,
    );
  });

  // WP-CLI honours these anywhere on the line, so each would move the command off the bound site.
  for (const arg of [
    "--path=/var/www/other",
    "--url=other.example",
    "--ssh=host",
    "--skip-plugins",
    "--skip-plugins=backwpup-pro",
    "--exec=phpinfo();",
    "--no-skip-themes",
  ]) {
    test(`refuses the run-deciding global "${arg}"`, () => {
      expect(() => parseCommandText(`job --format=count ${arg}`)).toThrow(
        /decides where or how the command runs/,
      );
    });
  }

  // Presentation-only globals change nothing about which site answers; `version` even documents
  // `--debug` as its own option.
  test("keeps the globals that only change presentation", () => {
    expect(parseCommandText("version --debug --quiet --no-color")).toEqual([
      "version",
      "--debug",
      "--quiet",
      "--no-color",
    ]);
  });

  // Matched on the whole name, so an option that merely starts like a global is left alone.
  test("does not mistake an option sharing a global's prefix for the global", () => {
    expect(parseCommandText("log --pathology=1 --user_id=2")).toEqual([
      "log",
      "--pathology=1",
      "--user_id=2",
    ]);
  });
});

test.describe("CliSession", () => {
  test("runs under the backwpup namespace and remembers the result", async () => {
    process.env.WP_STUB_MODE = "argv";
    const session = new CliSession(local());
    const result = await session.run(["job", "--format=count"]);

    expect(result.stdout).toBe("backwpup job --format=count");
    expect(result.argv).toEqual(["backwpup", "job", "--format=count"]);
    expect(session.last).toBe(result);
  });

  test("returns a refusal for the caller to assert, rather than throwing", async () => {
    process.env.WP_STUB_MODE = "refuse";
    const session = new CliSession(local());
    const result = await session.run(["job", "--field=nope"]);

    expect(result.exitCode).toBe(1);
    expect(result.notices).toEqual([
      { level: "error", message: "Invalid field: nope" },
    ]);
    expect(session.last.exitCode).toBe(1);
  });

  test("keeps only the latest result, so an assertion cannot reach past its command", async () => {
    process.env.WP_STUB_MODE = "argv";
    const session = new CliSession(local());
    await session.run(["job"]);
    await session.run(["backup"]);

    expect(session.last.argv).toEqual(["backwpup", "backup"]);
  });

  test("says so plainly when nothing has been run yet", () => {
    expect(() => new CliSession(local()).last).toThrow(
      /no BackWPup command has been run/,
    );
  });
});
