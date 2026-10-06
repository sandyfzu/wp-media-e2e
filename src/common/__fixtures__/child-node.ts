import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { isObject } from "../guards";

/**
 * For specs: run ES-module code in a fresh Node. It is how a spec measures what importing a
 * module, or building a config, does to a process; the spec's own worker has imported plenty
 * already. tsx's loader lets the child import the suite's TypeScript as the runners do.
 */

const execFileAsync = promisify(execFile);

/** tsx's loader, resolved from here so any working directory will do. */
const TSX_LOADER = import.meta.resolve("tsx");

/**
 * How long a child may run. One takes under 2 s here; this leaves room for a slow CI runner and
 * stays under the 30 s test timeout, so a hung child fails its test with {@link runInChildNode}'s
 * message rather than the runner's.
 */
export const CHILD_TIMEOUT_MS = 15_000;

/** What a child is given. */
export interface ChildNodeOptions {
  /** Its working directory. */
  readonly cwd: string;
  /** Variables beyond `PATH` and `HOME`, the only ones it inherits. */
  readonly env?: Readonly<Record<string, string>>;
}

/** Why a child failed: killed at the time limit, its exit code, or why it never started. */
function describeChildFailure(error: unknown): string {
  if (!isObject(error)) return String(error);
  const stderr = typeof error.stderr === "string" ? error.stderr : "";
  const how =
    error.killed === true
      ? `killed after ${String(CHILD_TIMEOUT_MS)} ms`
      : typeof error.code === "number"
        ? `exit ${String(error.code)}`
        : String(error.code ?? error.message);
  return `${how}: ${stderr}`;
}

/**
 * Runs `body` — ES module code, top-level `await` allowed — and returns the JSON it printed on
 * its last stdout line. Asynchronous, so the calling test's own timeout can still interrupt it.
 *
 * @throws {@link Error} naming the exit code, or the time limit, and the child's stderr.
 */
export async function runInChildNode(
  body: string,
  options: ChildNodeOptions,
): Promise<unknown> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      process.execPath,
      ["--import", TSX_LOADER, "--input-type=module", "--eval", body],
      {
        cwd: options.cwd,
        encoding: "utf8",
        timeout: CHILD_TIMEOUT_MS,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          ...options.env,
        },
      },
    ));
  } catch (error) {
    // The argv is the caller's own probe code, and the env holds nothing secret.
    throw new Error(`child Node failed (${describeChildFailure(error)})`, {
      cause: error,
    });
  }
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
}

/**
 * `path` — absolute — as a JS string literal of its `file:` URL, to embed in a child's
 * `import()`.
 *
 * @example
 * ```ts
 * await runInChildNode(`await import(${importable(file)});`, { cwd });
 * ```
 */
export function importable(path: string): string {
  return JSON.stringify(pathToFileURL(path).href);
}
