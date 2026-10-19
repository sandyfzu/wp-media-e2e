/**
 * The names of a cell's three Playwright projects, in one place: the config factory names them, and
 * the reporters tell a setup from a scenario by them. Free of side effects (no `.env`, no `RUN_ID`),
 * so a reporter or a spec can import it.
 *
 * A cell name never holds `:` (`sites.ts` checks it at load), so the two setup prefixes can never be
 * mistaken for a cell's own scenarios project.
 */

/** What a setup project prepares: the login (`setup:<cell>`) or the plugin zips (`artifacts:<cell>`). */
export type SetupKind = "auth" | "artifacts";

/** Each setup kind's project-name prefix. */
const SETUP_PREFIXES: Readonly<Record<SetupKind, string>> = {
  auth: "setup:",
  artifacts: "artifacts:",
};

/**
 * A cell's three project names: its auth setup, its artifacts setup, and its scenarios.
 *
 * @param cell - the cell, as the sites files name it.
 * @example
 * ```ts
 * cellProjectNames("pro@nginx");
 * // { setup: "setup:pro@nginx", artifacts: "artifacts:pro@nginx", scenarios: "pro@nginx" }
 * ```
 */
export function cellProjectNames(cell: string): {
  readonly setup: string;
  readonly artifacts: string;
  readonly scenarios: string;
} {
  return {
    setup: `${SETUP_PREFIXES.auth}${cell}`,
    artifacts: `${SETUP_PREFIXES.artifacts}${cell}`,
    scenarios: cell,
  };
}

/**
 * Which setup a project is, from its name.
 *
 * @param projectName - a project name, as {@link cellProjectNames} builds it.
 * @returns the setup's kind, or `undefined` for a cell's scenarios project.
 */
export function setupKindOf(projectName: string): SetupKind | undefined {
  for (const [kind, prefix] of Object.entries(SETUP_PREFIXES)) {
    if (projectName.startsWith(prefix)) return kind as SetupKind;
  }
  return undefined;
}

/**
 * The cell a project belongs to, from its name: the scenarios project is named after its cell, and
 * each setup after its cell with its prefix.
 *
 * @param projectName - a project name, as {@link cellProjectNames} builds it.
 */
export function cellOfProject(projectName: string): string {
  const kind = setupKindOf(projectName);
  return kind === undefined
    ? projectName
    : projectName.slice(SETUP_PREFIXES[kind].length);
}
