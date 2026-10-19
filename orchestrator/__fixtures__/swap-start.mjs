import { registerHooks } from "node:module";

/**
 * For specs, preloaded through `NODE_OPTIONS=--import=<this file>`: makes the real
 * `orchestrator/command.ts` import `__fixtures__/fake-start.ts` where it imports `./start`, and nothing
 * else changes — so the `orchestrator` script, `cli.ts` and `command.ts` run as they are, over the fake
 * suite. Plain JavaScript, as it loads before tsx; `NODE_OPTIONS` reaches every Node the script starts,
 * so whatever the script runs, no real run can start.
 */

/** The stand-in `start.ts`. */
const FAKE_START = new URL("./fake-start.ts", import.meta.url).href;

registerHooks({
  /**
   * Resolves `./start` from `command.ts` to the stand-in; anything else as before.
   *
   * @param {string} specifier - what is imported.
   * @param {{ parentURL?: string }} context - who imports it.
   * @param {(specifier: string, context: object) => object} nextResolve - the next hook.
   * @returns {object} the resolution.
   */
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "./start" &&
      context.parentURL?.endsWith("/orchestrator/command.ts") === true
    )
      return { url: FAKE_START, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
