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

/**
 * Where a scenario writes the id of the site's scheduled job, which it cannot know in advance —
 * the plugin allocates it.
 */
export const JOB_PLACEHOLDER = "{job}";

/**
 * Anything shaped like a placeholder, resolved or not. No BackWPup argument is a braced word, so
 * one that reaches the split is a placeholder this step cannot fill.
 */
const PLACEHOLDER = /\{[a-z][a-z ]*\}/i;

/**
 * Writes a job's id into the command a scenario wrote, wherever it says {@link JOB_PLACEHOLDER}.
 *
 * @param text - the command as written in the feature, e.g. `run {job} --background`.
 * @param jobId - the id to write in.
 * @returns the command with every placeholder filled.
 * @throws {@link Error} if the text has no placeholder — a step that promises to act on a job and
 * then runs a command naming none would be claiming something it did not do.
 */
export function withJobId(text: string, jobId: number): string {
  if (!text.includes(JOB_PLACEHOLDER)) {
    throw new Error(
      `[backwpup/cli] the command "${text}" does not say where the job goes — write ` +
        `${JOB_PLACEHOLDER} where its id belongs, e.g. "run ${JOB_PLACEHOLDER} --background".`,
    );
  }
  return text.replaceAll(JOB_PLACEHOLDER, String(jobId));
}

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
 * Three more refusals keep the text a BackWPup command and nothing else. `wp` and `backwpup` as the
 * first word: {@link backwpupCli} supplies both, and repeating them would run `wp backwpup wp
 * backwpup …`, failing as an unregistered subcommand several lines from the real mistake. Any of
 * {@link RUN_GLOBALS}, which would move the command off the site the scenario is bound to. And a
 * placeholder nobody filled, which the plugin would read as job `0` and answer about a job that
 * does not exist — see {@link withJobId}, which fills {@link JOB_PLACEHOLDER} first.
 *
 * @param text - the command as written in the feature, without `wp backwpup`.
 * @returns the subcommand and its arguments.
 * @throws {@link Error} if the text is empty, quotes anything, repeats the implied prefix, sets a
 * global that decides where the command runs, or still holds a placeholder.
 */
export function parseCommandText(text: string): readonly string[] {
  if (QUOTING.test(text)) {
    throw new Error(
      `[backwpup/cli] the command "${text}" quotes or escapes an argument, which this step cannot ` +
        "honour — arguments are split on whitespace. Write a step of its own for such a value.",
    );
  }
  const placeholder = PLACEHOLDER.exec(text)?.[0];
  if (placeholder !== undefined) {
    throw new Error(
      `[backwpup/cli] the command "${text}" still holds ${placeholder}, which this step cannot ` +
        `fill. A command naming the scheduled job by ${JOB_PLACEHOLDER} runs "on the scheduled job".`,
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
 * Settles with `work`, unless `budgetMs` passes first.
 *
 * The command itself cannot be stopped from here — the exec layer has no way to — so it is left to
 * finish on its own; racing it still turns "it never came back" into a failure that says so.
 */
async function withinBudget<T>(
  work: Promise<T>,
  budgetMs: number,
  args: readonly string[],
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `[backwpup/cli] \`wp backwpup ${args.join(" ")}\` had not answered after ` +
            `${String(budgetMs / 1000)} s.`,
        ),
      );
    }, budgetMs);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
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
   * @param budgetMs - how long the command may take, for one that blocks on something else — as
   * `status` does on a running job. Omit for a command that simply answers.
   * @returns the outcome, whatever it was — a refusal is a result here, never a throw.
   * @throws {@link Error} if the command could not be run, or was still running when its budget ran
   * out — it is then left to finish on the site. Either way the previous result is already
   * forgotten, so no assertion can judge an earlier command in place of the one that never answered.
   */
  async run(args: readonly string[], budgetMs?: number): Promise<CliResult> {
    this.result = undefined;
    const pending = backwpupCli(this.transport, args);
    const result =
      budgetMs === undefined
        ? await pending
        : await withinBudget(pending, budgetMs, args);
    this.result = result;
    return result;
  }

  /**
   * What the last command said.
   *
   * @throws {@link Error} if no command has answered — which is a feature written with an assertion
   * ahead of the command it judges, and is worth saying plainly rather than failing as a mismatch
   * against an empty result.
   */
  get last(): CliResult {
    if (this.result === undefined) {
      throw new Error(
        "[backwpup/cli] no BackWPup command has answered in this scenario yet, so there is " +
          "nothing to assert on. Run one before asserting what it reported.",
      );
    }
    return this.result;
  }
}
