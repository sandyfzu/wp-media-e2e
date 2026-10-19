import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { SUITE_SCRIPTS, suiteCommands } from "./commands";

const CHECKOUT = "/srv/e2e";

test.describe("suiteCommands", () => {
  test("runs bddgen, then the runner's test command, both through Node with the product's config", () => {
    expect(
      suiteCommands({
        node: "/usr/bin/node",
        checkout: CHECKOUT,
        playwrightConfig: "playwright.backwpup.config.ts",
      }),
    ).toEqual({
      bddgen: {
        file: "/usr/bin/node",
        args: [
          join(CHECKOUT, "node_modules/playwright-bdd/dist/cli/index.js"),
          "--config",
          "playwright.backwpup.config.ts",
        ],
      },
      playwright: {
        file: "/usr/bin/node",
        args: [
          join(CHECKOUT, "node_modules/@playwright/test/cli.js"),
          "test",
          "--config",
          "playwright.backwpup.config.ts",
        ],
      },
    });
  });

  test("passes a filter as one argument, so a value starting with '-' cannot read as an option", () => {
    const { playwright, bddgen } = suiteCommands({
      node: "node",
      checkout: CHECKOUT,
      playwrightConfig: "playwright.backwpup.config.ts",
      grep: "--list",
    });
    expect(playwright.args.at(-1)).toBe("--grep=--list");
    expect(bddgen.args.some((arg) => arg.startsWith("--grep"))).toBe(false);
  });

  test("names entry scripts this checkout has: each tool's own bin", () => {
    const root = resolve(import.meta.dirname, "../..");
    for (const script of Object.values(SUITE_SCRIPTS))
      expect(existsSync(join(root, script))).toBe(true);
  });
});
