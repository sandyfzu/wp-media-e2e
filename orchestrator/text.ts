import { stripVTControlCharacters } from "node:util";

import {
  maskSiteUrl,
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
 * characters, spaces around it aside, is masked in no form: it would mask ordinary words. Each secret
 * is also masked as cleaning writes it ({@link oneLine}): one holding an invisible character (a
 * zero-width space pasted with it) reads without it once a line is clean — in the run facts, the
 * summary, or here after a terminal code split it. Last, the head of a secret a cut left before its
 * marker ({@link maskCutTails}).
 *
 * @param text - the text.
 * @param secrets - the secret values to mask wherever they appear, in any order.
 * @returns the masked text.
 */
function mask(text: string, secrets: readonly string[]): string {
  // Trimmed first, as a value is masked: a secret written with spaces around it is the same secret,
  // and its encoded forms must be the trimmed value's.
  const forms = secrets
    .flatMap((secret) => [secret.trim(), oneLine(secret)])
    .filter((secret) => secret.length >= MIN_MASKED_LENGTH)
    .flatMap(secretForms);
  const unique = [...new Set(forms)];
  return redactSecrets(maskCutTails(maskValues(text, unique), unique));
}

/**
 * The mark every cut in the suite and here ends with: the results stream's `… [truncated]`, the run
 * facts' and the summary's `…`, this module's {@link cut}.
 */
export const CUT_MARK = "…";

/**
 * The shortest head of a secret masked before a cut: shorter ones are ordinary text too often. Four is
 * kept on purpose though it over-masks — `admin…` becomes `***…` when a secret starts `admin` —: a
 * word lost from a cut message costs nothing, a secret's head shown costs its strength. Fail-safe.
 */
export const MIN_CUT_TAIL = 4;

/**
 * `text` with the head of a secret that a cut left just before its mark masked: a message cut in the
 * middle of a password (the suite cuts a stream's message, masked only by shape, at 2,000 characters)
 * holds a part of it no value matches. Before each {@link CUT_MARK}, the longest text that is the
 * start — {@link MIN_CUT_TAIL} characters or more, never all — of any of `forms` becomes `***`.
 *
 * @param text - the text, its whole secrets already masked.
 * @param forms - every secret's forms, as {@link mask} matches them.
 * @returns the text, those heads masked.
 */
export function maskCutTails(text: string, forms: readonly string[]): string {
  let masked = "";
  let from = 0;
  for (let at = text.indexOf(CUT_MARK); at !== -1;) {
    const head = longestSecretHead(text, at, forms);
    masked += `${text.slice(from, at - head)}${head > 0 ? "***" : ""}`;
    from = at;
    at = text.indexOf(CUT_MARK, at + CUT_MARK.length);
  }
  return masked + text.slice(from);
}

/**
 * How long the start of a secret's form is that ends at `end` in `text`.
 *
 * @param text - the text.
 * @param end - where a cut mark starts.
 * @param forms - the secrets' forms.
 * @returns its length: from {@link MIN_CUT_TAIL}, shorter than the form; `0` for none.
 */
function longestSecretHead(
  text: string,
  end: number,
  forms: readonly string[],
): number {
  let longest = 0;
  for (const form of forms)
    for (
      let length = Math.min(form.length - 1, end);
      length >= Math.max(longest + 1, MIN_CUT_TAIL);
      length--
    )
      if (text.startsWith(form.slice(0, length), end - length)) {
        longest = length;
        break;
      }
  return longest;
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
 * A site's address as one safe line: masked by value as written ({@link safeLine}) — before a URL
 * parser could encode or case-fold a secret in it — then shown as the suite shows one
 * (`maskSiteUrl`: user and password `***@`, no query or fragment, anything but an `http(s)` URL a
 * stand-in), then masked again.
 *
 * @param baseURL - the site's `baseURL`.
 * @param max - the most code points kept.
 * @param secrets - secret values to mask wherever they appear.
 * @returns the address to show.
 */
export function safeSiteUrl(
  baseURL: string,
  max: number,
  secrets: readonly string[] = [],
): string {
  // Masked whole before it is cut: a cut address would no longer parse.
  const masked = safeLine(baseURL, Number.MAX_SAFE_INTEGER, secrets);
  return safeLine(maskSiteUrl(masked), max, secrets);
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
 * What a value says, as raw text — for a thrown value above all: an `Error`'s message, else the value
 * itself, through `String` when it is not a string. Total: a message that is not text, an object with
 * no prototype, a getter or `toString` that throws — `""` when nothing printable comes of it. Neither
 * masked nor cleaned: show it through {@link safeLine}, or {@link failureLine}.
 *
 * @param value - what was thrown, or any value to show.
 * @returns its text; `""` when it has none.
 */
export function textOf(value: unknown): string {
  try {
    const message: unknown = value instanceof Error ? value.message : value;
    return typeof message === "string" ? message : String(message);
  } catch {
    return "";
  }
}

/**
 * A failure as one safe line: what it says ({@link textOf}) through {@link safeLine}, `failed` when
 * that leaves nothing. Total, whatever was thrown.
 *
 * @param error - what was thrown.
 * @param max - the most code points kept.
 * @param secrets - secret values to mask wherever they appear.
 * @returns the line, never blank.
 */
export function failureLine(
  error: unknown,
  max: number,
  secrets: readonly string[] = [],
): string {
  return safeLine(textOf(error), max, secrets) || "failed";
}

/**
 * The longest path a line quotes, in code points. The reader copies it into a command (`rm`, `lsof`,
 * the record to mark `lost`), so the bound is generous — a cut path is no use in a command — and only
 * keeps a pathological one from flooding the log.
 */
export const MAX_QUOTED_PATH = 1_000;

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
