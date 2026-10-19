import type { z } from "zod";

import { ConfigError } from "./errors";
import { configSchema, type OrchestratorConfig } from "./schema";

/**
 * A key shown as written: a name shaped as the settings' and secrets' names are — camelCase words
 * (`cooldownMinutes`), snake_case words (`cooldown_minutes`), an uppercase word (`PATH`), or UPPER_SNAKE
 * words with digits after the first letter (`BWP_S3_SECRET`, `BWP_`); 40 characters at most
 * ({@link MAX_SHOWN_KEY}). A credential pasted in a key's place is random: digits in a lowercase or
 * camelCase run (a legacy 40-hex token, `sk_live_4eC3…`), or uppercase and digits with no `_` (an AWS
 * key ID), none of which a name holds.
 */
const SHOWN_KEY =
  /^(?:[a-z]+(?:[A-Z][a-z]+)*|[a-z]+(?:_[a-z]*)+|[A-Z]+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]*)+)$/;

/** The longest key shown as written. */
const MAX_SHOWN_KEY = 40;

/** The prefixes of GitHub's tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`). */
const GITHUB_TOKEN_PREFIX = /^(gh[pousr]_|github_pat_)/;

/**
 * A key as a message may show it. Keys are names, but a pasted credential can land in a key's place
 * (`"ghp_…": "GITHUB_TOKEN"`), and a key can hold anything — a newline that forges a line, a
 * terminal escape. So only a name ({@link SHOWN_KEY}) is shown, and never one shaped like a GitHub
 * token; any other key is described by its length alone. A credential of letters alone that reads as
 * a name cannot be told from one, and is shown.
 *
 * @param key - a key read from the file.
 * @returns the key, or `a key of N characters`.
 */
export function describeKey(key: string): string {
  return key.length <= MAX_SHOWN_KEY &&
    SHOWN_KEY.test(key) &&
    !GITHUB_TOKEN_PREFIX.test(key)
    ? key
    : `a key of ${String(key.length)} characters`;
}

/**
 * A path in the config, as an operator would write it: `tasks[1].cell`, `secrets.GH_TOKEN`; a key
 * {@link describeKey} would not show becomes `[a key of N characters]`. The file itself is `(root)`.
 *
 * @param path - keys and indexes.
 * @returns the path as text.
 */
export function formatPath(path: readonly PropertyKey[]): string {
  let text = "";
  for (const key of path) {
    if (typeof key === "number") text += `[${String(key)}]`;
    else {
      const shown = describeKey(String(key));
      if (shown !== String(key)) text += `[${shown}]`;
      else text += text === "" ? shown : `.${shown}`;
    }
  }
  return text === "" ? "(root)" : text;
}

/**
 * What is wrong, in words. Zod quotes an unknown key raw, so that message is rebuilt with
 * {@link describeKey}; a record's refused key arrives wrapped in a generic "Invalid key in record",
 * the key schema's own message inside it.
 *
 * @param issue - one issue the schema found.
 * @returns the message.
 */
function messageOf(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "unrecognized_keys":
      return `no such setting: ${issue.keys.map(describeKey).join(", ")}`;
    case "invalid_key":
      return issue.issues[0]?.message ?? issue.message;
    default:
      return issue.message;
  }
}

/**
 * One line per issue — its path and what is wrong — in the schema's order of fields, the checks
 * across tasks last. Zod's own messages name types and bounds, never the value read; every message
 * of the schema is written the same way; keys go through {@link describeKey}. So no line quotes a
 * credential, and none can forge another.
 *
 * @param issues - what the schema found.
 * @returns the lines.
 */
export function formatIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.map(
    (issue) => `${formatPath(issue.path)}: ${messageOf(issue)}`,
  );
}

/**
 * The error for a config with problems: a heading naming the file, then one indented line each.
 *
 * @param file - the config's path.
 * @param heading - what kind of problems, after the file (`is invalid`).
 * @param lines - one per problem.
 * @returns the error, to throw.
 */
export function configProblems(
  file: string,
  heading: string,
  lines: readonly string[],
): ConfigError {
  return new ConfigError(
    [
      `The orchestrator config ${file} ${heading}:`,
      ...lines.map((line) => `  ${line}`),
    ].join("\n"),
  );
}

/**
 * Validates a parsed config file against {@link configSchema}, defaults applied.
 *
 * @param value - the file's JSON, parsed.
 * @param file - the file's path, for the message.
 * @returns the config.
 * @throws {@link ConfigError} listing every issue, one per line, each naming its path.
 */
export function parseConfig(value: unknown, file: string): OrchestratorConfig {
  const result = configSchema.safeParse(value);
  if (result.success) return result.data;
  throw configProblems(file, "is invalid", formatIssues(result.error.issues));
}
