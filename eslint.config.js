// @ts-check

import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier/flat";

export default defineConfig([
  globalIgnores([
    ".features-gen/",
    "playwright-report/",
    "test-results/",
    "blob-report/",
    "reports/",
    "allure-results/",
    "allure-report/",
    "dist/",
    "build/",
    "coverage/",
    "node_modules/",
    // Claude Code worktrees (`claude -w`): checkouts of other branches, linted from inside them.
    ".claude/worktrees/",
  ]),

  // Treat unused eslint-disable directives as errors.
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },

  // TypeScript sources: full, type-aware strict linting.
  {
    files: ["**/*.{ts,mts,cts}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allow intentionally unused identifiers when prefixed with `_`.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },

  // Test-authoring surfaces: ban the flaky-by-construction waits.
  //
  // Every pattern below is a *timing* workaround that Playwright's web-first assertions make
  // unnecessary, and each one that survives makes a suite slower and less trustworthy: a fixed
  // sleep is either wasted time or too short, "networkidle" is discouraged by Playwright itself
  // and never fires on a page with long-polling or analytics, `waitForSelector` predates
  // auto-retrying `expect()`, and `.type()` is deprecated in favour of `fill()`.
  //
  // Scoped to the code that drives a browser — page objects, steps, scenario hooks, the UI login
  // and everything product-specific — so the rule reads as "authoring policy" rather than a
  // blanket ban. The one deliberate exception is left outside that scope: the visual helpers make
  // a single timeboxed, already-caught `networkidle` attempt to settle lazy-loaded media before a
  // screenshot, where "no more requests" is the actual condition and not reaching it is fine.
  //
  // Each selector matches the member expression in the CALL'S `.callee` field, never any member
  // expression under a call. Without that field, `describe(job.type)` — passing a property that
  // merely shares the name — is flagged as if it were `page.type(...)`, and a gate that fires on
  // innocent code is one people start disabling.
  {
    files: [
      "src/projects/**/*.ts",
      "src/common/pages/**/*.ts",
      "src/common/steps/**/*.ts",
      "src/common/hooks/**/*.ts",
      "src/common/auth/**/*.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression > MemberExpression.callee[property.name='waitForTimeout']",
          message:
            "Fixed sleeps are flaky. Assert the condition instead (`await expect(locator).toBeVisible()`), or await the request that completes the action (`page.waitForResponse(...)`).",
        },
        {
          selector:
            "CallExpression[callee.property.name='waitForLoadState'] > Literal[value='networkidle']",
          message:
            'Playwright discourages "networkidle": it never settles on pages with polling or analytics. Await the specific response that completes the action, or assert the resulting UI state.',
        },
        {
          selector:
            "CallExpression > MemberExpression.callee[property.name='waitForSelector']",
          message:
            "waitForSelector predates auto-retrying assertions. Use `await expect(locator).toBeVisible()` / `.toBeHidden()`, which retries and reports what it saw.",
        },
        {
          selector:
            "CallExpression > MemberExpression.callee[property.name='type']",
          message:
            "`type()` is deprecated. Use `locator.fill(value)`, or `locator.pressSequentially(value)` when a field genuinely needs per-key events.",
        },
      ],
    },
  },

  // Plain JavaScript (this config, Prettier config): no type-aware rules.
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // Must remain last: disables ESLint rules that conflict with Prettier.
  eslintConfigPrettier,
]);
