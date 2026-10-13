import {
  REPORTS_KEEP_ENV,
  REQUESTED_REF_ENV,
  RETRIES_ENV,
  RUN_NAME_ENV,
} from "../../src/common/config/run-env";
import type { OrchestratorConfig, TaskConfig } from "../config/schema";

/**
 * A run's environment, built from an allowlist — never the orchestrator's own, which may carry
 * anything its shell or an imported module set (`.env`'s values, a `RUN_ID`, `CI`). Pure: the
 * orchestrator's environment is handed in, and only the few variables a process needs to find its
 * tools are taken from it.
 */

/**
 * What a run takes from the orchestrator's environment, when set: where its tools are (`PATH`),
 * where APVM's cache and `gh`'s login live (`HOME`), its language, and its temporary folder.
 */
export const INHERITED_VARIABLES = ["PATH", "HOME", "LANG", "TMPDIR"] as const;

/** What a run's environment is made from. */
export interface RunEnvironmentInput {
  /** The orchestrator's environment (`process.env`): only {@link INHERITED_VARIABLES} are read. */
  readonly inherited: Readonly<Record<string, string | undefined>>;
  readonly task: Pick<TaskConfig, "cell" | "name" | "plugin">;
  readonly config: Pick<OrchestratorConfig, "runs" | "secrets">;
  /** The run's `RUN_ID`. */
  readonly runId: string;
  /** The drain's stop file: absolute, in the run's folder. */
  readonly stopFile: string;
}

/**
 * The environment a run's processes start with.
 *
 * - {@link INHERITED_VARIABLES}, each only when set and not empty;
 * - `E2E_LOAD_DOTENV=false`, so the checkout's `.env` never reaches a run; the run's `RUN_ID`, its
 *   cell pin and its stop file;
 * - the task's plugin — `E2E_PLUGIN_REF` and `E2E_PLUGIN_VERSION` when set — and the ref asked for,
 *   for display (`E2E_REQUESTED_REF`: the same ref until runs are pinned to what was built);
 * - the task's name (`E2E_RUN_NAME`, display only), the retries and the reports' cap when configured;
 * - the configured secrets — whose names the config allows only as `GITHUB_TOKEN`, `GH_TOKEN` and
 *   `BWP_*`, so none can replace a variable above.
 *
 * @param input - the orchestrator's environment, the task, the config and the run.
 * @returns the environment, a fresh object.
 */
export function runEnvironment(
  input: RunEnvironmentInput,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of INHERITED_VARIABLES) {
    const value = input.inherited[name];
    if (value !== undefined && value !== "") environment[name] = value;
  }
  const { task, config } = input;
  const optional: Readonly<Record<string, string | number | undefined>> = {
    E2E_PLUGIN_REF: task.plugin?.ref,
    E2E_PLUGIN_VERSION: task.plugin?.version,
    [REQUESTED_REF_ENV]: task.plugin?.ref,
    [RUN_NAME_ENV]: task.name,
    [RETRIES_ENV]: config.runs?.retries,
    [REPORTS_KEEP_ENV]: config.runs?.reportsKeep,
  };
  for (const [name, value] of Object.entries(optional))
    if (value !== undefined) environment[name] = String(value);
  return {
    ...environment,
    E2E_LOAD_DOTENV: "false",
    RUN_ID: input.runId,
    E2E_CELL: task.cell,
    E2E_INTERNAL_STOP_FILE: input.stopFile,
    ...config.secrets,
  };
}

/**
 * The names of an environment's variables, sorted: what a run's log says it started with — never a
 * value, which may be a secret.
 *
 * @param environment - a run's environment.
 * @returns the names.
 */
export function variableNames(
  environment: Readonly<Record<string, string>>,
): string[] {
  return Object.keys(environment).sort();
}
