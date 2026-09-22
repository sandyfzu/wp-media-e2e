import { backwpupCli } from "./cli";
import type { CliResult } from "./cli";
import type { Transport } from "../../../common/config/types";

/**
 * One scenario's `wp backwpup …` conversation: the command it wrote, and what came back.
 *
 * The steps that drive this surface are two halves of one sentence — a `When` that runs a command
 * and a `Then` that judges what it said — so the result has to outlive the step that produced it.
 * A scenario-scoped fixture holding it is the sanctioned way to do that here: nothing is shared
 * between scenarios, and no step has to hand a value to the next one through the feature text.
 */

/** Quoting characters — both quotes and the backslash — which the split below would mangle. */
const QUOTING = /["'\\]/;

/** Names that mean the caller re-typed a prefix {@link backwpupCli} already supplies. */
const IMPLIED_PREFIXES = new Set(["wp", "backwpup"]);

/**
 * WP-CLI's global parameters that decide **where** a command runs, as whom, with what code — or,
 * for `--prompt`, where its arguments come from.
 *
 * WP-CLI honours a global anywhere on the line, after the subcommand too — measured: `wp backwpup
 * version --path=<elsewhere>` looked for another WordPress, and `--skip-plugins` unloaded BackWPup.
 * The runner and the scenario's own text already fix all of that, so one of these in a scenario's
 * command would quietly run something else — and `--path` or `--ssh`, on a host shared with another
 * site, would run it against that site. Only the globals that change nothing but presentation are
 * left out: `--quiet`, `--[no-]color`, and `--debug`, which `wp backwpup version` documents as an
 * option of its own.
 */
const RUN_GLOBALS = new Set([
  "path",
  "url",
  "ssh",
  "http",
  "user",
  "skip-plugins",
  "skip-themes",
  "skip-packages",
  "require",
  "exec",
  "context",
  "prompt",
]);

/** The global an argument sets, if it sets one of {@link RUN_GLOBALS}; its `--no-` form too. */
function runGlobalIn(arg: string): string | undefined {
  const name = /^--(?:no-)?([^=]+)/.exec(arg)?.[1];
  return name !== undefined && RUN_GLOBALS.has(name) ? name : undefined;
}

/**
 * Turns the command a scenario wrote into an argv.
 *
 * The split is plain whitespace, so **no argument may contain a space, a quote or a backslash**.
 * That covers every command in this surface — flags, numeric ids, hex keys and the plugin's own
 * hyphen-and-underscore filenames — and a scenario that ever needs more is better served by a step
 * of its own than by a quoting dialect invented here. All three are refused rather than mangled.
 *
 * Two more refusals keep the text a BackWPup command and nothing else. `wp` and `backwpup` as the
 * first word: {@link backwpupCli} supplies both, and repeating them would run `wp backwpup wp
 * backwpup …`, failing as an unregistered subcommand several lines from the real mistake. And any
 * of {@link RUN_GLOBALS}, which would move the command off the site the scenario is bound to.
 *
 * @param text - the command as written in the feature, without `wp backwpup`.
 * @returns the subcommand and its arguments.
 * @throws {@link Error} if the text is empty, quotes anything, repeats the implied prefix, or sets
 * a global that decides where the command runs.
 */
export function parseCommandText(text: string): readonly string[] {
  if (QUOTING.test(text)) {
    throw new Error(
      `[backwpup/cli] the command "${text}" quotes or escapes an argument, which this step cannot ` +
        "honour — arguments are split on whitespace. Write a step of its own for such a value.",
    );
  }
  const args = text.split(/\s+/).filter((arg) => arg !== "");
  const [first] = args;
  if (first === undefined) {
    throw new Error("[backwpup/cli] no command was given to run.");
  }
  if (IMPLIED_PREFIXES.has(first)) {
    throw new Error(
      `[backwpup/cli] the command "${text}" starts with "${first}", which is already supplied — ` +
        'write the subcommand alone, e.g. "job --format=count".',
    );
  }
  const global = args.map(runGlobalIn).find((name) => name !== undefined);
  if (global !== undefined) {
    throw new Error(
      `[backwpup/cli] the command "${text}" sets WP-CLI's --${global}, which decides where or how ` +
        "the command runs rather than what it does — the runner already runs it on this " +
        "scenario's site. Leave it out.",
    );
  }
  return args;
}

/**
 * The commands one scenario has run against its site, remembering the last of them.
 *
 * Deliberately keeps only the latest result: every assertion in this surface is about the command
 * immediately above it, and a history would invite steps that reach back past the sentence they
 * are part of.
 */
export class CliSession {
  /** The site every command runs against — the scenario's own bound site. */
  private readonly transport: Transport;

  /** The most recent result, or `undefined` until the scenario has run something. */
  private result: CliResult | undefined;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /**
   * Runs one `wp backwpup …` subcommand and remembers what it said.
   *
   * @param args - the subcommand and its arguments, e.g. `["job", "--format=count"]`.
   * @returns the outcome, whatever it was — a refusal is a result here, never a throw.
   */
  async run(args: readonly string[]): Promise<CliResult> {
    const result = await backwpupCli(this.transport, args);
    this.result = result;
    return result;
  }

  /**
   * What the last command said.
   *
   * @throws {@link Error} if nothing has been run — which is a feature written with an assertion
   * ahead of the command it judges, and is worth saying plainly rather than failing as a mismatch
   * against an empty result.
   */
  get last(): CliResult {
    if (this.result === undefined) {
      throw new Error(
        "[backwpup/cli] no BackWPup command has been run in this scenario yet, so there is " +
          "nothing to assert on. Run one before asserting what it reported.",
      );
    }
    return this.result;
  }
}
