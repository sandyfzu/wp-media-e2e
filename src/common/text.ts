import { stripVTControlCharacters } from "node:util";

/** Small, pure string helpers shared across the suite: escaping, masking credentials, plain text. */

/**
 * `value` with every regular-expression metacharacter escaped, for safe interpolation into a
 * `RegExp` source — the same character set Playwright escapes in its own `--project` filter.
 *
 * @example
 * ```ts
 * new RegExp(`^${escapeRegExp("a.b")}$`).test("axb"); // false
 * ```
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Each character HTML gives a meaning to, and its entity. */
const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * `value` as HTML text, safe in an element's content and in a quoted attribute alike: every character
 * that could open a tag, an entity or end an attribute becomes its entity.
 *
 * @param value - the text.
 * @example
 * ```ts
 * escapeHtml(`<b title="x">&</b>`); // "&lt;b title=&quot;x&quot;&gt;&amp;&lt;/b&gt;"
 * ```
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char] ?? char);
}

/** What a masked credential is replaced with. */
const MASK = "***";

/** A GitHub token in every issued form: `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` and `github_pat_`. */
const GITHUB_TOKEN = /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{10,}/g;

/**
 * Credentials in a URL — `scheme://user:password@`, `scheme://token@` — up to the authority's **last**
 * `@`, as a URL parser reads it: a password holding a bare `@` is masked whole. The scheme is kept.
 * A scheme starts only where a run of scheme characters does (the lookbehind): tried from inside a
 * run too, as `\b` allows after each `.`, a long dotted text costs quadratic time.
 */
const URL_USERINFO = /(?<![a-z\d+.-])([a-z][a-z\d+.-]*:\/\/)[^\s/?#"'<>`]+@/gi;

/** A credential passed as a URL parameter (`?access_token=…`), which git quotes verbatim. */
const URL_CREDENTIAL_PARAM =
  /([?&#;](?:access_token|token|password|passwd|pwd|secret|client_secret|api_?key)=)[^\s&#;"'<>`]+/gi;

/** An HTTP authorization header's credential: `Authorization: Basic …`, `Bearer …`, `token …`. */
const AUTHORIZATION =
  /(\bAuthorization:\s*(?:Basic|Bearer|token)\s+)[A-Za-z0-9._~+/=-]+/gi;

/** A WordPress login cookie's value (`wordpress_logged_in_<hash>=…`, `wordpress_sec_<hash>=…`). */
const WORDPRESS_AUTH_COOKIE =
  /(\bwordpress_(?:logged_in|sec)_[0-9a-f]+=)[^\s;,"'<>`]+/gi;

/**
 * `text` with every credential it may quote masked, by its shape: a GitHub token, a URL's user and
 * password, a credential URL parameter (`pwd` — WordPress's login form — included), an HTTP
 * `Authorization` header, a WordPress login cookie. A credential with no recognisable shape — a
 * legacy 40-hex token, a password quoted bare — is masked only by its value ({@link maskValues}). The
 * last line of defence before an error reaches a log or a report — a
 * page's URL with basic-auth credentials is quoted by Playwright's navigation errors, a URL parameter
 * by git's — never a substitute for not passing secrets around. Idempotent, so text masked twice on
 * its way through nested handlers is unchanged.
 *
 * Mask before cutting a text short: a cut can split a credential from the `@` or prefix that marks it.
 *
 * @param text - what a tool, a site or a test said.
 * @example
 * ```ts
 * redactSecrets("fatal: unable to access 'https://x-access-token:ghp_abc…@github.com/o/r.git/'");
 * // "fatal: unable to access 'https://***@github.com/o/r.git/'"
 * ```
 */
export function redactSecrets(text: string): string {
  // Only `replace`, which resets a global pattern's `lastIndex`: `test`/`exec` on these shared
  // patterns would make the next call skip the start of its text.
  return text
    .replace(GITHUB_TOKEN, MASK)
    .replace(AUTHORIZATION, `$1${MASK}`)
    .replace(WORDPRESS_AUTH_COOKIE, `$1${MASK}`)
    .replace(URL_USERINFO, `$1${MASK}@`)
    .replace(URL_CREDENTIAL_PARAM, `$1${MASK}`);
}

/** The shortest value {@link maskValues} masks: a shorter one would mask ordinary words. */
const MIN_MASKED_LENGTH = 8;

/**
 * `text` with each of `values` masked wherever it appears verbatim — for a credential no pattern can
 * tell from ordinary text, such as a legacy GitHub token, 40 hex digits like any commit. Blank and
 * short values (under {@link MIN_MASKED_LENGTH} characters) are ignored.
 *
 * @param text - what a tool said.
 * @param values - the secrets the process holds.
 * @example
 * ```ts
 * maskValues("auth failed for 0123…cdef", [process.env.GITHUB_TOKEN]); // "auth failed for ***"
 * ```
 */
export function maskValues(
  text: string,
  values: readonly (string | undefined)[],
): string {
  let masked = text;
  for (const value of values) {
    const secret = value?.trim() ?? "";
    if (secret.length >= MIN_MASKED_LENGTH) {
      masked = masked.split(secret).join(MASK);
    }
  }
  return masked;
}

/**
 * Every control character: C0 (newlines and tabs included), DEL, C1, and the line and paragraph
 * separators U+2028/U+2029 — each one breaks or moves a line.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/**
 * Invisible format characters (Unicode `Cf`): the bidirectional overrides that make text display in
 * another order than it is stored (U+202E), zero-width spaces and joiners.
 */
const FORMAT = /\p{Cf}/gu;

/**
 * A value as one line of plain text: escape sequences removed, every other control character a
 * space, invisible format characters dropped. What sites, setups and the environment report — Site
 * Health's text, an error, a run's name — is printed and shown in the reports, and none of it may move
 * the cursor, recolour the terminal, break a line or display as something it is not.
 *
 * @param text - the value.
 * @example
 * ```ts
 * plain("\u001b[31mred\u001b[0m\nnext"); // "red next"
 * ```
 */
export function plain(text: string): string {
  return stripVTControlCharacters(text)
    .replace(CONTROL, " ")
    .replace(FORMAT, "")
    .trim();
}
