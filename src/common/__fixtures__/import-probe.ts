import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { isObject } from "../guards";
import { execInChildNode } from "./child-node";

/**
 * For specs: what importing a module does to the process-wide state a long-lived process (the
 * orchestrator) keeps for its whole life — its environment variables, its listeners on process
 * events (one `SIGINT` listener is enough to turn off Node's exit on Ctrl-C), its working directory
 * and its exit code. Output written and globals set are not compared; nor is anything a module
 * starts later than its import, from a function or an unref'd timer.
 */

/** The variable the probe's `.env` sets: a module that loads `.env` shows it among its effects. */
export const PROBE_SENTINEL = "E2E_PROBE_SENTINEL";

/** The entry for what changed after the last import's reading, by the time the process went idle. */
export const SETTLED = "(once the imports settled)";

/** One imported file — or {@link SETTLED} — and what changed in the process after it. */
export interface ImportEffects {
  /** The file, as the caller named it, or {@link SETTLED}. */
  readonly file: string;
  /**
   * What changed, sorted: `env <NAME>` (added, changed or removed), `listener <event> <±n>`, `cwd`,
   * `exitCode`. Empty when the process was left as it was.
   */
  readonly effects: readonly string[];
}

/** Narrows the result file's JSON to the list {@link probeImports} returns. */
function isImportEffectsList(value: unknown): value is ImportEffects[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry: unknown) =>
        isObject(entry) &&
        typeof entry.file === "string" &&
        Array.isArray(entry.effects) &&
        entry.effects.every((effect: unknown) => typeof effect === "string"),
    )
  );
}

/**
 * The child's code: import each file, let it run one turn of the event loop — a change it deferred
 * with `setImmediate` is still its own — then read the process; once nothing is left to run,
 * `beforeExit` reads it a last time and writes the result to `resultFile`. A file, not stdout: a
 * module may print, even as the process exits, and must not be able to forge or garble the verdict.
 */
function probeBody(files: readonly string[], resultFile: string): string {
  return `
    import { writeFileSync } from "node:fs";
    import { pathToFileURL } from "node:url";

    const snapshot = () => ({
      env: { ...process.env },
      listeners: Object.fromEntries(
        process.eventNames().map((name) => [String(name), process.listenerCount(name)]),
      ),
      cwd: process.cwd(),
      exitCode: process.exitCode,
    });
    const changes = (before, after) => {
      const effects = [];
      for (const key of new Set([...Object.keys(before.env), ...Object.keys(after.env)])) {
        if (before.env[key] !== after.env[key]) effects.push("env " + key);
      }
      for (const name of new Set([...Object.keys(before.listeners), ...Object.keys(after.listeners)])) {
        const delta = (after.listeners[name] ?? 0) - (before.listeners[name] ?? 0);
        if (delta !== 0) effects.push("listener " + name + " " + (delta > 0 ? "+" : "") + delta);
      }
      if (before.cwd !== after.cwd) effects.push("cwd");
      if (before.exitCode !== after.exitCode) effects.push("exitCode");
      return effects.sort();
    };

    const results = [];
    let settled = false;
    // Registered before the first reading, so the probe's own listener is part of the baseline.
    process.on("beforeExit", () => {
      if (settled) return;
      settled = true;
      results.push({ file: ${JSON.stringify(SETTLED)}, effects: changes(last, snapshot()) });
      writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(results));
      // An exit code a module set is reported above; the child itself succeeded.
      process.exitCode = 0;
    });
    let last = snapshot();
    for (const file of ${JSON.stringify(files)}) {
      await import(pathToFileURL(file).href);
      await new Promise((resolve) => setImmediate(resolve));
      const now = snapshot();
      results.push({ file, effects: changes(last, now) });
      last = now;
    }
  `;
}

/**
 * Imports `files` — absolute paths — one after another in a fresh Node, and returns what each import
 * changed in the process, then what changed after the last one ({@link SETTLED}). The child starts in
 * a folder of its own whose `.env` sets {@link PROBE_SENTINEL}, so it never reads the repository's
 * `.env`, and a module that loads `.env` is caught. A change is charged to the first file whose import
 * made it, transitive imports included: a module an earlier file loaded is not run again.
 *
 * @throws {@link Error} for a relative path; when an import fails, the child times out (a module keeps
 * the event loop busy), or a module ends the process, so the probe never finished; for a result it
 * cannot read.
 */
export async function probeImports(
  files: readonly string[],
): Promise<ImportEffects[]> {
  const relative = files.find((file) => !isAbsolute(file));
  if (relative !== undefined) {
    throw new Error(`probeImports needs absolute paths, got "${relative}"`);
  }
  const dir = await mkdtemp(join(tmpdir(), "e2e-import-probe-"));
  try {
    await writeFile(join(dir, ".env"), `${PROBE_SENTINEL}=from-dotenv\n`);
    const resultFile = join(dir, "result.json");
    const output = await execInChildNode(probeBody(files, resultFile), {
      cwd: dir,
    });
    const text = await readFile(resultFile, "utf8").catch(() => {
      throw new Error(
        "the import probe never finished: a module ended the process during its import " +
          `(stdout: ${output.stdout.trim().slice(-500)}; stderr: ${output.stderr.trim().slice(-500)})`,
      );
    });
    const result: unknown = JSON.parse(text);
    if (!isImportEffectsList(result)) {
      throw new Error(`the import probe wrote an unexpected result: ${text}`);
    }
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
