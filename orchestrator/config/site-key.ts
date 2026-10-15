/**
 * Which site a `baseURL` is, as one string: what the site locks are keyed by (`state/cell-lock.ts`) and
 * what the config's check compares, so two tasks on one site are refused before either runs.
 */

/**
 * A site's key: its `baseURL`'s host as a URL parser writes it (lowercase, IDN as punycode, an IPv4
 * address in any form as dotted decimal, IPv6 compressed), without a trailing dot; its port, unless it
 * is 80 or 443 whatever the scheme — so `http` and `https` of one host are one site —; and its path as
 * the parser resolves it (`.`/`..`, `\` as `/`), escapes of unreserved characters decoded (`%7E` is
 * `~`) and the others uppercase, without trailing slashes. No credentials, query or fragment. Still
 * two keys for one site: a host and its IP address, two names for one server, a path differing only in
 * case.
 *
 * @param baseURL - the site's `baseURL`.
 * @returns `qa.example.test`, `10.0.0.5:8100/wp`.
 * @throws {@link RangeError} for anything but an http(s) URL.
 *
 * @example
 * ```ts
 * siteKey("https://user:pw@Simple.QA.test/"); // "simple.qa.test"
 * ```
 */
export function siteKey(baseURL: string): string {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new RangeError("A site's baseURL must be an http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new RangeError("A site's baseURL must be an http(s) URL.");
  const port = DEFAULT_PORTS.has(url.port) ? "" : `:${url.port}`;
  const host = url.hostname.replace(/\.$/, "");
  const path = url.pathname
    .replace(/%([0-9a-fA-F]{2})/g, (escape, hex: string) => {
      const char = String.fromCharCode(parseInt(hex, 16));
      return UNRESERVED.test(char) ? char : escape.toUpperCase();
    })
    .replace(/\/+$/, "");
  return `${host}${port}${path}`;
}

/** Ports a site's key leaves out: none written, or either web default, whatever the scheme. */
const DEFAULT_PORTS = new Set(["", "80", "443"]);

/** RFC 3986's unreserved characters: an escape of one is the character itself. */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
