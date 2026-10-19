import { test, expect } from "@playwright/test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  endSavedSessions,
  endSession,
  readSavedSessions,
  sessionsInState,
} from "./session";
import type { LocalTransport } from "../config/types";

/**
 * Reading a saved login's session, and ending it through a stub `wp` on PATH: the real exec layer, no
 * WordPress. The stub records its arguments, so the snippet's inputs are checked as PHP receives them.
 */
const STUB_WP = `#!/usr/bin/env bash
printf '%s' "$1" > "$WP_STUB_CAPTURE.flag"
printf '%s' "$3" > "$WP_STUB_CAPTURE"
case "$WP_STUB_MODE" in
  ended)   printf '{"live":true,"gone":true}' ;;
  gone)    printf '{"live":false,"gone":true}' ;;
  stuck)   printf '{"live":true,"gone":false}' ;;
  notice)  printf 'PHP Deprecated: something in a plugin\\n{"live":true,"gone":true}' ;;
  garbage) printf 'Warning: not JSON' ;;
  failing) printf 'Error: Error establishing a database connection.' >&2; exit 1 ;;
esac
exit 0
`;

const TOKEN = "Zk3pQ0aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2y";

/** The site the saved logins below belong to. */
const HOST = "site.example.test";

/** A SHA-256 HMAC's shape: 64 hex characters. */
const HMAC = "0f".repeat(32);

/** An auth cookie's value as WordPress sets it, its `|` URL-encoded. */
function authCookie(login: string, token: string, hmac = HMAC): string {
  return encodeURIComponent(`${login}|1790000000|${token}|${hmac}`);
}

/** A cookie of {@link HOST}, as Playwright saves a host-only cookie. */
function cookie(name: string, value: string, domain = HOST): unknown {
  return { name, value, domain, path: "/" };
}

/** A `storageState` holding the cookies WordPress sets at login. */
function state(token = TOKEN): unknown {
  return {
    cookies: [
      cookie(
        "wordpress_sec_0123456789abcdef0123456789abcdef",
        authCookie("admin", token),
      ),
      cookie(
        "wordpress_logged_in_0123456789abcdef0123456789abcdef",
        authCookie("admin", token),
      ),
      cookie("wordpress_test_cookie", "WP%20Cookie%20check"),
      cookie("wp-settings-time-1", "1790000000"),
    ],
    origins: [],
  };
}

let binDir: string;
let rootDir: string;
let capture: string;
let originalPath: string | undefined;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "auth-session-bin-"));
  rootDir = mkdtempSync(join(tmpdir(), "auth-session-root-"));
  capture = join(binDir, "captured-php.txt");
  const wp = join(binDir, "wp");
  writeFileSync(wp, STUB_WP);
  chmodSync(wp, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  process.env.WP_STUB_CAPTURE = capture;
});

test.afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.WP_STUB_CAPTURE;
  rmSync(binDir, { recursive: true, force: true });
  rmSync(rootDir, { recursive: true, force: true });
});

const local = (): LocalTransport => ({ mode: "local", rootDir });

/** The value the captured snippet embeds, decoded back from its base64 literal. */
function embedded(): unknown {
  const match = /base64_decode\( '([^']*)' \)/.exec(
    readFileSync(capture, "utf8"),
  );
  return JSON.parse(Buffer.from(match?.[1] ?? "", "base64").toString("utf8"));
}

