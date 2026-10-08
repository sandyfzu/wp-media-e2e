/**
 * Side-effect module: load `.env` into `process.env` before any configuration reads it. Imported
 * first by every product Playwright config and every script entry point (healthcheck, artifact
 * warm, fixture capture, the report scripts) — never by the unit config. ESM modules are
 * singletons, so it runs once per process; each process of a run — `bddgen`, the runner, its
 * workers — imports it.
 *
 * Real environment variables (e.g. CI secrets) win over the file, even blank ones.
 * `E2E_LOAD_DOTENV=false` in the environment skips the file altogether. The policy is in
 * `dotenv.ts`.
 */

import { resolve } from "node:path";

import { DOTENV_FILE, describeIgnoredSwitch, loadDotenv } from "./dotenv";

const outcome = loadDotenv(resolve(DOTENV_FILE));
if (outcome.kind === "loaded" && outcome.ignoredSwitch !== undefined)
  console.warn(describeIgnoredSwitch(outcome.path, outcome.ignoredSwitch));
