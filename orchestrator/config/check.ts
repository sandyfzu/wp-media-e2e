import { isPlaceholderSite } from "../../src/common/config/sites";
import { configProblems, formatPath } from "./parse";
import type { ProductList } from "./product-list";
import type { OrchestratorConfig, TaskConfig } from "./schema";

/** A product of the suite, as the checks read it: its name and its cells. */
export type CheckedProduct = Pick<
  ProductList["PRODUCTS"][number],
  "name" | "sites"
>;

/** One cell of a product: its edition, if any, and its pool of sites. */
export type CellConfig = CheckedProduct["sites"][string];

/** One site of a cell's pool. */
type Site = CellConfig["sites"][number];

/** A task, joined to what the suite knows about its product and cell. */
export interface CheckedTask<P extends CheckedProduct = CheckedProduct> {
  /** The task as configured, defaults applied. */
  readonly task: TaskConfig;
  /** Its product. */
  readonly product: P;
  /** Its cell: the pool the run binds to, every site real. */
  readonly cell: CellConfig;
  /** The servers its sites live on, each once, in pool order (see {@link serverOf}). */
  readonly servers: readonly string[];
}

/** What the start goes on with, and what it should tell the operator first. */
export interface CheckedConfig<P extends CheckedProduct = CheckedProduct> {
  /** Every task, in the file's order. */
  readonly tasks: readonly CheckedTask<P>[];
  /** Nothing that stops a start, everything an operator should read. */
  readonly warnings: readonly string[];
}

/**
 * The server a site lives on, for counting how many tasks load it: an SSH site's host, lowercased;
 * a Docker or local site lives on the machine running the orchestrator.
 *
 * @param site - one site of a pool.
 * @returns the server's name.
 */
export function serverOf(site: Site): string {
  return site.transport.mode === "ssh"
    ? site.transport.host.toLowerCase()
    : "this machine";
}

/**
 * Checks each task against the suite: its product exists, its cell is one of the product's, and that
 * cell's sites are real — not the placeholder data a fresh checkout loads, which a run would skip as
 * "nothing to test". Then lists the warnings: a version set with a `release:` ref, which the suite
 * ignores, and every server reached by `serverWarningThreshold` tasks or more — all tasks loop at once,
 * so that count is how many runs it carries at a time.
 *
 * @param config - a config the schema accepted.
 * @param products - the suite's products (`PRODUCTS`).
 * @param file - the config's path, for the message.
 * @param selected - the ids `--task` selects; every task when absent or empty. Only the selected tasks
 *   run, so only they count towards a server's load.
 * A product or cell the suite does not know is named by its path, never quoted: what sits in its
 * place could be anything pasted there. Once matched, it is the suite's own name and is shown.
 *
 * @returns each task joined to its product and cell, and the warnings.
 * @throws {@link ConfigError} listing every task the suite cannot run, each naming its path.
 */
export function checkConfig<P extends CheckedProduct>(
  config: OrchestratorConfig,
  products: readonly P[],
  file: string,
  selected?: readonly string[],
): CheckedConfig<P> {
  const problems: string[] = [];
  const tasks: CheckedTask<P>[] = [];
  config.tasks.forEach((task, index) => {
    const checked = checkTask(task, index, products);
    if (typeof checked === "string") problems.push(checked);
    else tasks.push(checked);
  });
  if (problems.length > 0)
    throw configProblems(file, "names what the suite cannot run", problems);
  return {
    tasks,
    warnings: [
      ...tasks.flatMap(({ task }, index) => versionIgnored(task, index)),
      ...crowdedServers(
        selected === undefined || selected.length === 0
          ? tasks
          : tasks.filter(({ task }) => selected.includes(task.id)),
        config.serverWarningThreshold,
      ),
    ],
  };
}

/**
 * One task joined to its product and cell, or the line saying why it cannot be.
 *
 * @param task - the task.
 * @param index - its place in `tasks`, for the path.
 * @param products - the suite's products.
 * @returns the joined task, or the problem's line.
 */
function checkTask<P extends CheckedProduct>(
  task: TaskConfig,
  index: number,
  products: readonly P[],
): CheckedTask<P> | string {
  const at = (key: string): string => formatPath(["tasks", index, key]);
  const product = products.find(({ name }) => name === task.product);
  if (product === undefined)
    return `${at("product")}: names no product of the suite; its products: ${products.map(({ name }) => name).join(", ")}`;
  const cell = Object.hasOwn(product.sites, task.cell)
    ? product.sites[task.cell]
    : undefined;
  if (cell === undefined)
    return `${at("cell")}: names no cell of ${product.name}; its cells: ${Object.keys(product.sites).join(", ") || "none"}`;
  const placeholders = cell.sites.filter(isPlaceholderSite).length;
  if (cell.sites.length === 0)
    return `${at("cell")}: ${product.name} ${task.cell} has no sites: give it a pool in the product's sites file`;
  if (placeholders > 0)
    return `${at("cell")}: ${product.name} ${task.cell} has ${String(placeholders)} placeholder site${placeholders === 1 ? "" : "s"} (.example.test) of ${String(cell.sites.length)}: every site a run binds to must be real — declare the cell's real sites in the product's sites file`;
  return {
    task,
    product,
    cell,
    servers: [...new Set(cell.sites.map(serverOf))],
  };
}

/**
 * The warning for a version the suite will ignore: a `release:` ref builds the version its tag
 * names.
 *
 * @param task - the task.
 * @param index - its place in `tasks`, for the path.
 * @returns the warning, or none.
 */
function versionIgnored(task: TaskConfig, index: number): string[] {
  const { ref, version } = task.plugin ?? {};
  return ref?.startsWith("release:") === true && version !== undefined
    ? [
        `${formatPath(["tasks", index, "plugin", "version"])} is ignored: a release: ref builds the version its tag names`,
      ]
    : [];
}

/**
 * One warning per server that `threshold` tasks or more reach, naming its tasks and their cells.
 *
 * @param tasks - every checked task.
 * @param threshold - `serverWarningThreshold`.
 * @returns the warnings, in the order servers first appear.
 */
function crowdedServers(
  tasks: readonly CheckedTask[],
  threshold: number,
): string[] {
  return [...tasksByServer(tasks)]
    .filter(([, reaching]) => reaching.length >= threshold)
    .map(
      ([server, reaching]) =>
        `${server} carries ${String(reaching.length)} task${reaching.length === 1 ? "" : "s"} at once (serverWarningThreshold ${String(threshold)}): ` +
        reaching
          .map(({ task }) => `${task.id} (${task.product} ${task.cell})`)
          .join(", "),
    );
}

/**
 * The tasks each server carries, in the order servers first appear (see {@link serverOf}).
 *
 * @param tasks - checked tasks.
 * @returns each server and its tasks, in their order.
 */
export function tasksByServer<T extends Pick<CheckedTask, "servers">>(
  tasks: readonly T[],
): Map<string, T[]> {
  const byServer = new Map<string, T[]>();
  for (const checked of tasks)
    for (const server of checked.servers)
      byServer.set(server, [...(byServer.get(server) ?? []), checked]);
  return byServer;
}
