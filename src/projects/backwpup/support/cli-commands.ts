import { backwpupCli, describeCli } from "./cli";
import type { Edition, Transport } from "../../../common/config/types";

/**
 * Which `wp backwpup …` subcommands a site should have, and how to read the ones it actually has.
 *
 * The point is that a wrong command name fails **as a wrong command name**. Asking a site for a
 * subcommand it does not register produces an empty list and exit 1 from WP-CLI, which a scenario
 * asserting "no jobs yet" would happily pass; asking it what it registers, and comparing against a
 * declared set, turns the same mistake into one unambiguous failure naming the command.
 *
 * The declared set is not read from the plugin at runtime — it is the **expectation**, verified
 * against both editions of the ref under test and updated deliberately when the product changes.
 * A command that appears without being declared is therefore reported too ({@link CommandDrift}):
 * new CLI surface arriving uncovered is worth knowing about, not worth silently ignoring.
 */

/** Which editions register a command: every edition, or Pro alone. */
export type CommandAvailability = "all" | "pro";

/** One subcommand of `wp backwpup`. */
export interface BackwpupCommand {
  /** The canonical name, which is what the command registers as and what scenarios use. */
  readonly name: string;
  /**
   * The second name it also registers under, from its `@alias` docblock tag.
   *
   * Recorded, not asserted wholesale: scenarios drive the canonical name, and only the two aliases
   * the baseline suite addressed (`jobs`, `backups`) are exercised, by name, in the CLI feature.
   * Free's 11 and Pro's 16 all resolved when this was verified; they are kept here so that no
   * scenario mistakes one for an unregistered name, since WP-CLI's help does not list them.
   */
  readonly alias?: string;
  readonly availability: CommandAvailability;
}

/**
 * Every subcommand `wp backwpup` registers, in the order WP-CLI lists them (alphabetical).
 *
 * Verified twice over at `develop@f1ebfd0`: the command classes in the plugin's `src/Cli/Commands/`
 * for both editions, and then live on a real site — `wp backwpup --help` on Free listed exactly the
 * 12 marked `all`, on Pro exactly these 17, and every declared alias answered `--help` on the
 * edition that ships it while Pro's five answered "not a registered subcommand" on Free.
 *
 * `restore` is declared here although its behaviour belongs to the restore work, not to the CLI
 * surface: whether it is *registered* is an edition fact like any other, and Free proving it absent
 * is half of what makes the Pro/Free split observable.
 */
export const BACKWPUP_COMMANDS: readonly BackwpupCommand[] = [
  { name: "backup", alias: "backups", availability: "all" },
  { name: "backup-decrypt", alias: "decrypt", availability: "pro" },
  { name: "backup-delete", alias: "backups-delete", availability: "all" },
  { name: "backup-download", alias: "backups-download", availability: "all" },
  { name: "backup-encrypt", alias: "encrypt", availability: "pro" },
  { name: "job", alias: "jobs", availability: "all" },
  { name: "job-activate", alias: "activate-legacy-job", availability: "all" },
  { name: "job-export", alias: "jobs-export", availability: "pro" },
  { name: "job-import", alias: "jobs-import", availability: "pro" },
  { name: "kill", alias: "abort", availability: "all" },
  { name: "log", alias: "logs", availability: "all" },
  { name: "log-delete", alias: "logs-delete", availability: "all" },
  { name: "log-show", alias: "logs-show", availability: "all" },
  { name: "restore", alias: "backup-restore", availability: "pro" },
  { name: "run", alias: "start", availability: "all" },
  { name: "status", alias: "working", availability: "all" },
  // The only command with no `@alias` of its own.
  { name: "version", availability: "all" },
];

/** The commands an edition registers: Pro gets all of them, Free only the shared ones. */
export function commandsFor(edition: Edition): readonly BackwpupCommand[] {
  if (edition === "pro") return BACKWPUP_COMMANDS;
  return BACKWPUP_COMMANDS.filter((command) => command.availability === "all");
}

/** The canonical names {@link commandsFor} yields. */
export function commandNamesFor(edition: Edition): readonly string[] {
  return commandsFor(edition).map((command) => command.name);
}

/** The aliases an edition registers — every command declares one except `version`. */
export function aliasesFor(edition: Edition): readonly string[] {
  return commandsFor(edition)
    .map((command) => command.alias)
    .filter((alias) => alias !== undefined);
}

