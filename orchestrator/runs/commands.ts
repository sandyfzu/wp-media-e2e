import { join } from "node:path";

/**
 * The two commands a run is: `bddgen`, then Playwright's runner. Each is Node itself running the
 * tool's own entry script, never npm, npx or a shell — a shell between the orchestrator and the
 * runner kept the runner's SIGINT from it (macOS's bash), and the PID held must be the runner's own,
 * the one process that turns SIGINT into a graceful stop. Pure: the specs hand in a fake suite.
 */

/** One process to start: a file and its arguments, never a shell string. */
export interface Command {
  readonly file: string;
  readonly args: readonly string[];
}

/** A run's two commands, in order. */
export interface RunCommands {
  /** Generates the cell's specs from its features. */
  readonly bddgen: Command;
  /** Runs them. Started only when `bddgen` exited `0`. */
  readonly playwright: Command;
}

/** Each tool's entry script, relative to the checkout: what its `bin` names. */
export const SUITE_SCRIPTS = {
  bddgen: join("node_modules", "playwright-bdd", "dist", "cli", "index.js"),
  playwright: join("node_modules", "@playwright", "test", "cli.js"),
} as const;

/** What a run's commands are made from. */
export interface SuiteCommandsInput {
  /** The Node binary: the orchestrator's own (`process.execPath`). */
  readonly node: string;
  /** The checkout: absolute. Both commands run in it. */
  readonly checkout: string;
  /** The product's Playwright entry config, relative to the checkout (`playwrightConfigFor`). */
  readonly playwrightConfig: string;
  /** The task's `--grep` filter, when it has one. */
  readonly grep?: string;
}

/**
 * The suite's commands for one run. The filter is one argument, `--grep=<value>`: given as two,
 * a value starting with `-` reads as an option, and `--grep --` swallows the argument after it.
 *
 * @param input - Node, the checkout, the product's config and the task's filter.
 * @returns `bddgen`'s command and the runner's.
 */
export function suiteCommands(input: SuiteCommandsInput): RunCommands {
  const config = ["--config", input.playwrightConfig];
  return {
    bddgen: {
      file: input.node,
      args: [join(input.checkout, SUITE_SCRIPTS.bddgen), ...config],
    },
    playwright: {
      file: input.node,
      args: [
        join(input.checkout, SUITE_SCRIPTS.playwright),
        "test",
        ...config,
        ...(input.grep === undefined ? [] : [`--grep=${input.grep}`]),
      ],
    },
  };
}
