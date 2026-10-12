import { join } from "node:path";

import { test as setup, expect } from "@playwright/test";

import {
  authenticatePool,
  keepSecretsOutOfFailureSnapshots,
} from "../../auth/authenticate";
import { enterSecret } from "../../pages/secret-field";
import type { SiteConfig } from "../../config/types";
import { MOCK_LOGIN, startMockWordPress } from "../mock-wordpress";
import type { MockWordPress } from "../mock-wordpress";

/**
 * Stands in for the auth setup in `auth/secrets.run.spec.ts`: it runs as a cell's setup project —
 * that project's real trace setting, the suite's real reporters — registers the setup's own
 * failure-snapshot hooks and calls its own {@link authenticatePool}, against a mock WordPress. Every
 * test fails on purpose, so its trace is kept for the spec to search.
 *
 * The canaries come from the spec, through the environment.
 */

keepSecretsOutOfFailureSnapshots(setup);

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
const CONTROL = given("CANARY_CONTROL");
const WORK = given("CANARY_WORK");

let wordpress: MockWordPress;

setup.beforeAll(async () => {
  wordpress = await startMockWordPress({
    password: PASSWORD,
    nextToken: () => TOKEN,
  });
});

setup.afterAll(async () => {
  await wordpress.close();
});

/** One site of the pool: the mock, a local transport whose `wp` is the spec's stub. */
function site(index: number, username: string): SiteConfig {
  return {
    baseURL: wordpress.baseURL,
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
  );
});

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
