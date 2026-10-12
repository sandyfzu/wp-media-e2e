import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * For specs: the few wp-admin pages the auth setup touches, served by a local HTTP server, so its
 * login runs end to end with no WordPress. `admin` with the given password logs in and gets the
 * auth cookies WordPress sets — values of WordPress's own shape, holding the next token; anyone else
 * is refused as wp-login.php refuses them.
 */

/** The only login the mock accepts. */
export const MOCK_LOGIN = "admin";

/** The versions the mock's Site Health reports. */
export const MOCK_VERSIONS = {
  wordpress: "7.1.3",
  php: "8.5.11 64bit",
} as const;

/** What a mock is started with. */
export interface MockWordPressOptions {
  /** The password `admin` logs in with. */
  readonly password: string;
  /** The session token each successful login is given. */
  readonly nextToken: () => string;
  /** Whether Site Health's Info tab exists; without it, the page is a 404. */
  readonly siteHealth?: boolean;
}

/** A running mock. */
export interface MockWordPress {
  /** Its URL, `http://127.0.0.1:<port>`. */
  readonly baseURL: string;
  /** Stops it. */
  readonly close: () => Promise<void>;
}

/** wp-login.php's form, with WordPress's labels; `error` re-renders it as a refused login. */
function loginForm(error = ""): string {
  return `<!doctype html><html><body>${error}<form method="post" action="/wp-login.php">
    <label for="user_login">Username or Email Address</label><input id="user_login" name="log" />
    <label for="user_pass">Password</label><input id="user_pass" name="pwd" type="password" />
    <button type="submit">Log In</button></form></body></html>`;
}

/** Site Health's Info tab: the copy button, holding a short site info. */
const SITE_HEALTH = `<!doctype html><html><body><button type="button" class="button copy-button"
  data-clipboard-text="\`&#10;### wp-core ###&#10;&#10;version: ${MOCK_VERSIONS.wordpress}&#10;&#10;### wp-server ###&#10;&#10;php_version: ${MOCK_VERSIONS.php}&#10;\`">Copy site info to clipboard</button></body></html>`;

/** The auth cookies WordPress sets at login, for `token`: `login|expiration|token|hmac`. */
function authCookies(token: string): string[] {
  const hmac = createHash("sha256").update(token).digest("hex");
  const value = encodeURIComponent(`${MOCK_LOGIN}|1790000000|${token}|${hmac}`);
  const hash = "0123456789abcdef0123456789abcdef";
  return [
    `wordpress_sec_${hash}=${value}; path=/wp-admin; HttpOnly`,
    `wordpress_logged_in_${hash}=${value}; path=/; HttpOnly`,
  ];
}

/** Answers one request. */
async function answer(
  req: IncomingMessage,
  res: ServerResponse,
  options: MockWordPressOptions,
): Promise<void> {
  const html = (body: string, status = 200): void => {
    res.writeHead(status, { "content-type": "text/html" });
    res.end(body);
  };
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (pathname === "/wp-login.php" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const form = new URLSearchParams(body);
    if (
      form.get("log") !== MOCK_LOGIN ||
      form.get("pwd") !== options.password
    ) {
      html(loginForm('<div id="login_error">Unknown username.</div>'));
      return;
    }
    res.writeHead(302, {
      location: "/wp-admin/",
      "set-cookie": authCookies(options.nextToken()),
    });
    res.end();
  } else if (pathname === "/wp-login.php") {
    html(loginForm());
  } else if (pathname === "/wp-admin/site-health.php") {
    if (options.siteHealth === false) html("Not found", 404);
    else html(SITE_HEALTH);
  } else if (pathname.startsWith("/wp-admin")) {
    html("<!doctype html><html><body><h1>Dashboard</h1></body></html>");
  } else {
    html("Not found", 404);
  }
}

/**
 * Starts a mock on a free port of the loopback interface.
 *
 * @returns the running mock; `close` it when done.
 */
export async function startMockWordPress(
  options: MockWordPressOptions,
): Promise<MockWordPress> {
  const server = createServer((req, res) => {
    answer(req, res, options).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        // A browser keeps its connections alive, which would hold `close` open until they time out.
        server.closeAllConnections();
      }),
  };
}
