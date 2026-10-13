import { stripVTControlCharacters } from "node:util";

import { maskValues, plain, redactSecrets } from "../src/common/text";

/**
 * Small string helpers for what the orchestrator shows or sends — a run's reason, an error in an
 * event, a failure in its log: cut to a size, made one line, and masked of credentials.
 */

/**
 * At most `max` code points of `text`, an ellipsis closing a cut one. Cut by code point, so a cut
 * never splits a surrogate pair.
 *
 * @param text - the text.
 * @param max - the most code points kept, the ellipsis included.
 * @returns the text, cut when longer.
 * @throws {@link RangeError} when `max` is not a whole number from 1.
 */
export function cut(text: string, max: number): string {
  if (!Number.isSafeInteger(max) || max < 1)
    throw new RangeError(
      `A cut keeps a whole number of characters from 1, got ${String(max)}.`,
    );
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/**
 * Text as one line a reader can trust: the suite's {@link plain} — terminal codes removed, control
 * characters and line separators made spaces, invisible format characters dropped — then every run of
 * whitespace one space.
 *
 * @param text - the text.
 * @returns the line.
 */
export function oneLine(text: string): string {
  return plain(text).replace(/\s+/g, " ");
}

/** C0 and C1 controls and DEL, but the line feed and the tab — what a block of text keeps. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL_BUT_LINES = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Invisible format characters: bidi overrides, zero-width spaces and joiners, soft hyphens. */
const FORMAT = /\p{Cf}/gu;

/**
 * `text` with every credential masked: by its shape ({@link redactSecrets}), and by the value of every
 * secret the orchestrator holds ({@link maskValues}; values under 8 characters are not masked, as
 * they would mask ordinary words). The longest value first: a value inside a longer one, masked
 * first, would leave the longer one's rest in clear.
 *
 * @param text - the text.
 * @param secrets - the secret values to mask wherever they appear, in any order.
 * @returns the masked text.
 */
function mask(text: string, secrets: readonly string[]): string {
  const longestFirst = [...secrets].sort((a, b) => b.length - a.length);
  return maskValues(redactSecrets(text), longestFirst);
}

/**
 * What a tool or a run said, as one line safe to log or post: masked, made {@link oneLine}, masked
 * again, then cut. Masked on both sides, because each side misses what the other catches: a
 * credential split by a terminal code or a zero-width character is whole only once the line is clean,
 * while a URL whose password holds a control character is recognisable only before it becomes a
 * space. Cut last, so a cut cannot split a credential from what marks it.
 *
 * @param text - the text.
 * @param max - the most code points kept.
 * @param secrets - secret values to mask wherever they appear.
 * @returns the line.
 */
export function safeLine(
  text: string,
  max: number,
  secrets: readonly string[] = [],
): string {
  return cut(mask(oneLine(mask(text, secrets)), secrets), max);
}

/**
 * Like {@link safeLine}, but its lines are kept — an assertion's diff reads by line: terminal codes
 * removed, every other control character but the line feed and the tab a space, invisible format
 * characters dropped, carriage returns and line separators made line feeds.
 *
 * @param text - the text.
 * @param max - the most code points kept.
 * @param secrets - secret values to mask wherever they appear.
 * @returns the text, safe to show.
 */
export function safeBlock(
  text: string,
  max: number,
  secrets: readonly string[] = [],
): string {
  const clean = stripVTControlCharacters(mask(text, secrets))
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, "\n")
    .replace(CONTROL_BUT_LINES, " ")
    .replace(FORMAT, "")
    .trim();
  return cut(mask(clean, secrets), max);
}
