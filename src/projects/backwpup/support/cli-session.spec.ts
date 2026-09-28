import { test, expect } from "@playwright/test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CliSession,
  fillPlaceholders,
  parseCommandText,
  refusePathsOffTheSite,
} from "./cli-session";
import type { PlaceholderResolvers } from "./cli-session";
import type { LocalTransport } from "../../../common/config/types";

// The same house pattern as `cli.spec.ts`: a stub `wp` on PATH exercises the session over the real
// exec layer, with no WordPress. `argv` echoes what it was called with, so the namespace the runner
// supplies is observable; `refuse` reproduces the shape of a command that declined.
const STUB_WP = `#!/usr/bin/env bash
case "$WP_STUB_MODE" in
  argv)   printf '%s' "$*" ;;
  refuse) printf 'Error: Invalid field: nope\\n' >&2; exit 1 ;;
  # A command that blocks, as \`status\` does on a running job.
  slow)   sleep 2; printf 'Success: Job finished.\\n' ;;
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

  // Left unfilled, the plugin reads a placeholder as job 0 and answers about a job that does not
  // exist — a refusal that would pass a scenario expecting one, for the wrong reason. An unclosed
  // brace is no placeholder at all, so nothing would ever fill it.
  for (const text of [
    "run {job}",
    "job-activate --job_id={job}",
    "log-show {jobs}",
    "run {job --background",
    "run job} --background",
  ]) {
    test(`refuses "${text}", whose brace nothing filled`, () => {
      expect(() => parseCommandText(text)).toThrow(/still holds a brace/);
    });
  }

  // Matched on the whole name, so an option that merely starts like a global is left alone.
  test("does not mistake an option sharing a global's prefix for the global", () => {
    expect(parseCommandText("log --pathology=1 --user_id=2")).toEqual([
      "log",
      "--pathology=1",
      "--user_id=2",
    ]);
  });
});

/** Resolvers that answer fixed values and count how often each was asked. */
function counting(values: Record<string, string>): {
  readonly resolvers: PlaceholderResolvers;
  readonly asked: Map<string, number>;
} {
  const asked = new Map<string, number>();
  const resolvers = new Map(
    Object.entries(values).map(([name, value]) => [
      name,
      () => {
        asked.set(name, (asked.get(name) ?? 0) + 1);
        return Promise.resolve(value);
      },
    ]),
  );
  return { resolvers, asked };
}

test.describe("fillPlaceholders", () => {
  test("writes every value where the command names it", async () => {
    const { resolvers } = counting({
      job: "3",
      "oldest backup": "2026-09-23_11-32-52_QNSWPQFL03_DBDUMP.tar",
    });
    expect(
      await fillPlaceholders("backup-delete {oldest backup} --yes", resolvers),
    ).toBe("backup-delete 2026-09-23_11-32-52_QNSWPQFL03_DBDUMP.tar --yes");
    expect(
      parseCommandText(
        await fillPlaceholders("job-activate --job_id={job}", resolvers),
      ),
    ).toEqual(["job-activate", "--job_id=3"]);
  });

  // Each value is a question to the site, so it is asked once however often the command uses it,
  // and not at all for a placeholder the command does not use.
  test("asks for each value once, and only for the placeholders the command names", async () => {
    const { resolvers, asked } = counting({ job: "7", "newest log": "x.html" });
    expect(
      await fillPlaceholders("run {job},{job} --background", resolvers),
    ).toBe("run 7,7 --background");
    expect([...asked]).toEqual([["job", 1]]);
  });

  test("leaves a command without placeholders as it is, asking nothing", async () => {
    const { resolvers, asked } = counting({ job: "7" });
    expect(await fillPlaceholders("backup --format=count", resolvers)).toBe(
      "backup --format=count",
    );
    expect(asked.size).toBe(0);
  });

  // Names are matched exactly, so a near miss is refused with the names that would have worked —
  // including the plugin's own spelling of a flag, which is the likeliest slip of all.
  for (const text of [
    "run {jobs}",
    "run {Job}",
    "log-show {latest log}",
    "run {job_id}",
    "job-activate --job_id={job-id}",
    "run {job2}",
    "run { job }",
    "run {}",
  ]) {
    test(`refuses "${text}", naming the placeholders it could have used`, async () => {
      const { resolvers } = counting({ job: "3", "newest log": "x.html" });
      await expect(fillPlaceholders(text, resolvers)).rejects.toThrow(
        /which no step fills\. The placeholders a command may use are \{job\}, \{newest log\}\./,
      );
    });
  }

  // The command is split on whitespace next, so each of these would silently become something else.
  for (const value of ["", "two words", "it's", "a\\b", "{job}", "a\tb"]) {
    test(`refuses a value that is not one argument (${JSON.stringify(value)})`, async () => {
      const { resolvers } = counting({ "private folder": value });
      await expect(
        fillPlaceholders("backup-download x.tar {private folder}/", resolvers),
      ).rejects.toThrow(/cannot travel as a single argument/);
    });
  }

  test("passes on a value that could not be found", async () => {
    const resolvers: PlaceholderResolvers = new Map([
      ["job", () => Promise.reject(new Error("expected exactly one job"))],
    ]);
    await expect(fillPlaceholders("run {job}", resolvers)).rejects.toThrow(
      "expected exactly one job",
    );
  });
});

test.describe("refusePathsOffTheSite", () => {
  // Each would reach a file of another site sharing the host, or of the host itself.
  for (const text of [
    "backup-download x.tar /var/www/other/wp-config.php --yes",
    "job-export --file=/tmp/jobs.json",
    "log-show ../../../../etc/passwd",
    "log-delete logs/../../x --yes",
    "backup-download x.tar {private folder}/../x",
  ]) {
    test(`refuses "${text}"`, () => {
      expect(() => {
        refusePathsOffTheSite(text);
      }).toThrow(/a path that leads off the site/);
    });
  }

  // A placeholder is judged by the name written, not the value it will be filled with — the suite
  // proves those on the site, and one of them climbs out of the log folder on purpose.
  for (const text of [
    "backup-download {newest backup} {private folder}/existing.tar --yes",
    "log-show {path from the log folder to the marker file}",
    "log-delete --older-than=7days --yes",
    "backup-download x.tar downloads/x.tar",
    "job --format=count",
  ]) {
    test(`lets "${text}" through`, () => {
      expect(() => {
        refusePathsOffTheSite(text);
      }).not.toThrow();
    });
  }
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
      /no BackWPup command has answered/,
    );
  });

  test("waits out a command that blocks, when its budget allows", async () => {
    process.env.WP_STUB_MODE = "slow";
    const session = new CliSession(local());
    const result = await session.run(["status"], 10_000);

    expect(result.notices).toEqual([
      { level: "success", message: "Job finished." },
    ]);
    expect(session.last).toBe(result);
  });

  // The command is left to finish on the site; what matters is that the step fails naming it, and
  // that the command before it can no longer be judged in its place.
  test("fails naming the command once its budget runs out, and forgets the one before it", async () => {
    process.env.WP_STUB_MODE = "argv";
    const session = new CliSession(local());
    await session.run(["job", "--format=count"]);

    process.env.WP_STUB_MODE = "slow";
    await expect(session.run(["status"], 200)).rejects.toThrow(
      "`wp backwpup status` had not answered after 0.2 s.",
    );
    expect(() => session.last).toThrow(/no BackWPup command has answered/);
  });
});
