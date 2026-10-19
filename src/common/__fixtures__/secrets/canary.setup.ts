import { createServer } from "node:net";
import type { Server } from "node:net";
import { join } from "node:path";

import { test as setup, expect } from "@playwright/test";

import {
  authenticatePool,
  endSessionsWhenSetupFails,
  keepSecretsOutOfFailureSnapshots,
} from "../../auth/authenticate";
import { enterSecret } from "../../pages/secret-field";
import type { SiteConfig } from "../../config/types";
import { MOCK_LOGIN, startMockWordPress } from "../mock-wordpress";
import type { MockWordPress } from "../mock-wordpress";

/**
 * Stands in for the auth setup in `auth/secrets.run.spec.ts`: it runs as a cell's setup project —
 * that project's real trace setting, the suite's real reporters — registers the setup's own
 * failure-snapshot and session-ending hooks and calls its own {@link authenticatePool}, against a mock
 * WordPress. Every test fails on purpose, so its trace is kept for the spec to search.
 *
 * The canaries come from the spec, through the environment.
 */

keepSecretsOutOfFailureSnapshots(setup);
const saved = endSessionsWhenSetupFails(setup);

/** A required value from the spec. */
function given(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`the canary setup needs ${name}`);
  }
  return value;
}

const PASSWORD = given("CANARY_PASSWORD");
const TOKEN = given("CANARY_TOKEN");
const TIMEOUT_TOKEN = given("CANARY_TIMEOUT_TOKEN");
const CONTROL = given("CANARY_CONTROL");
const WORK = given("CANARY_WORK");

let wordpress: MockWordPress;
/** A second WordPress, for the pool that times out: its session token is its own. */
let timingOut: MockWordPress;
/** A server that accepts a connection and never answers: a site that hangs. */
let silent: Server;

setup.beforeAll(async () => {
  wordpress = await startMockWordPress({
    password: PASSWORD,
    nextToken: () => TOKEN,
  });
  timingOut = await startMockWordPress({
    password: PASSWORD,
    nextToken: () => TIMEOUT_TOKEN,
  });
  silent = createServer(() => undefined);
  await new Promise<void>((resolve) => {
    silent.listen(0, "127.0.0.1", resolve);
  });
});

setup.afterAll(async () => {
  await wordpress.close();
  await timingOut.close();
  silent.close();
});

/** The silent server's URL. */
function silentURL(): string {
  const address = silent.address();
  if (address === null || typeof address === "string") {
    throw new Error("the silent server has no port");
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

/** One site of the pool: a mock (the first by default), a local transport whose `wp` is the spec's stub. */
function site(
  index: number,
  username: string,
  baseURL: string = wordpress.baseURL,
): SiteConfig {
  return {
    baseURL,
    username,
    password: PASSWORD,
    transport: { mode: "local", rootDir: WORK },
    storageState: join(WORK, "auth", `site-${String(index)}.json`),
  };
}

setup("a pool whose second login is refused", async ({ browser }, testInfo) => {
  // The first site logs in and is saved; the second is refused, failing the setup as a real one fails.
  await authenticatePool(
    browser,
    [site(0, MOCK_LOGIN), site(1, "nobody")],
    testInfo,
    undefined,
    saved,
  );
});

setup(
  "a pool whose second site never answers, timing out",
  async ({ browser }, testInfo) => {
    // The first site logs in and is saved; the second hangs until the setup runs out of time, which
    // abandons this body: only the setup's afterEach can end the first session.
    setup.setTimeout(5_000);
    await authenticatePool(
      browser,
      [
        site(2, MOCK_LOGIN, timingOut.baseURL),
        site(3, MOCK_LOGIN, silentURL()),
      ],
      testInfo,
      undefined,
      saved,
    );
  },
);

setup(
  "a setup timing out with the password in the page",
  async ({ browser }) => {
    // What a setup that runs out of time mid-login leaves: its context open, the password in the field.
    setup.setTimeout(3_000);
    const context = await browser.newContext({ baseURL: wordpress.baseURL });
    const page = await context.newPage();
    await page.goto("/wp-login.php");
    await enterSecret(page.getByLabel("Password", { exact: true }), PASSWORD);
    await new Promise<never>(() => undefined);
  },
);

setup("control: fill()", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: wordpress.baseURL });
  const page = await context.newPage();
  await page.goto("/wp-login.php");
  await page.getByLabel("Password", { exact: true }).fill(CONTROL);
  await expect(page.getByRole("button", { name: "Log In" })).toBeVisible();
  throw new Error("forced failure after fill()");
});
