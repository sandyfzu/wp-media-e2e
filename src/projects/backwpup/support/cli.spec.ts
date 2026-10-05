import { test, expect } from "@playwright/test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  backwpupCli,
  commandLine,
  describeCli,
  noticesAt,
  outputLines,
  parseCliNotices,
  parseJsonList,
  readJsonList,
} from "./cli";
import type { CliResult } from "./cli";
import type { LocalTransport } from "../../../common/config/types";

// A stub `wp` on PATH exercises the runner over the real exec layer, with no WordPress. Every
// payload is a transcript of what the real commands printed on a live cell at the ref under test.
const STUB_WP = `#!/usr/bin/env bash
case "$WP_STUB_MODE" in
  success)   printf 'Success: No job running.\\n' ;;
  refused)   printf "Error: 'nope' is not a registered subcommand of 'backwpup'.\\n" >&2; exit 1 ;;
  # \`log-delete --all --yes\` shape: plain lines, a Success on stdout, a Warning on stderr.
  mixed)     printf 'Logfile a.html Deleted.\\nSuccess: 1 logfile(s) deleted.\\n'
             printf 'Warning: Logfile b.html is not writable. Check permissions!\\n' >&2 ;;
  json)      printf '%s' '[{"job_id":3,"name":"Database"}]' ;;
  prose)     printf 'No logs found.\\n' ;;
  failed-json) printf 'Error: Invalid field: nope\\n' >&2; exit 1 ;;
  argv)      printf '%s' "$*" ;;
  silent)    : ;;
esac
exit 0
`;

let binDir: string;
let rootDir: string;
let originalPath: string | undefined;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "bwp-cli-bin-"));
  rootDir = mkdtempSync(join(tmpdir(), "bwp-cli-root-"));
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

/** A result built by hand, for the helpers that only read one. */
const resultOf = (fields: Partial<CliResult>): CliResult => ({
  argv: ["backwpup", "job"],
  exitCode: 0,
  stdout: "",
  stderr: "",
  notices: [],
  ...fields,
});

test.describe("parseCliNotices", () => {
  test("reads WP-CLI's own prefixes off either stream", () => {
    expect(parseCliNotices("Success: No job running.", "Error: boom")).toEqual([
      { level: "success", message: "No job running." },
      { level: "error", message: "boom" },
    ]);
  });

  test("keeps stdout's notices before stderr's, and order within each stream", () => {
    expect(
      parseCliNotices(
        "Success: first\nSuccess: second",
        "Warning: one\nWarning: two",
      ).map((notice) => notice.message),
    ).toEqual(["first", "second", "one", "two"]);
  });

  test("ignores the plain lines a command prints around its notices", () => {
    expect(
      parseCliNotices(
        "Logfile a.html Deleted.\nSuccess: 1 logfile(s) deleted.",
        "",
      ),
    ).toEqual([{ level: "success", message: "1 logfile(s) deleted." }]);
  });

  test("says nothing when the command printed no notice", () => {
    expect(parseCliNotices('[{"job_id":3}]', "")).toEqual([]);
  });

  // WP-CLI colours its prefixes when it thinks it is on a terminal. No transport here does, but a
  // stray escape must not turn every notice assertion into a mismatch on invisible bytes.
  test("strips ANSI colour around a prefix", () => {
    expect(parseCliNotices("\u001B[32;1mSuccess:\u001B[0m done", "")).toEqual([
      { level: "success", message: "done" },
    ]);
  });

  test("survives CRLF line endings", () => {
    expect(parseCliNotices("Success: a\r\nSuccess: b", "")).toHaveLength(2);
  });

  // Anchored at the line start on purpose: a command that quotes the word mid-sentence, or an
  // indented block that happens to contain it, is prose and not a status line.
  test("only matches a prefix at the very start of a line", () => {
    expect(
      parseCliNotices("the Error: here is quoted\n  Error: indented", ""),
    ).toEqual([]);
  });

  test("keeps an empty message rather than dropping the notice", () => {
    expect(parseCliNotices("Success:", "")).toEqual([
      { level: "success", message: "" },
    ]);
  });

  // WP-CLI 2.12's own refusal of a parameter the synopsis does not declare, verbatim from a cell.
  // Read line by line, the notice would say only "Parameter errors:" — never which parameter.
  test("reads WP-CLI's multi-line refusal on stderr as one notice", () => {
    expect(
      parseCliNotices(
        "",
        "Error: Parameter errors:\n unknown --nope parameter",
      ),
    ).toEqual([
      {
        level: "error",
        message: "Parameter errors:\nunknown --nope parameter",
      },
    ]);
  });

  // Also verbatim: the suggestion follows on a line of its own, and not indented.
  test("keeps the suggestion WP-CLI adds after a mistyped parameter", () => {
    const [notice] = parseCliNotices(
      "",
      "Error: Parameter errors:\n unknown --formt parameter\nDid you mean '--format'?",
    );
    expect(notice?.message).toContain("unknown --formt parameter");
    expect(notice?.message).toContain("Did you mean '--format'?");
  });

  // Stdout carries the command's own output too, so a line after a notice there is not part of it.
  test("never continues a notice on stdout", () => {
    expect(
      parseCliNotices("Success: Job finished.\narchive.tar", "").map(
        (notice) => notice.message,
      ),
    ).toEqual(["Job finished."]);
  });

  // `--debug` interleaves labelled debug lines on stderr; they belong to no notice.
  test("ends a notice at a blank line or a debug line on stderr", () => {
    expect(
      parseCliNotices(
        "",
        "Warning: first\n\nstray\nWarning: second\nDebug (bootstrap): step (0.01s)\nafter debug",
      ),
    ).toEqual([
      { level: "warning", message: "first" },
      { level: "warning", message: "second" },
    ]);
  });
});