test.describe("sessionsInState", () => {
  test("reads the auth cookies' login and token, ignoring every other cookie", () => {
    expect(sessionsInState(state(), HOST)).toEqual([
      { login: "admin", token: TOKEN },
    ]);
  });

  test("reads a value whose separators are not encoded", () => {
    expect(
      sessionsInState(
        {
          cookies: [
            cookie(
              "wordpress_logged_in_x",
              `editor@example.test|1790000000|${TOKEN}|${HMAC}`,
            ),
          ],
        },
        HOST,
      ),
    ).toEqual([{ login: "editor@example.test", token: TOKEN }]);
  });

  test("reads a login with a space, encoded as PHP does or form-style", () => {
    for (const encoded of ["jane%20doe", "jane+doe"]) {
      expect(
        sessionsInState(
          {
            cookies: [
              cookie(
                "wordpress_logged_in_x",
                `${encoded}%7C1790000000%7C${TOKEN}%7C${HMAC}`,
              ),
            ],
          },
          HOST,
        ),
      ).toEqual([{ login: "jane doe", token: TOKEN }]);
    }
  });

  test("recognises a renamed auth cookie by its value, and a SHA-1 HMAC", () => {
    // A site may rename its cookies (`LOGGED_IN_COOKIE`); without PHP's `hash`, the HMAC is SHA-1.
    expect(
      sessionsInState(
        {
          cookies: [
            cookie("my_site_auth", authCookie("admin", TOKEN, "ab".repeat(20))),
          ],
        },
        HOST,
      ),
    ).toEqual([{ login: "admin", token: TOKEN }]);
  });

  test("collapses two cookies of one session, and keeps two sessions apart", () => {
    const two = {
      cookies: [
        cookie("wordpress_logged_in_a", authCookie("admin", "t1")),
        cookie("wordpress_sec_a", authCookie("admin", "t1")),
        cookie("wordpress_logged_in_c", authCookie("admin", "t2")),
      ],
    };
    expect(sessionsInState(two, HOST).map((s) => s.token)).toEqual([
      "t1",
      "t2",
    ]);
  });

  test("takes a cookie of the site's parent domain, never one of another host", () => {
    const of = (domain: string): unknown => ({
      cookies: [
        cookie("wordpress_logged_in_x", authCookie("admin", TOKEN), domain),
      ],
    });
    expect(sessionsInState(of(".example.test"), HOST)).toHaveLength(1);
    expect(sessionsInState(of("SITE.Example.Test"), HOST)).toHaveLength(1);
    for (const domain of [
      "other.example.test",
      "example.test.evil",
      "e.test",
      "",
      ".",
    ]) {
      expect(sessionsInState(of(domain), HOST), domain).toEqual([]);
    }
  });

  test("skips malformed values, as WordPress would reject them", () => {
    const malformed = [
      `admin|1790000000|tok`, // three fields
      `admin|1790000000|tok|${HMAC}|extra`, // five
      `|1790000000|tok|${HMAC}`, // no login
      `admin|soon|tok|${HMAC}`, // expiration not a number
      `admin|1790000000||${HMAC}`, // no token
      `admin|1790000000|to-ken|${HMAC}`, // not a token WordPress generates
      "admin|1790000000|tok|deadbeef", // not an HMAC
      "%E0%A4%A", // not decodable
    ];
    expect(
      sessionsInState(
        {
          cookies: malformed.map((value) =>
            cookie("wordpress_logged_in_x", encodeURIComponent(value)),
          ),
        },
        HOST,
      ),
    ).toEqual([]);
  });

  test("gives none for anything that is not a state", () => {
    for (const value of [undefined, null, "x", [], {}, { cookies: "x" }]) {
      expect(sessionsInState(value, HOST)).toEqual([]);
    }
    expect(
      sessionsInState(
        { cookies: [null, 1, { name: 1 }, { value: "x" }] },
        HOST,
      ),
    ).toEqual([]);
  });
});

test.describe("readSavedSessions", () => {
  test("reads the sessions of a saved login", async () => {
    const file = join(rootDir, "site-0.json");
    writeFileSync(file, JSON.stringify(state()));
    expect(await readSavedSessions(file, HOST)).toEqual([
      { login: "admin", token: TOKEN },
    ]);
  });

  test("gives none when no run saved a login yet", async () => {
    expect(await readSavedSessions(join(rootDir, "absent.json"), HOST)).toEqual(
      [],
    );
  });

  test("gives none for a file that is not JSON", async () => {
    const file = join(rootDir, "torn.json");
    writeFileSync(file, '{"cookies": [');
    expect(await readSavedSessions(file, HOST)).toEqual([]);
  });

  test("throws, naming the file, when it cannot be read", async () => {
    const dir = join(rootDir, "a-directory.json");
    mkdirSync(dir, { recursive: true });
    await expect(readSavedSessions(dir, HOST)).rejects.toThrow(
      /could not read the saved login .*a-directory\.json/,
    );
  });
});

