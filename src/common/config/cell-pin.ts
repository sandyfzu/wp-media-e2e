import { isNonEmptyString } from "../guards";

/**
 * The cell pin: `E2E_CELL=<cell>` holds a run to one cell of its product.
 *
 * `bddgen` regenerates the specs of every cell its config holds, deleting each cell's files before
 * writing them again, so a run of one cell could find its specs missing while another cell's run
 * started. `bddgen` takes no `--project`, and npm hands `-- args` to a script's last command only,
 * so the environment is the one channel that reaches `bddgen`, the runner and every worker alike.
 * Pinned, the config holds that cell alone: `bddgen` touches only its specs, and the run selects
 * its three projects without any `--project`.
 */

/** The variable that pins a run to one cell. */
export const CELL_PIN_ENV = "E2E_CELL";

/** Where a pin may come from, for messages: an operator who never typed it set it in `.env`. */
const PIN_SOURCE = "it comes from your environment or from .env";

/**
 * The cell `E2E_CELL` pins this run to, verbatim, or `undefined` when it is unset or blank — the
 * same "blank means unset" rule as every other variable of the suite. Surrounding whitespace is
 * kept, so a stray space fails {@link assertPinKnown} instead of pinning a cell nobody named.
 */
export function pinnedCell(): string | undefined {
  const raw = process.env[CELL_PIN_ENV];
  return isNonEmptyString(raw) ? raw : undefined;
}

/**
 * Refuses a pin that names none of the product's cells.
 *
 * @param pin - the pinned cell, from {@link pinnedCell}.
 * @param product - the product's name.
 * @param cells - the product's cells.
 * @throws {@link Error} naming the variable, its value, the product's cells and the fix.
 */
export function assertPinKnown(
  pin: string,
  product: string,
  cells: readonly string[],
): void {
  if (cells.includes(pin)) return;
  throw new Error(
    `[cell] ${CELL_PIN_ENV}=${JSON.stringify(pin)} is not a cell of ${product}; its cells: ` +
      `${cells.length > 0 ? cells.join(", ") : "(none)"}. Set ${CELL_PIN_ENV} to one of ` +
      `them, or unset it to run without a pin (${PIN_SOURCE}).`,
  );
}

/**
 * Whether Playwright's `--project` filter `filter` selects the project `name`, by Playwright's own
 * rule (`filterProjects`, 1.63): case-insensitive, and each `*` matches any run of characters.
 */
export function matchesProjectFilter(filter: string, name: string): boolean {
  const pattern = filter.toLocaleLowerCase();
  const target = name.toLocaleLowerCase();
  if (!pattern.includes("*")) return pattern === target;
  const source = pattern.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${source}$`, "i").test(target);
}

/** `text` with every regular-expression metacharacter escaped. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Refuses a `--project` that selects none of the pinned cell's projects. Playwright would refuse it
 * too, but as a bare "Project(s) … not found" that never names `E2E_CELL` — a puzzle when the pin
 * came from `.env`. A wildcard that selects none is refused here as well, which is stricter than
 * Playwright (it accepts one such pattern beside others that select): in a pinned run it can only
 * mean another cell.
 *
 * @param pin - the pinned cell, already known to the product.
 * @param pinProjects - the pinned cell's project names.
 * @param selection - the run's `--project` values, verbatim.
 * @throws {@link Error} naming each such value, the pin, its projects and the fix.
 */
export function assertSelectionFitsPin(
  pin: string,
  pinProjects: readonly string[],
  selection: readonly string[],
): void {
  const strays = selection.filter(
    (filter) => !pinProjects.some((name) => matchesProjectFilter(filter, name)),
  );
  if (strays.length === 0) return;
  const named = strays.map((value) => JSON.stringify(value)).join(", ");
  throw new Error(
    `[cell] --project ${named} selects nothing in this run: ${CELL_PIN_ENV} pins it to ` +
      `${JSON.stringify(pin)}, whose projects are ${pinProjects.join(", ")}. Drop --project ` +
      `(the pin selects the cell), or set ${CELL_PIN_ENV} to the cell you meant (${PIN_SOURCE}).`,
  );
}
