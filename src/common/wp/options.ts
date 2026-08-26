import { wpCli } from "./exec";
import type { Transport } from "../config/types";

/**
 * Reading WordPress options over WP-CLI.
 *
 * Options are where a plugin keeps the state a UI assertion can only observe indirectly — whether
 * a user still owes onboarding, how a job was configured, what a save actually persisted. Reading them
 * gives a scenario a **second source** for those claims, independent of the DOM that rendered them.
 *
 * Two rules shape the API:
 *
 *  - **"Not set" is an answer, not a failure.** `wp option get` exits non-zero for a missing option
 *    *and* for a WordPress that cannot boot, so the two are told apart by WP-CLI's own message
 *    ({@link NOT_SET}). A missing option returns `undefined`; anything else throws, because
 *    silently reporting a broken site as "no such option" is exactly the false negative these
 *    readers exist to prevent.
 *  - **Values are returned as WP-CLI printed them.** Callers that need structure use
 *    {@link getOptionJson}, which asks WP-CLI to serialise the stored PHP value rather than
 *    parsing its display format here.
 *
 * Single-site only: a *network* option on multisite lives behind `wp site option`. Every site this
 * suite drives is single-site, where the two are the same row.
 */

/**
 * WP-CLI's wording when the option simply is not set — the one non-zero exit that is an answer
 * rather than a fault. Matched loosely (the option name sits in the middle) so a WP-CLI wording
 * tweak degrades to "throws with the message" rather than to a wrong `undefined`.
 */
const NOT_SET = /could not get .*option\.\s*does it exist\?/i;

/** Runs `wp option get <name> [args…]`, mapping "not set" to `undefined`. */
async function readOption(
  transport: Transport,
  name: string,
  extraArgs: readonly string[] = [],
): Promise<string | undefined> {
  const argv = ["option", "get", name, ...extraArgs];
  const { stdout, stderr, exitCode } = await wpCli(transport, argv);
  if (exitCode === 0) return stdout;

  const output = `${stdout}\n${stderr}`;
  if (NOT_SET.test(output)) return undefined;
  throw new Error(
    `[wp/options] \`wp ${argv.join(" ")}\` exited ${String(exitCode)}: ` +
      (output.trim() || "(no output)"),
  );
}

/**
 * The raw value of a WordPress option, or `undefined` when it is not set.
 *
 * An option set to an empty string returns `""` — distinct from `undefined`, so "present but
 * empty" and "absent" stay distinguishable.
 *
 * @param transport - the site to ask.
 * @param name - the option name.
 * @throws {@link Error} if WP-CLI failed for any reason other than the option being absent.
 */
export function getOption(
  transport: Transport,
  name: string,
): Promise<string | undefined> {
  return readOption(transport, name);
}

/**
 * A WordPress option deserialised from JSON, or `undefined` when it is not set.
 *
 * WP-CLI unserialises the stored PHP value and re-encodes it, so an option holding an array or
 * object arrives as real JSON. **A PHP array is not always a JSON array**: WP-CLI emits an object
 * whenever the keys are not a 0-based sequence, which happens as soon as a plugin removes an entry
 * from the middle of a list. Callers that expect a list must accept both shapes.
 *
 * @typeParam T - the caller's expectation of the decoded shape. Unverified at runtime, so narrow
 * it at the point of use.
 * @param transport - the site to ask.
 * @param name - the option name.
 * @throws {@link Error} if the option is set but its output is not JSON — that means the read
 * itself is broken, and returning `undefined` would read as "not configured".
 */
export async function getOptionJson<T>(
  transport: Transport,
  name: string,
): Promise<T | undefined> {
  const raw = await readOption(transport, name, ["--format=json"]);
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new Error(
      `[wp/options] option "${name}" did not decode as JSON. Output was: ${trimmed.slice(0, 500)}`,
    );
  }
}
