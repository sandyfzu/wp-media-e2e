import { test, expect } from "@playwright/test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BACKWPUP_COMMANDS,
  commandNamesFor,
  compareCommands,
  parseSubcommands,
  readRegisteredCommands,
} from "./cli-commands";
import type { LocalTransport } from "../../../common/config/types";

/**
 * `wp backwpup --help`, captured verbatim from a live site at `develop@f1ebfd0` — Pro's 17
 * subcommands, two of the wrapped descriptions that must not be read as commands, and the head of
 * the next section, whose flags are indented exactly as commands are and must not be read either.
 */
const PRO_HELP = `NAME

  wp backwpup

SYNOPSIS

  wp backwpup <command>

SUBCOMMANDS

  backup               Show BackWPup backup archives.
  backup-decrypt       Decrypts a file with BackWPup decryption.
  backup-delete        Delete BackWPup backup archives on storages.
  backup-download      Download a BackWPup backup archive from a storage. Shows
                       progress bar.
  backup-encrypt       Encrypts a file with BackWPup encryption.
  job                  Show BackWPup jobs.
  job-activate         Activate Job (also legacy); Filter by all or selected job
                       IDs
  job-export           Export BackWPup jobs.
  job-import           Import BackWPup jobs from Json file.
  kill                 Kills a running BackWPup job.
  log                  List BackWPup logs with powerful filters and customizable
                       output formats.
  log-delete           Delete BackWPup log files.
  log-show             Show a BackWPup log as plain text (HTML ignored).
  restore              Restore a BackWPup backup from an archive file
                       (.tar/.tar.gz/.zip).
  run                  Start a BackWPup job.
  status               Shows the status about a running BackWPup job. With a
                       progress bar.
  version              Show BackWPup Plugin Version.



GLOBAL PARAMETERS

  --path=<path>
      Path to the WordPress files.
`;

/** The same page from the Free build of the same commit — the 12 shared commands and nothing else. */
const FREE_HELP = `NAME

  wp backwpup

SYNOPSIS

  wp backwpup <command>

SUBCOMMANDS

  backup               Show BackWPup backup archives.
  backup-delete        Delete BackWPup backup archives on storages.
  backup-download      Download a BackWPup backup archive from a storage. Shows
                       progress bar.
  job                  Show BackWPup jobs.
  job-activate         Activate Job (also legacy); Filter by all or selected job
                       IDs
  kill                 Kills a running BackWPup job.
  log                  List BackWPup logs with powerful filters and customizable
                       output formats.
  log-delete           Delete BackWPup log files.
  log-show             Show a BackWPup log as plain text (HTML ignored).
  run                  Start a BackWPup job.
  status               Shows the status about a running BackWPup job. With a
                       progress bar.
  version              Show BackWPup Plugin Version.



GLOBAL PARAMETERS

  --path=<path>
      Path to the WordPress files.
`;

const STUB_WP = `#!/usr/bin/env bash
case "$WP_STUB_MODE" in
  pro)      cat "$WP_STUB_HELP" ;;
  inactive) printf "Error: 'backwpup' is not a registered wp command. See 'wp help' for available commands.\\n" >&2; exit 1 ;;
esac
exit 0
`;

let binDir: string;
let rootDir: string;
let originalPath: string | undefined;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "bwp-cmds-bin-"));
  rootDir = mkdtempSync(join(tmpdir(), "bwp-cmds-root-"));
  const wp = join(binDir, "wp");
  writeFileSync(wp, STUB_WP);
  chmodSync(wp, 0o755);
  const help = join(binDir, "help.txt");
  writeFileSync(help, PRO_HELP);
  process.env.WP_STUB_HELP = help;
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
});

test.afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.WP_STUB_MODE;
  delete process.env.WP_STUB_HELP;
  rmSync(binDir, { recursive: true, force: true });
  rmSync(rootDir, { recursive: true, force: true });
});

const local = (): LocalTransport => ({ mode: "local", rootDir });

