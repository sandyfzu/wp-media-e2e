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
    "dist/",
    "build/",
    "coverage/",
    "node_modules/",
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
