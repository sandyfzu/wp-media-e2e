// @ts-check

import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier/flat";

import suiteImports from "./orchestrator/suite-imports.json" with { type: "json" };

/**
 * The `src/` modules the orchestrator may import, as the alternatives of a regular expression:
 * relative to `src/`, without `.ts`, regex characters escaped.
 */
/**
 * The builtins orchestrator code may not load, each a way to load or run code no import guard sees:
 * `require` (`module`), a thread sharing the process (`worker_threads`), a context (`vm`), and code
 * evaluated in the process itself (`inspector`, `repl`). The orchestrator spawns processes and needs
 * none of them. `orchestrator/__fixtures__/import-boundary.ts` refuses the same list.
 */
const refusedBuiltins = [
  "module",
  "worker_threads",
  "vm",
  "inspector",
  "inspector/promises",
  "repl",
].flatMap((name) => [name, `node:${name}`]);

const admittedSuiteModules = suiteImports
  .map((path) =>
    path
      .replace(/^src\//, "")
      .replace(/\.ts$/, "")
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  )
  .join("|");

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

  // The shared layer never imports product code: a product hands `common/` its policy through
  // `ProductConfig` and the per-process registries the config factory fills. This is why the
  // product list lives in `src/projects/products.ts`, for the entry points to import. The rule sees
  // static imports only; `src/common/import-boundary.spec.ts` also catches a dynamic `import()` and
  // a `typeof import()` type.
  {
    files: ["src/common/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|/)projects(/|$)",
              message:
                "src/common/ must not import product code. Declare what the shared code needs on ProductConfig and pass it through the config factory's registries instead.",
            },
          ],
        },
      ],
    },
  },

  // The orchestrator is a long-lived process that must keep the process-wide state it started with,
  // and `run-context.ts` — with every module importing it — loads `.env` and stamps `RUN_ID` into the
  // importing process. So its code imports from `src/` only the modules
  // `orchestrator/suite-imports.json` lists (an allowlist: each new one is a decision), never test
  // code, never a module whose path it computes, nor the builtins and calls that load or run code
  // unchecked. Test code never runs in that process and is exempt. These rules read only a static
  // import's spelling, and are stricter than the spec where spelling misleads them (a `../` detour
  // back into an admitted module); they miss `typeof import()`, a literal `import()` and anything
  // outside `src/`. `orchestrator/import-boundary.spec.ts` resolves every form and imports the code
  // itself.
  {
    files: ["orchestrator/**/*.{ts,mts,cts,js,mjs,cjs}"],
    ignores: ["orchestrator/**/*.spec.*", "orchestrator/**/__fixtures__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: refusedBuiltins.map((name) => ({
            name,
            message:
              "This builtin loads or runs code no import guard sees (require, a thread, a VM context, the inspector, a REPL), and the orchestrator needs none: import the module itself, or spawn a process.",
          })),
          patterns: [
            {
              // A path (relative, absolute or `file:`) into a `src/` folder, unless it names an
              // admitted module, with or without its `.js` or `.ts`. Never a package's own `src/`.
              regex: `^(\\.{1,2}/|/|file:)(.*/)?src(/(?!(${admittedSuiteModules})(\\.[jt]s)?$)|/?$)`,
              message:
                "The orchestrator imports from src/ only the modules orchestrator/suite-imports.json lists: run-context.ts, and every module importing it, loads .env and stamps RUN_ID into the importing process. Admit a module there once orchestrator/import-boundary.spec.ts proves it leaves the process as it was.",
            },
            {
              regex: "(^|/)__fixtures__(/|$)|\\.spec(\\.[cm]?[jt]sx?)?$",
              message:
                "Test code is exempt from the orchestrator's import boundary, so its own code must never import it.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression[source.type!='Literal']",
          message:
            "Write the path as a plain string: a computed import() path cannot be checked against orchestrator/suite-imports.json.",
        },
      ],
      // On any object, so `globalThis.process.getBuiltinModule` is caught too.
      "no-restricted-properties": [
        "error",
        {
          property: "getBuiltinModule",
          message:
            "process.getBuiltinModule loads any builtin by a name no import guard reads: import the module itself.",
        },
      ],
      // Code evaluated from a string is code no guard reads. `no-new-func` covers `.js` too, which
      // `@typescript-eslint/no-implied-eval` does not lint.
      "no-eval": "error",
      "no-new-func": "error",
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
