import { isObject } from "../guards";
import {
  RESULTS_EVENT_TYPES,
  RESULTS_SCHEMA_VERSION,
  type ResultsEvent,
} from "./results-schema";

/**
 * Reads a results stream (`results-schema.ts`) while it is still being written: only complete lines
 * count, so a reader polling the file never parses a line the runner is half-way through, and the
 * rest is handed back to be read again with the next chunk.
 */

/** What one chunk of the stream held. */
export interface ResultsChunk {
  /** The complete lines that are version 1 events, in order. */
  readonly events: readonly ResultsEvent[];
  /**
   * How many complete lines were skipped: not JSON, another version, or a type this reader does not
   * know — each ignored, never fatal, as the schema promises.
   */
  readonly skipped: number;
  /** The text after the last newline: a line still being written. Prepend it to the next chunk. */
  readonly rest: string;
}

/**
 * Parses a chunk of the stream.
 *
 * @param text - what was read, after the previous chunk's `rest`.
 * @example
 * ```ts
 * let pending = "";
 * for (const chunk of chunks) {
 *   const { events, rest } = parseResults(pending + chunk);
 *   pending = rest;
 *   events.forEach(handle);
 * }
 * ```
 */
export function parseResults(text: string): ResultsChunk {
  const end = text.lastIndexOf("\n");
  const complete = end === -1 ? "" : text.slice(0, end);
  const rest = text.slice(end + 1);
  const events: ResultsEvent[] = [];
  let skipped = 0;
  for (const line of complete.split("\n")) {
    if (line.trim() === "") continue;
    const event = parseLine(line);
    if (event === undefined) skipped += 1;
    else events.push(event);
  }
  return { events, skipped, rest };
}

/** One line as a version 1 event, or `undefined` when it is not one. */
function parseLine(line: string): ResultsEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (
    !isObject(value) ||
    value.v !== RESULTS_SCHEMA_VERSION ||
    typeof value.at !== "string" ||
    typeof value.type !== "string" ||
    !RESULTS_EVENT_TYPES.has(value.type as ResultsEvent["type"])
  ) {
    return undefined;
  }
  // The writer is this suite's own reporter, so a known type's fields are trusted as written.
  return value as unknown as ResultsEvent;
}
