import { readFile } from "node:fs/promises";

import { errorMessage, isObject } from "../guards";
import { evalPhp, phpLiteral } from "../wp/php";
import type { SiteConfig, Transport } from "../config/types";

/**
 * Ending the WordPress session a run's saved login holds.
 *
 * Every scenario's browser carries the session the auth setup saved, so a scenario's retained trace
 * records its cookies — and the HTML report copies that trace. A cookie left live is an admin session
 * for anyone holding the report. The auth setup therefore ends the session the cell's **previous**
 * run saved before it logs in again: of the sessions the suite saves, at most one per site is live —
 * the newest report's.
 *
 * Not at the end of the run itself: the fast `--no-deps` loop reuses the saved login after the run,
 * and an interrupted run skips its teardown anyway. Ending only that one token leaves every other
 * session of the user — a person or another agent logged in as them — untouched. Two runs of one
 * cell at once — never supported — would now log each other out.
 */

/** A session a saved login holds: whose it is, and its token. Never printed. */
export interface SavedSession {
  /** The WordPress login it belongs to. */
  readonly login: string;
  /** The session token, the third field of the auth cookie. */
  readonly token: string;
}

/**
 * An auth cookie's value once decoded — `login|expiration|token|hmac`, as `wp_generate_auth_cookie`
 * writes it: the token is `wp_generate_password( 43, false, false )`, the HMAC a SHA-256 hex digest
 * (SHA-1 where PHP lacks `hash`). Recognised by this shape rather than by name, since a site may
 * rename its cookies (`LOGGED_IN_COOKIE`); the `wordpress_sec_` cookies carry the same token.
 */
const AUTH_COOKIE_VALUE =
  /^([^|]+)\|\d+\|([A-Za-z0-9]+)\|(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The sessions a Playwright `storageState` holds for one site, one per distinct token — normally one.
 *
 * @param state - the parsed state file; anything else gives none.
 * @param hostname - the site's host: a cookie set for another host is not this site's session.
 * @returns every well-formed auth cookie's session; anything else is skipped, as WordPress would
 *   reject it.
 */
export function sessionsInState(
  state: unknown,
  hostname: string,
): SavedSession[] {
  if (!isObject(state) || !Array.isArray(state.cookies)) return [];
  const sessions = new Map<string, SavedSession>();
  for (const cookie of state.cookies) {
    if (
      !isObject(cookie) ||
      typeof cookie.value !== "string" ||
      typeof cookie.domain !== "string" ||
      !cookieDomainMatches(cookie.domain, hostname)
    ) {
      continue;
    }
    const session = parseAuthCookie(cookie.value);
    if (session !== undefined) sessions.set(session.token, session);
  }
  return [...sessions.values()];
}

/**
 * Whether a cookie's domain covers `hostname`: the host itself, or a parent domain the cookie was
 * set for (`.example.com`, from a site's `COOKIE_DOMAIN`).
 */
function cookieDomainMatches(domain: string, hostname: string): boolean {
  const bare = domain.replace(/^\./, "").toLowerCase();
  const host = hostname.toLowerCase();
  return bare !== "" && (host === bare || host.endsWith(`.${bare}`));
}

/**
 * Reads an auth cookie's login and token.
 *
 * PHP's `setcookie` encodes with `rawurlencode` (measured: a space is `%20`). A bare `+` is read as a
 * space too, as a form-style encoder would mean it: neither encoder leaves a literal `+` bare.
 *
 * @returns `undefined` for any other cookie.
 */
function parseAuthCookie(value: string): SavedSession | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value.replaceAll("+", "%20"));
  } catch {
    return undefined;
  }
  const match = AUTH_COOKIE_VALUE.exec(decoded);
  if (match === null) return undefined;
  return { login: match[1] ?? "", token: match[2] ?? "" };
}

/**
 * The sessions a `storageState` file holds for one site.
 *
 * @param path - the saved-login file.
 * @param hostname - the site's host (see {@link sessionsInState}).
 * @returns none when the file does not exist (no run saved a login yet) or is not a state file.
 * @throws {@link Error} when the file exists but cannot be read.
 */
export async function readSavedSessions(
  path: string,
  hostname: string,
): Promise<SavedSession[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return [];
    throw new Error(
      `[auth/session] could not read the saved login ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  try {
    return sessionsInState(JSON.parse(raw), hostname);
  } catch {
    return [];
  }
}

/**
 * Destroys one session on the site, through WordPress's own `WP_Session_Tokens`, and re-reads it.
 *
 * WordPress loads with `--skip-plugins` — the site may still hold a plugin a killed run left half-way —
 * which still loads must-use plugins. The session store is core's (user meta) unless a plugin swaps
 * it through `session_token_manager`; none does on the suite's cells (measured, with plugins loaded).
 *
 * @returns `true` when the session was live and is now gone; `false` when it was already gone
 *   (expired, logged out, or its user removed).
 * @throws {@link Error} when WP-CLI fails, or the session is still live afterwards — never naming the
 *   token.
 */
export async function endSession(
  transport: Transport,
  session: SavedSession,
): Promise<boolean> {
  const reply = await evalPhp(
    transport,
    `$session = ${phpLiteral(session)};
$user = get_user_by( 'login', $session['login'] );
if ( ! $user ) { echo '{"live":false,"gone":true}'; return; }
$tokens = WP_Session_Tokens::get_instance( $user->ID );
$live = null !== $tokens->get( $session['token'] );
$tokens->destroy( $session['token'] );
echo wp_json_encode( array( 'live' => $live, 'gone' => null === $tokens->get( $session['token'] ) ) );`,
    "ending the saved session",
    "auth/session",
    { skipPlugins: true },
  );
  const outcome = parseOutcome(reply);
  if (!outcome.gone) {
    throw new Error(
      `[auth/session] the saved session of "${session.login}" is still live after WordPress destroyed it.`,
    );
  }
  return outcome.live;
}

/** Reads the snippet's reply: its last line, since WP-CLI may print a PHP notice first. */
function parseOutcome(reply: string): { live: boolean; gone: boolean } {
  const last = reply.split("\n").at(-1) ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    parsed = undefined;
  }
  if (
    !isObject(parsed) ||
    typeof parsed.live !== "boolean" ||
    typeof parsed.gone !== "boolean"
  ) {
    throw new Error(
      `[auth/session] ending the saved session came back as ${JSON.stringify(last.slice(0, 200))}, ` +
        "not its outcome.",
    );
  }
  return { live: parsed.live, gone: parsed.gone };
}

/**
 * Ends every session a site's saved login holds for that site — the previous run's, before a new
 * login replaces the file. A session saved for another host (the pool's order changed) is left
 * alone: its token means nothing to this site.
 *
 * @param site - the site: its transport, its saved-login file and its URL.
 * @returns how many live sessions were ended.
 * @throws {@link Error} as {@link readSavedSessions} and {@link endSession} do.
 */
export async function endSavedSessions(
  site: Pick<SiteConfig, "transport" | "storageState" | "baseURL">,
): Promise<number> {
  const { hostname } = new URL(site.baseURL);
  let ended = 0;
  for (const session of await readSavedSessions(site.storageState, hostname)) {
    if (await endSession(site.transport, session)) ended += 1;
  }
  return ended;
}
