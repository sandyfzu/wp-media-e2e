/**
 * The names of the variables that set how a run goes and what it is called — read by the config
 * factory (`project.ts`), set by the orchestrator. One spelling for both, so neither can drift from
 * the other. Free of side effects, so the orchestrator can import it.
 */

/** The retries a failed scenario gets (`0`–`10`, 2 by default). */
export const RETRIES_ENV = "E2E_RETRIES";

/** How many reports the cell's report folder keeps as the run ends (`0` lifts the cap). */
export const REPORTS_KEEP_ENV = "E2E_REPORTS_KEEP";

/** What the run is called, in its reports: display only. */
export const RUN_NAME_ENV = "E2E_RUN_NAME";

/** The plugin ref the run was asked for, where it may be pinned to a commit: display only. */
export const REQUESTED_REF_ENV = "E2E_REQUESTED_REF";
