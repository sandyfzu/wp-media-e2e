/** Small, pure string helpers shared across the suite: escaping, and masking credentials. */

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
  /([?&#;](?:access_token|token|password|passwd|secret|client_secret|api_?key)=)[^\s&#;"'<>`]+/gi;

/**
 * `text` with every credential it may quote masked: a GitHub token, a URL's user and password, a
 * credential URL parameter. The last line of defence before an error reaches a log or a report — a
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
    .replace(URL_USERINFO, `$1${MASK}@`)
    .replace(URL_CREDENTIAL_PARAM, `$1${MASK}`);
}
