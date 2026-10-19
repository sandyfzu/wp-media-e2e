import "./src/common/config/load-env";

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { env, intEnv } from "./src/common/config/env";
import {
  EXIT,
  PRUNE_USAGE,
  parsePruneArgs,
  runPrune,
} from "./src/common/reporting/prune-command";
import {
  DEFAULT_REPORT_ROOT,
  DEFAULT_RETENTION,
  MAX_REPORTS_KEEP,
} from "./src/common/reporting/retention";

/**
 * `npm run report:prune` — the report retention policy over every cell's reports, a dry run unless
 * `--apply` (`src/common/reporting/prune-command.ts` holds the parser and the command). Reads
 * `REPORT_ROOT` and `E2E_REPORTS_KEEP` as a run does, `.env` included.
 *
 * @returns the exit status: 0 done, 1 a removal failed, 2 bad arguments (a bad `E2E_REPORTS_KEEP`
 *   included).
 */
function main(): number {
  let defaultKeep: number;
  try {
    defaultKeep = intEnv(
      "E2E_REPORTS_KEEP",
      DEFAULT_RETENTION.keep,
      0,
      MAX_REPORTS_KEEP,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT.usage;
  }
  const parsed = parsePruneArgs(process.argv.slice(2), defaultKeep);
  if (parsed.kind === "help") {
    console.log(PRUNE_USAGE);
    return EXIT.ok;
  }
  if (parsed.kind === "error") {
    console.error(`report:prune: ${parsed.message}.\n\n${PRUNE_USAGE}`);
    return EXIT.usage;
  }
  // The repository root, as the configs resolve REPORT_ROOT: this file sits in it.
  const repoRoot = fileURLToPath(new URL(".", import.meta.url));
  const root = resolve(repoRoot, env("REPORT_ROOT", DEFAULT_REPORT_ROOT));
  return runPrune(parsed.options, root, Date.now(), {
    print: (line) => {
      console.log(line);
    },
    cwd: process.cwd(),
  });
}

process.exitCode = main();
