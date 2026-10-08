/**
 * Loading `.env` into the environment, and the switch that turns it off.
 *
 * The policy lives here, free of side effects, so a spec can drive it; `load-env.ts` runs it once
 * per process. The switch exists for a caller that hands a run its whole environment — the
 * orchestrator: blanking the variables it knows would still let any other key in `.env` reach the
 * run, so it turns the file off instead.
 */

import { lstatSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

import { isNonEmptyString, isObject } from "../guards";
import { boolEnv, parseBoolean } from "./env";

/** `false`/`0` skips `.env` in every process of a run. Read from the real environment only. */
export const DOTENV_SWITCH_ENV = "E2E_LOAD_DOTENV";

/** The file loaded, relative to the working directory — Node's own default. */
export const DOTENV_FILE = ".env";

/** What {@link loadDotenv} did. */
export type DotenvOutcome =
  | { readonly kind: "off" }
  | { readonly kind: "absent"; readonly path: string }
  | {
      readonly kind: "loaded";
      readonly path: string;
      /** The keys it set — those the environment did not already hold — in no particular order. */
      readonly applied: readonly string[];
      /** The switch's value when the file — not the environment — supplied it; it had no effect. */
      readonly ignoredSwitch: string | undefined;
    };

/**
 * Reads the file, or `undefined` when there is none.
 *
 * @throws {@link Error} when it exists but cannot be read (a directory, no permission, a link to
 *   a missing file): a file silently skipped would run with values nobody chose.
 */
export function readDotenvFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code =
      isObject(error) && typeof error.code === "string"
        ? error.code
        : undefined;
    // A dangling link reads as ENOENT too, but someone put it there to be read.
    const dangling =
      code === "ENOENT" &&
      lstatSync(path, { throwIfNoEntry: false }) !== undefined;
    if (code === "ENOENT" && !dangling) return undefined;
    const reason = dangling
      ? "a link to a missing file"
      : (code ?? String(error));
    throw new Error(
      `Cannot read "${path}" (${reason}). Fix or remove it, or set ` +
        `${DOTENV_SWITCH_ENV}=false to run without it.`,
      { cause: error },
    );
  }
}

/**
 * Sets each key of `content` the environment does not already hold — a real variable wins, even a
 * blank one, as with `process.loadEnvFile()`, whose parser `parseEnv` is. Presence is an own key,
 * so a key named like an `Object` member (`toString`) is set, not taken as present.
 *
 * The switch itself is checked before the file is read, so a copy in the file cannot act. It is
 * still set when valid, so the processes a run forks inherit it as present and do not repeat the
 * warning (with `false`, they also skip the file, whose keys they inherited); an invalid one is
 * dropped rather than handed to them to throw on.
 *
 * @returns the keys set, and the switch's value if the file supplied a non-blank one.
 */
export function applyDotenv(
  content: string,
  target: NodeJS.ProcessEnv,
): { applied: string[]; ignoredSwitch: string | undefined } {
  const applied: string[] = [];
  let ignoredSwitch: string | undefined;
  for (const [key, value] of Object.entries(parseEnv(content))) {
    if (value === undefined || Object.hasOwn(target, key)) continue;
    if (key === DOTENV_SWITCH_ENV && isNonEmptyString(value)) {
      ignoredSwitch = value;
      if (parseBoolean(value) === undefined) continue;
    }
    target[key] = value;
    applied.push(key);
  }
  return { applied, ignoredSwitch };
}

/**
 * Loads `path` into `target` unless {@link DOTENV_SWITCH_ENV} turns it off.
 *
 * @param read - Reads the file; injectable for specs.
 * @throws {@link Error} on a switch that is not a boolean, naming its value, or a file that
 *   exists but cannot be read.
 */
export function loadDotenv(
  path: string,
  target: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string | undefined = readDotenvFile,
): DotenvOutcome {
  if (!boolEnv(DOTENV_SWITCH_ENV, true, target)) return { kind: "off" };
  const content = read(path);
  if (content === undefined) return { kind: "absent", path };
  return { kind: "loaded", path, ...applyDotenv(content, target) };
}

/** The warning for a switch found in the file, which is already being read by then. */
export function describeIgnoredSwitch(path: string, value: string): string {
  return (
    `[env] ${DOTENV_SWITCH_ENV}=${value} in "${path}" has no effect: the switch is read ` +
    "before the file, so the file was loaded anyway. Remove it from the file; to skip the " +
    `file, set it in the environment (${DOTENV_SWITCH_ENV}=false npm run …).`
  );
}
