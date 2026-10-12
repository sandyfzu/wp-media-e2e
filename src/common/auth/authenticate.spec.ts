import { test, expect } from "@playwright/test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MOCK_LOGIN,
  MOCK_VERSIONS,
  startMockWordPress,
} from "../__fixtures__/mock-wordpress";
import type { MockWordPress } from "../__fixtures__/mock-wordpress";
import type { SiteConfig } from "../config/types";
import { authenticatePool, hideFailureSnapshot } from "./authenticate";
import { sessionsInState } from "./session";

/**
 * The auth setup's pool authentication against a mock WordPress (`__fixtures__/mock-wordpress.ts`),
 * with a stub `wp` on PATH standing in for the site's WP-CLI: it records the session each call is
 * asked to end and answers as WordPress does. What reaches the reports is proven separately, through
 * the real runner, in `secrets.run.spec.ts`.
 */

const PASSWORD = "correct horse battery";

/** The stub: records the PHP it is handed, then ends the session — or fails, in `failing` mode. */
const STUB_WP = `#!/usr/bin/env bash
printf '%s\\n' "$3" >> "$WP_STUB_LOG"
if [ "$WP_STUB_MODE" = failing ]; then printf 'Error: database down' >&2; exit 1; fi
if [ "$WP_STUB_MODE" = hanging ]; then sleep 3; fi
printf '{"live":true,"gone":true}'
`;

let work = "";
let stubLog = "";
let originalPath: string | undefined;
let tokens = 0;
let mock: MockWordPress;