test.describe("parseSubcommands", () => {
  test("reads every command off the Pro page, in the order printed", () => {
    expect(parseSubcommands(PRO_HELP)).toEqual([
      "backup",
      "backup-decrypt",
      "backup-delete",
      "backup-download",
      "backup-encrypt",
      "job",
      "job-activate",
      "job-export",
      "job-import",
      "kill",
      "log",
      "log-delete",
      "log-show",
      "restore",
      "run",
      "status",
      "version",
    ]);
  });

  test("reads the Free page as the twelve shared commands", () => {
    expect(parseSubcommands(FREE_HELP)).toHaveLength(12);
  });

  // The three ways this parse could go wrong, each pinned against the real page: a wrapped
  // description, the two-space-indented content of another section, and the page's own headings.
  test("never mistakes surrounding text for a command", () => {
    const names = parseSubcommands(PRO_HELP);
    expect(names).not.toContain("progress"); // a wrapped description
    expect(names).not.toContain("IDs"); // ditto, with no trailing period
    expect(names).not.toContain("--path=<path>"); // GLOBAL PARAMETERS, same indent
    expect(names).not.toContain("wp"); // NAME and SYNOPSIS, same indent
  });

  test("survives CRLF line endings", () => {
    expect(parseSubcommands(PRO_HELP.replace(/\n/g, "\r\n"))).toHaveLength(17);
  });

  // A reformat by a future WP-CLI must be a loud parse failure, never "the plugin registers
  // nothing" — which would make every absence assertion pass.
  test("refuses a page with no subcommand section", () => {
    expect(() => parseSubcommands("NAME\n\n  wp backwpup\n")).toThrow(
      /has no SUBCOMMANDS section/,
    );
  });

  test("refuses a subcommand section with nothing under it", () => {
    expect(() =>
      parseSubcommands(
        "SUBCOMMANDS\n\n\nGLOBAL PARAMETERS\n\n  --path=<path>\n",
      ),
    ).toThrow(/listed no subcommands/);
  });

  test("refuses empty output", () => {
    expect(() => parseSubcommands("")).toThrow(/has no SUBCOMMANDS section/);
  });
});

test.describe("the declared manifest", () => {
  // The load-bearing cross-check: the expectation this suite asserts against is exactly what each
  // edition of the ref under test really registers. Everything else here rests on it.
  test("matches what Pro actually registers", () => {
    expect([...commandNamesFor("pro")].sort()).toEqual(
      [...parseSubcommands(PRO_HELP)].sort(),
    );
  });

  test("matches what Free actually registers", () => {
    expect([...commandNamesFor("free")].sort()).toEqual(
      [...parseSubcommands(FREE_HELP)].sort(),
    );
  });

  test("makes Pro exactly five commands larger than Free", () => {
    const free = new Set(commandNamesFor("free"));
    expect(commandNamesFor("pro").filter((name) => !free.has(name))).toEqual([
      "backup-decrypt",
      "backup-encrypt",
      "job-export",
      "job-import",
      "restore",
    ]);
  });

  test("declares an alias for every command except version", () => {
    expect(
      BACKWPUP_COMMANDS.filter((command) => command.alias === undefined).map(
        (command) => command.name,
      ),
    ).toEqual(["version"]);
    const aliased = BACKWPUP_COMMANDS.filter(
      (command) => command.alias !== undefined,
    );
    expect(aliased).toHaveLength(16);
    expect(
      aliased.filter((command) => command.availability === "all"),
    ).toHaveLength(11);
  });

  test("never reuses a name as another command's alias", () => {
    const names = new Set(BACKWPUP_COMMANDS.map((command) => command.name));
    expect(
      BACKWPUP_COMMANDS.filter(
        (command) => command.alias !== undefined && names.has(command.alias),
      ),
    ).toEqual([]);
  });
});

test.describe("compareCommands", () => {
  test("reports no drift when a site registers exactly its edition's set", () => {
    expect(compareCommands(parseSubcommands(PRO_HELP), "pro")).toEqual({
      missing: [],
      unexpected: [],
    });
    expect(compareCommands(parseSubcommands(FREE_HELP), "free")).toEqual({
      missing: [],
      unexpected: [],
    });
  });

  test("names a command that is declared but not registered", () => {
    const registered = parseSubcommands(PRO_HELP).filter(
      (name) => name !== "kill",
    );
    expect(compareCommands(registered, "pro")).toEqual({
      missing: ["kill"],
      unexpected: [],
    });
  });

  test("names CLI surface the product grew that nothing here covers", () => {
    expect(
      compareCommands([...parseSubcommands(PRO_HELP), "brand-new"], "pro")
        .unexpected,
    ).toEqual(["brand-new"]);
  });

  // The edition split is only observable if Free having a Pro command fails, not just if Pro
  // missing one does.
  test("treats a Pro command on Free as unexpected", () => {
    expect(
      compareCommands([...parseSubcommands(FREE_HELP), "restore"], "free"),
    ).toEqual({ missing: [], unexpected: ["restore"] });
  });
});

test.describe("readRegisteredCommands", () => {
  test("asks the site and parses what it answers", async () => {
    process.env.WP_STUB_MODE = "pro";
    expect(await readRegisteredCommands(local())).toHaveLength(17);
  });

  // A site without the plugin answers this, and must say so rather than read as "no commands".
  test("reports a site that does not know the command at all", async () => {
    process.env.WP_STUB_MODE = "inactive";
    await expect(readRegisteredCommands(local())).rejects.toThrow(
      /could not read the registered commands.*is not a registered wp command/s,
    );
  });
});
