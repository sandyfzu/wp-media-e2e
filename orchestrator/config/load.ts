import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkConfig, type CheckedProduct, type CheckedTask } from "./check";
import { ConfigError } from "./errors";
import { lostKeys } from "./json-keys";
import { configProblems, parseConfig } from "./parse";
import type { OrchestratorConfig } from "./schema";

/** Where the config lives unless `--config` says otherwise: `.orchestrator/` in the checkout. */
export const DEFAULT_CONFIG_PATH = fileURLToPath(
  new URL("../../.orchestrator/config.json", import.meta.url),
);

/** The largest config read. A real one is a few kilobytes; anything near this is not a config. */
export const MAX_CONFIG_BYTES = 1024 * 1024;

/** A config loaded and checked: what the command starts with. */
export interface LoadedConfig<P extends CheckedProduct = CheckedProduct> {
  /** The config file, absolute. */
  readonly file: string;
  /** The orchestrator's state directory: the config file's own, so `--config` is the one switch. */
  readonly stateDir: string;
  /** The config, defaults applied. */
  readonly config: OrchestratorConfig;
  /** Every task, joined to its product and cell. */
  readonly tasks: readonly CheckedTask<P>[];
  /** What the start should say before it runs anything. */
  readonly warnings: readonly string[];
}

/**
 * Reads, validates and checks the orchestrator's config. Every failure is a {@link ConfigError}
 * naming the file and, for content, each path at fault; none quotes the file, which holds secrets.
 *
 * @param file - the config's path; relative to the working directory.
 * @param products - the suite's products (`loadProductList().PRODUCTS`).
 * @returns the config, its tasks joined to the suite, and the warnings — a file others can read
 *   among them.
 * @throws {@link ConfigError} when the file is missing, unreadable, not a regular file, too large,
 *   not UTF-8, not JSON, loses a key, or is invalid.
 *
 * @example
 * ```ts
 * const { PRODUCTS } = await loadProductList();
 * const { tasks, warnings } = await loadConfig(DEFAULT_CONFIG_PATH, PRODUCTS);
 * ```
 */
export async function loadConfig<P extends CheckedProduct>(
  file: string,
  products: readonly P[],
): Promise<LoadedConfig<P>> {
  const path = resolve(file);
  const { mode, bytes } = await readConfigFile(path);
  const text = decodeUtf8(bytes, path);
  const json = parseJson(text, path);
  const lost = lostKeys(text);
  if (lost.length > 0) throw configProblems(path, "loses keys", lost);
  const config = parseConfig(json, path);
  const { tasks, warnings } = checkConfig(config, products, path);
  return {
    file: path,
    stateDir: dirname(path),
    config,
    tasks,
    warnings: [...modeWarning(mode, path), ...warnings],
  };
}

/**
 * The file's permission bits and bytes. Opened once — non-blocking, so a FIFO cannot hang the open —
 * and checked, measured and read through that one handle, so the file cannot be swapped between the
 * check and the read.
 *
 * @param path - the config, absolute.
 * @returns its `stat` mode and content.
 * @throws {@link ConfigError} when it is not there, not a regular file, too large or unreadable.
 */
async function readConfigFile(
  path: string,
): Promise<{ mode: number; bytes: Uint8Array }> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile())
      throw new ConfigError(`The orchestrator config ${path} is not a file.`);
    const bytes = await readAtMost(handle, MAX_CONFIG_BYTES + 1);
    if (bytes.length > MAX_CONFIG_BYTES)
      throw new ConfigError(
        `The orchestrator config ${path} is over the ${String(MAX_CONFIG_BYTES)} bytes a config can be.`,
      );
    return { mode: info.mode, bytes };
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      codeOf(error) === "ENOENT"
        ? `No orchestrator config at ${path}: copy orchestrator/config.example.json there, chmod 600, and fill it in.`
        : `The orchestrator config ${path} cannot be read (${codeOf(error) ?? "unknown error"}).`,
    );
  } finally {
    await handle?.close();
  }
}

/**
 * Reads from the start of `handle` until its end or `limit` bytes, whichever comes first — never
 * more, however large the file is or grows.
 *
 * @param handle - an open file.
 * @param limit - the most bytes to read.
 * @returns what was read.
 */
async function readAtMost(
  handle: FileHandle,
  limit: number,
): Promise<Uint8Array> {
  const buffer = new Uint8Array(limit);
  let length = 0;
  while (length < limit) {
    const { bytesRead } = await handle.read(
      buffer,
      length,
      limit - length,
      length,
    );
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  return buffer.subarray(0, length);
}

/**
 * A Node system error's code (`ENOENT`, `EACCES`), if `error` has one.
 *
 * @param error - what was thrown.
 * @returns the code, or `undefined`.
 */
function codeOf(error: unknown): string | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

/**
 * The file's text. Bytes that are not UTF-8 are refused rather than replaced: replaced, they would
 * silently change a secret (`café` in Latin-1 becomes `caf�`). A leading byte-order mark is
 * dropped.
 *
 * @param bytes - the file's content.
 * @param path - the config, for the message.
 * @returns the text.
 * @throws {@link ConfigError} when the bytes are not UTF-8.
 */
export function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ConfigError(
      `The orchestrator config ${path} is not UTF-8: save it as UTF-8.`,
    );
  }
}

/**
 * The file's JSON. A syntax error is named by where it is, never by `JSON.parse`'s own message,
 * which quotes the text around it — a secret included.
 *
 * @param text - the file's text.
 * @param path - the config, for the message.
 * @returns the parsed value.
 * @throws {@link ConfigError} when the text is not JSON.
 */
export function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    // V8 says where, in digits: "… at position 25 (line 1 column 26)".
    const where =
      error instanceof Error
        ? /at position \d+(?: \(line \d+ column \d+\))?/.exec(error.message)
        : null;
    throw new ConfigError(
      `The orchestrator config ${path} is not valid JSON${where === null ? "" : ` (${where[0]})`}.`,
    );
  }
}

/**
 * `path` as one word of a POSIX shell command: as it is when it holds only characters no shell
 * treats specially, else in single quotes.
 *
 * @param path - a file path.
 * @returns the quoted path.
 */
export function shellWord(path: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(path)
    ? path
    : `'${path.replaceAll("'", `'\\''`)}'`;
}

/**
 * The warning for a config others can read or write: it holds the run's secrets, so it should be
 * `0600` like the sites files.
 *
 * @param mode - the file's `stat` mode.
 * @param path - the config, for the message.
 * @returns the warning, or none.
 */
export function modeWarning(mode: number, path: string): string[] {
  const bits = mode & 0o777;
  return (bits & 0o077) === 0
    ? []
    : [
        `${path} is mode ${bits.toString(8).padStart(4, "0")} and holds secrets: chmod 600 ${shellWord(path)}`,
      ];
}