test.describe("endSession", () => {
  const session = { login: "admin", token: TOKEN };

  test("hands WordPress the login and token as data, with plugins skipped", async () => {
    process.env.WP_STUB_MODE = "ended";
    await endSession(local(), session);
    expect(embedded()).toEqual(session);
    expect(readFileSync(`${capture}.flag`, "utf8")).toBe("--skip-plugins");
  });

  test("a login that would break out of a PHP string arrives intact", async () => {
    process.env.WP_STUB_MODE = "ended";
    const hostile = { login: "x' ); exit(1); //", token: "t$oken\\'" };
    await endSession(local(), hostile);
    expect(embedded()).toEqual(hostile);
  });

  test("true when the session was live and is gone", async () => {
    process.env.WP_STUB_MODE = "ended";
    expect(await endSession(local(), session)).toBe(true);
  });

  test("false when it was already gone", async () => {
    process.env.WP_STUB_MODE = "gone";
    expect(await endSession(local(), session)).toBe(false);
  });

  test("reads the outcome past a notice WP-CLI printed first", async () => {
    process.env.WP_STUB_MODE = "notice";
    expect(await endSession(local(), session)).toBe(true);
  });

  test("throws when the session is still live afterwards, never naming the token", async () => {
    process.env.WP_STUB_MODE = "stuck";
    const failure = await endSession(local(), session).catch(
      (error: unknown) => error,
    );
    expect(String(failure)).toMatch(/"admin" is still live/);
    expect(String(failure)).not.toContain(TOKEN);
  });

  test("throws on a reply that is not its outcome", async () => {
    process.env.WP_STUB_MODE = "garbage";
    await expect(endSession(local(), session)).rejects.toThrow(
      /came back as "Warning: not JSON"/,
    );
  });

  test("throws with WordPress's own words when WP-CLI fails", async () => {
    process.env.WP_STUB_MODE = "failing";
    await expect(endSession(local(), session)).rejects.toThrow(
      /ending the saved session failed \(exit 1\).*database connection/,
    );
  });
});

test.describe("endSavedSessions", () => {
  /** A site of {@link HOST} whose saved login is `file`. */
  const site = (
    file: string,
  ): { transport: LocalTransport; storageState: string; baseURL: string } => ({
    transport: local(),
    storageState: file,
    baseURL: `https://${HOST}/`,
  });

  test("ends the session a saved login holds, counting the live ones", async () => {
    const file = join(rootDir, "saved.json");
    writeFileSync(file, JSON.stringify(state()));
    process.env.WP_STUB_MODE = "ended";
    expect(await endSavedSessions(site(file))).toBe(1);
    expect(embedded()).toEqual({ login: "admin", token: TOKEN });
    process.env.WP_STUB_MODE = "gone";
    expect(await endSavedSessions(site(file))).toBe(0);
  });

  test("does nothing when there is no saved login", async () => {
    process.env.WP_STUB_MODE = "failing";
    expect(await endSavedSessions(site(join(rootDir, "none.json")))).toBe(0);
  });

  test("leaves alone a login saved for another site", async () => {
    // The pool's order changed: this file holds another host's session, meaningless to this site.
    const file = join(rootDir, "moved.json");
    writeFileSync(file, JSON.stringify(state()));
    process.env.WP_STUB_MODE = "failing";
    expect(
      await endSavedSessions({
        ...site(file),
        baseURL: "https://elsewhere.test",
      }),
    ).toBe(0);
  });
});