test.describe("backwpupCli", () => {
  test("runs the subcommand under the backwpup namespace", async () => {
    process.env.WP_STUB_MODE = "argv";
    const result = await backwpupCli(local(), ["job", "--format=count"]);
    expect(result.stdout).toBe("backwpup job --format=count");
    expect(result.argv).toEqual(["backwpup", "job", "--format=count"]);
  });

  // The whole reason this module exists beside `backups.ts`: a refusal is an outcome to assert.
  test("returns a refusal instead of throwing", async () => {
    process.env.WP_STUB_MODE = "refused";
    const result = await backwpupCli(local(), ["nope"]);
    expect(result.exitCode).toBe(1);
    expect(noticesAt(result, "error")).toEqual([
      "'nope' is not a registered subcommand of 'backwpup'.",
    ]);
  });

  test("collects notices from both streams of one run", async () => {
    process.env.WP_STUB_MODE = "mixed";
    const result = await backwpupCli(local(), ["log-delete", "--all", "--yes"]);
    expect(result.exitCode).toBe(0);
    expect(noticesAt(result, "success")).toEqual(["1 logfile(s) deleted."]);
    expect(noticesAt(result, "warning")).toEqual([
      "Logfile b.html is not writable. Check permissions!",
    ]);
  });
});

test.describe("describeCli", () => {
  test("names the command, its exit code and what it printed", () => {
    expect(describeCli(resultOf({ exitCode: 1, stderr: "Error: boom" }))).toBe(
      "`wp backwpup job` exited 1:\nError: boom",
    );
  });

  test("says so when the command printed nothing", () => {
    expect(describeCli(resultOf({}))).toBe(
      "`wp backwpup job` exited 0 with no output",
    );
  });

  test("truncates output that would swamp a failure message", () => {
    const described = describeCli(resultOf({ stdout: "x".repeat(5000) }));
    expect(described).toContain("…");
    expect(described.length).toBeLessThan(1100);
  });

  const KEY = "3f".repeat(32);

  // A failure message is kept in reports; a key in it would outlive the scenario it protected.
  test("hides a --key value in the command it names", () => {
    const described = describeCli(
      resultOf({
        argv: ["backwpup", "backup-encrypt", "a.tar", `--key=${KEY}`],
        exitCode: 1,
        stderr: "Error: boom",
      }),
    );
    expect(described).toBe(
      "`wp backwpup backup-encrypt a.tar --key=<hidden>` exited 1:\nError: boom",
    );
  });

  test("hides a key file's path the same way", () => {
    expect(
      describeCli(
        resultOf({
          argv: [
            "backwpup",
            "backup-decrypt",
            "a.tar",
            "--key=.e2e_temp/private/x/private.pem",
          ],
        }),
      ),
    ).toBe(
      "`wp backwpup backup-decrypt a.tar --key=<hidden>` exited 0 with no output",
    );
  });

  test("hides the key wherever the output repeats it", () => {
    const described = describeCli(
      resultOf({
        argv: ["backwpup", "backup-encrypt", "a.tar", `--key=${KEY}`],
        stdout: `used ${KEY}`,
        stderr: `Error: bad key ${KEY}.`,
      }),
    );
    expect(described).not.toContain(KEY);
    expect(described).toContain("used <hidden>");
    expect(described).toContain("bad key <hidden>.");
  });

  // Hidden before the excerpt is cut, so no stretch of the key survives at the cut.
  test("leaves no part of a key at the point the output is cut", () => {
    const described = describeCli(
      resultOf({
        argv: ["backwpup", "backup-encrypt", "a.tar", `--key=${KEY}`],
        stdout: `${"x".repeat(990)}${KEY}`,
      }),
    );
    expect(described).not.toContain(KEY.slice(0, 10));
  });

  test("leaves arguments that only look like a key alone", () => {
    expect(
      describeCli(
        resultOf({ argv: ["backwpup", "job", "--keyring=a", "--key="] }),
      ),
    ).toBe("`wp backwpup job --keyring=a --key=` exited 0 with no output");
  });
});