/** The heading above WP-CLI's subcommand list, alone on its own line at column zero. */
const SUBCOMMANDS_HEADING = "SUBCOMMANDS";

/**
 * A listed subcommand: exactly two spaces, then its name.
 *
 * Two spaces *exactly* is what separates a command from the wrapped remainder of the previous
 * command's description, which WP-CLI indents to the description column instead. The other
 * sections of the same page are two-space indented as well (`NAME`, and every flag under
 * `GLOBAL PARAMETERS`), which is why this is only ever applied within the subcommand block.
 */
const SUBCOMMAND_LINE = /^ {2}(\S+)(?:\s|$)/;

/**
 * The subcommands `wp backwpup --help` says are registered.
 *
 * Scrapes the rendered page because WP-CLI offers nothing better here: `wp cli cmd-dump` produces
 * the whole command tree as JSON but runs before plugins register theirs, so BackWPup is simply
 * absent from it — checked, not assumed. The parse is therefore written to **fail loudly**: no
 * heading, or a heading with nothing under it, throws rather than returning an empty list, so a
 * reformat by a future WP-CLI surfaces as a parse error instead of as "the plugin registers
 * nothing".
 *
 * Aliases are not listed by WP-CLI, so what comes back is canonical names only.
 *
 * @param help - the full stdout of `wp backwpup --help`.
 * @returns the names, in the order printed (WP-CLI sorts them alphabetically).
 * @throws {@link Error} if the subcommand block is missing or empty.
 */
export function parseSubcommands(help: string): readonly string[] {
  const lines = help.split(/\r?\n/);
  const heading = lines.findIndex(
    (line) => line.trimEnd() === SUBCOMMANDS_HEADING,
  );
  if (heading === -1) {
    throw new Error(
      `[backwpup/cli] \`wp backwpup --help\` has no ${SUBCOMMANDS_HEADING} section, so the registered ` +
        `commands cannot be read. Output was: ${help.trim().slice(0, 500) || "(empty)"}`,
    );
  }
  const names: string[] = [];
  for (const line of lines.slice(heading + 1)) {
    if (line.trim() === "") continue;
    // A line at column zero is the next section heading: the block is over.
    if (!line.startsWith(" ")) break;
    const name = SUBCOMMAND_LINE.exec(line)?.[1];
    if (name !== undefined) names.push(name);
  }
  if (names.length === 0) {
    throw new Error(
      `[backwpup/cli] \`wp backwpup --help\` listed no subcommands under ${SUBCOMMANDS_HEADING}.`,
    );
  }
  return names;
}

/**
 * Asks a site which `wp backwpup` subcommands it registers.
 *
 * @param transport - the site to ask.
 * @throws {@link Error} if the command failed — which is what a site with the plugin inactive or
 * absent answers, and is reported as itself rather than as an empty command list.
 */
export async function readRegisteredCommands(
  transport: Transport,
): Promise<readonly string[]> {
  const result = await backwpupCli(transport, ["--help"]);
  if (result.exitCode !== 0) {
    throw new Error(
      `[backwpup/cli] could not read the registered commands — ${describeCli(result)}`,
    );
  }
  return parseSubcommands(result.stdout);
}

/** How a site's registered commands differ from what its edition should have. */
export interface CommandDrift {
  /** Declared for this edition but not registered — a removed, renamed or unloaded command. */
  readonly missing: readonly string[];
  /**
   * Registered but not declared for this edition.
   *
   * Two quite different causes, both worth failing on: the product grew CLI surface nothing here
   * covers yet, or a Pro-only command turned up on Free.
   */
  readonly unexpected: readonly string[];
}

/**
 * Compares what a site registers against what its edition should, both ways.
 *
 * @param registered - the names the site reported, from {@link readRegisteredCommands}.
 * @param edition - the cell's edition.
 * @returns the two sorted difference lists; both empty means an exact match.
 */
export function compareCommands(
  registered: readonly string[],
  edition: Edition,
): CommandDrift {
  const expected = new Set(commandNamesFor(edition));
  const actual = new Set(registered);
  return {
    missing: [...expected].filter((name) => !actual.has(name)).sort(),
    unexpected: [...actual].filter((name) => !expected.has(name)).sort(),
  };
}
