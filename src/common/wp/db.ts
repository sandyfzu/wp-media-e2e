import { wpCli } from "./exec";
import type { Transport } from "../config/types";

/** Runs a SQL statement via `wp db query` and returns its stdout. Throws on a non-zero exit. */
export async function dbQuery(
  transport: Transport,
  sql: string,
): Promise<string> {
  const { stdout, stderr, exitCode } = await wpCli(transport, [
    "db",
    "query",
    sql,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `[wp/db] query failed (exit ${String(exitCode)}): ${(stderr || stdout).trim()}`,
    );
  }
  return stdout;
}