test.describe("outputLines", () => {
  // How `log-show` printed the tail of a live cell's log, with the blank edges a stream can carry.
  test("keeps each printed line, trimmed, and drops the blank ones", () => {
    expect(
      outputLines(
        resultOf({
          stdout:
            "[2026-09-23 16:32:53 UTC] Archive size is 40.27 MB.\r\n\n  [2026-09-23 16:32:53 UTC] Job done in 1 seconds.  \n",
        }),
      ),
    ).toEqual([
      "[2026-09-23 16:32:53 UTC] Archive size is 40.27 MB.",
      "[2026-09-23 16:32:53 UTC] Job done in 1 seconds.",
    ]);
  });

  test("reads nothing printed as no lines", () => {
    expect(outputLines(resultOf({ stdout: "\n  \n" }))).toEqual([]);
  });
});

test.describe("parseJsonList", () => {
  test("parses a JSON array", () => {
    expect(parseJsonList('[{"job_id":3}]', ["backwpup", "job"])).toEqual([
      { job_id: 3 },
    ]);
  });

  // Some commands print nothing rather than `[]` for an empty result, and from out here the two
  // are the same answer. A scenario that needs the literal reply asserts on stdout.
  test("reads an empty string as an empty list", () => {
    expect(parseJsonList("   ", ["backwpup", "job"])).toEqual([]);
  });

  // Returning [] here would turn a broken command into a passing "nothing there yet".
  test("refuses output that is not JSON", () => {
    expect(() => parseJsonList("No logs found.", ["backwpup", "log"])).toThrow(
      /did not return JSON/,
    );
  });

  test("refuses JSON that is not a list", () => {
    expect(() => parseJsonList('{"job_id":3}', ["backwpup", "job"])).toThrow(
      /expected a JSON array/,
    );
  });

  // Named as `describeCli` names it: a key hidden in the command, and where the output repeats it.
  test("hides a --key value in the command it names and the output it quotes", () => {
    const key = "7c".repeat(32);
    const parse = (): unknown =>
      parseJsonList(`Error: bad key ${key}`, [
        "backwpup",
        "backup-decrypt",
        `--key=${key}`,
      ]);
    expect(parse).toThrow(
      "`wp backwpup backup-decrypt --key=<hidden>` did not return JSON. Output was: Error: bad " +
        "key <hidden>",
    );
    expect(parse).not.toThrow(key);
  });
});

test.describe("commandLine", () => {
  test("names the command as WP-CLI runs it", () => {
    expect(commandLine(["backwpup", "job", "--format=count"])).toBe(
      "wp backwpup job --format=count",
    );
  });

  test("hides a --key value, and leaves what only looks like one alone", () => {
    expect(
      commandLine([
        "backwpup",
        "backup-encrypt",
        "a.tar",
        "--key=.e2e_temp/private/x/public.pem",
        "--keyring=a",
        "--key=",
      ]),
    ).toBe(
      "wp backwpup backup-encrypt a.tar --key=<hidden> --keyring=a --key=",
    );
  });
});

test.describe("readJsonList", () => {
  test("parses the output of a command that succeeded", async () => {
    process.env.WP_STUB_MODE = "json";
    expect(readJsonList(await backwpupCli(local(), ["job"]))).toEqual([
      { job_id: 3, name: "Database" },
    ]);
  });

  // WP-CLI leaves stdout empty when it errors, which would otherwise read as an empty list.
  test("refuses to read JSON from a command that failed", async () => {
    process.env.WP_STUB_MODE = "failed-json";
    const result = await backwpupCli(local(), ["job", "--field=nope"]);
    expect(() => readJsonList(result)).toThrow(
      /cannot read JSON from a command that failed/,
    );
  });

  test("reports prose output as the parse failure it is", async () => {
    process.env.WP_STUB_MODE = "prose";
    const result = await backwpupCli(local(), ["log", "--format=json"]);
    expect(() => readJsonList(result)).toThrow(/did not return JSON/);
  });
});