test.beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "auth-pool-"));
  mkdirSync(join(work, "bin"));
  writeFileSync(join(work, "bin/wp"), STUB_WP);
  chmodSync(join(work, "bin/wp"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${join(work, "bin")}:${originalPath ?? ""}`;
  stubLog = join(work, "wp-calls.log");
  process.env.WP_STUB_LOG = stubLog;
  mock = await startMockWordPress({
    password: PASSWORD,
    nextToken: () => `issued${String((tokens += 1))}x${"a".repeat(30)}`,
  });
});

test.afterAll(async () => {
  await mock.close();
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.WP_STUB_LOG;
  delete process.env.WP_STUB_MODE;
  rmSync(work, { recursive: true, force: true });
});

test.beforeEach(() => {
  rmSync(stubLog, { force: true });
  rmSync(join(work, "auth"), { recursive: true, force: true });
  delete process.env.WP_STUB_MODE;
});

/** A site of the pool: the mock, a local transport whose `wp` is the stub, a login file of its own. */
function site(
  index: number,
  username = MOCK_LOGIN,
  baseURL = mock.baseURL,
): SiteConfig {
  return {
    baseURL,
    username,
    password: PASSWORD,
    transport: { mode: "local", rootDir: work },
    storageState: join(work, "auth", `site-${String(index)}.json`),
  };
}

/** A saved login holding `token`, as a previous run left it, for cookies of `domain`. */
function savePreviousLogin(
  path: string,
  token: string,
  domain = "127.0.0.1",
): void {
  mkdirSync(join(work, "auth"), { recursive: true });
  const value = encodeURIComponent(
    `${MOCK_LOGIN}|1790000000|${token}|${"f".repeat(64)}`,
  );
  writeFileSync(
    path,
    JSON.stringify({
      cookies: [{ name: "wordpress_logged_in_x", value, domain, path: "/" }],
      origins: [],
    }),
  );
}

/** The sessions the stub was asked to end, in order, decoded from each snippet's base64 literal. */
function sessionsEnded(): unknown[] {
  if (!existsSync(stubLog)) return [];
  return [
    ...readFileSync(stubLog, "utf8").matchAll(/base64_decode\( '([^']*)' \)/g),
  ].map((match): unknown =>
    JSON.parse(Buffer.from(match[1] ?? "", "base64").toString("utf8")),
  );
}

/** The token a saved login holds now. */
function savedToken(path: string): string | undefined {
  return sessionsInState(JSON.parse(readFileSync(path, "utf8")), "127.0.0.1")[0]
    ?.token;
}

/** A stand-in for the setup's `testInfo`: records what is attached. */
function recorder(): {
  attach: (name: string, options: { body?: string | Buffer }) => Promise<void>;
  attached: { name: string; body: unknown }[];
} {
  const attached: { name: string; body: unknown }[] = [];
  return {
    attached,
    attach: (name, options) => {
      attached.push({ name, body: JSON.parse(String(options.body)) });
      return Promise.resolve();
    },
  };
}

/** Runs `body` with `console.warn` captured, and returns what it printed. */
async function warningsOf(body: () => Promise<void>): Promise<string[]> {
  const printed: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  };
  try {
    await body();
  } finally {
    console.warn = original;
  }
  return printed;
}

test.describe("authenticatePool", () => {
  test("ends the previous run's session first, then saves a new one and leaves it live", async ({
    browser,
  }) => {
    const first = site(0);
    savePreviousLogin(first.storageState, "previousRunToken");
    const info = recorder();

    await authenticatePool(browser, [first], info);

    expect(sessionsEnded()).toEqual([
      { login: MOCK_LOGIN, token: "previousRunToken" },
    ]);
    const saved = savedToken(first.storageState);
    expect(saved).toMatch(/^issued\d+x/);
    expect(info.attached).toEqual([
      {
        name: "site-info.json",
        body: [{ baseURL: mock.baseURL, versions: MOCK_VERSIONS }],
      },
    ]);
  });

  test("a refused login ends the sessions saved before it, and still attaches what was read", async ({
    browser,
  }) => {
    const info = recorder();
    const failure = await authenticatePool(
      browser,
      [site(0), site(1, "nobody")],
      info,
    ).catch((error: unknown) => error);

    expect(String(failure)).toMatch(/WordPress rejected the credentials/);
    const firstToken = savedToken(site(0).storageState);
    expect(sessionsEnded()).toEqual([{ login: MOCK_LOGIN, token: firstToken }]);
    expect(info.attached[0]?.body).toEqual([
      { baseURL: mock.baseURL, versions: MOCK_VERSIONS },
    ]);
  });

  test("a previous session that cannot be ended is a warning, and the login goes on", async ({
    browser,
  }) => {
    const first = site(0);
    savePreviousLogin(first.storageState, "previousRunToken");
    process.env.WP_STUB_MODE = "failing";

    const warnings = await warningsOf(() =>
      authenticatePool(browser, [first], recorder()),
    );

    expect(warnings.join("\n")).toMatch(
      /could not end the session the previous run left \(it still expires on its own\): .*database down/,
    );
    expect(warnings.join("\n")).not.toContain("previousRunToken");
    expect(savedToken(first.storageState)).toMatch(/^issued\d+x/);
  });

  test("a WP-CLI call that does not answer is cut off by its budget, and the login goes on", async ({
    browser,
  }) => {
    const first = site(0);
    savePreviousLogin(first.storageState, "previousRunToken");
    process.env.WP_STUB_MODE = "hanging";
    const started = Date.now();

    const warnings = await warningsOf(() =>
      authenticatePool(browser, [first], recorder(), {
        sessionEndMs: 200,
        siteInfoMs: 5_000,
      }),
    );

    expect(warnings.join("\n")).toMatch(
      /could not end the session the previous run left .*had not finished after 0\.2 s/,
    );
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(savedToken(first.storageState)).toMatch(/^issued\d+x/);
  });

  test("a session saved for another host is left alone", async ({
    browser,
  }) => {
    const first = site(0);
    savePreviousLogin(
      first.storageState,
      "otherSiteToken",
      "other.example.test",
    );

    await authenticatePool(browser, [first], recorder());

    expect(sessionsEnded()).toEqual([]);
  });

  test("versions that cannot be read are recorded with the reason, and the pool still passes", async ({
    browser,
  }) => {
    const bare = await startMockWordPress({
      password: PASSWORD,
      nextToken: () => "bareSiteToken",
      siteHealth: false,
    });
    try {
      const info = recorder();
      await warningsOf(() =>
        authenticatePool(browser, [site(0, MOCK_LOGIN, bare.baseURL)], info),
      );
      expect(info.attached[0]?.body).toEqual([
        {
          baseURL: bare.baseURL,
          error: "[site-health] the Info tab answered HTTP 404",
        },
      ]);
    } finally {
      await bare.close();
    }
  });

  test("an attachment that fails does not fail the pool", async ({
    browser,
  }) => {
    await expect(
      authenticatePool(browser, [site(0)], {
        attach: () => Promise.reject(new Error("disk full")),
      }),
    ).resolves.toBeUndefined();
  });
});

test.describe("hideFailureSnapshot", () => {
  test("turns the snapshot off, and puts back an absent variable as absent", () => {
    const env: NodeJS.ProcessEnv = {};
    const restore = hideFailureSnapshot(env);
    expect(env.PLAYWRIGHT_NO_COPY_PROMPT).toBe("1");
    restore();
    expect("PLAYWRIGHT_NO_COPY_PROMPT" in env).toBe(false);
  });

  test("puts back a value that was already there", () => {
    const env: NodeJS.ProcessEnv = { PLAYWRIGHT_NO_COPY_PROMPT: "yes" };
    const restore = hideFailureSnapshot(env);
    expect(env.PLAYWRIGHT_NO_COPY_PROMPT).toBe("1");
    restore();
    expect(env.PLAYWRIGHT_NO_COPY_PROMPT).toBe("yes");
  });
});
