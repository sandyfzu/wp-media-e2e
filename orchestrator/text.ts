import { stripVTControlCharacters } from "node:util";

import {
  MIN_MASKED_LENGTH,
  maskValues,
  plain,
  redactSecrets,
} from "../src/common/text";

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
 * `text` with every credential masked: by the value of every secret the orchestrator holds
 * ({@link maskValues}) — each also as a URL, a form or a JSON string writes it ({@link secretForms}),
 * since a service's answer may echo it so —, then by its shape ({@link redactSecrets}). Values first:
 * a shape matching inside a secret (`pwd=…`, a token's head) masks that part alone and leaves the rest
 * of the secret in clear, which no value then matches. A secret under {@link MIN_MASKED_LENGTH} (8)
 * characters, spaces around it aside, is masked in no form: it would mask ordinary words. The longest
 * form first: a value inside a longer one, masked first, would leave the longer one's rest in clear.
 *
 * @param text - the text.
 * @param secrets - the secret values to mask wherever they appear, in any order.
 * @returns the masked text.
 */
function mask(text: string, secrets: readonly string[]): string {
  const forms = secrets
    .filter((secret) => secret.trim().length >= MIN_MASKED_LENGTH)
    .flatMap(secretForms);
  const longestFirst = [...new Set(forms)].sort((a, b) => b.length - a.length);
  return redactSecrets(maskValues(text, longestFirst));
}

/**
 * Percent escapes with lowercase hex digits (`%2f`), as some encoders write them; a URL reads both
 * cases alike.
 *
 * @param encoded - percent-encoded text, its escapes uppercase.
 * @returns the same text, its escapes lowercase.
 */
function lowercaseEscapes(encoded: string): string {
  return encoded.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
}

/**
 * URL-encoded text with `!`, `'`, `(`, `)` and `*` escaped too, as RFC 3986 encoders do — PHP's
 * `rawurlencode` over `encodeURIComponent`'s output, its `urlencode` over a form's.
 *
 * @param encoded - percent-encoded text.
 * @returns it, those five escaped.
 */
function escapeMarks(encoded: string): string {
  return encoded.replace(
    /[!'()*]/g,
    (mark) => `%${mark.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * A JSON string's content with every character past ASCII escaped as `\uXXXX` — lowercase hex, one
 * per UTF-16 unit, so a pair for a character past U+FFFF — as PHP's `json_encode` writes by default
 * (`ö` → `\u00f6`).
 *
 * @param json - a JSON string's content, as `JSON.stringify` writes it.
 * @returns it, ASCII only.
 */
function asciiJson(json: string): string {
  return json.replace(
    /[\u0080-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * A secret as it may be written back: as it is; URL-encoded (`encodeURIComponent`: `%2F`) and
 * form-encoded (`URLSearchParams`: `+` for a space, `%21` for `!`), each also with `!'()*` escaped
 * (PHP's `rawurlencode` and `urlencode`), and each with uppercase and with lowercase escapes; and inside a JSON string — escaped as JavaScript does, with `\/` as PHP does,
 * and with every non-ASCII character `\uXXXX` as PHP's `json_encode` does, with and without `\/`.
 * A secret holding a lone surrogate has no URL or form form: a URL cannot carry it.
 *
 * @param secret - the secret.
 * @returns its forms, each once.
 */
export function secretForms(secret: string): string[] {
  const json = JSON.stringify(secret).slice(1, -1);
  const ascii = asciiJson(json);
  const encoded: string[] = [];
  if (secret.isWellFormed()) {
    const url = encodeURIComponent(secret);
    const form = new URLSearchParams({ s: secret }).toString().slice(2);
    for (const written of [url, escapeMarks(url), form, escapeMarks(form)])
      encoded.push(written, lowercaseEscapes(written));
  }
  return [
    ...new Set([
      secret,
      ...encoded,
      json,
      json.replaceAll("/", "\\/"),
      ascii,
      ascii.replaceAll("/", "\\/"),
    ]),
  ];
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
