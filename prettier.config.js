// @ts-check

/**
 * Prettier configuration.
 *
 * Values mirror Prettier's own defaults but are listed explicitly so the
 * intended formatting is self-documenting and stays in sync with tooling.
 *
 * @see https://prettier.io/docs/options
 * @type {import("prettier").Config}
 */
const config = {
  printWidth: 80,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  quoteProps: "as-needed",
  trailingComma: "all",
  bracketSpacing: true,
  arrowParens: "always",
  endOfLine: "lf",
};

export default config;
