import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  importsIn,
  isCodeFile,
  isInside,
  isTestCode,
  pathOf,
} from "./__fixtures__/import-scan";

/**
 * `src/common/` never imports product code: a product hands the shared code its policy through
 * `ProductConfig` and the config factory's registries. ESLint's `no-restricted-imports` flags a
 * static import as it is typed, but not a dynamic `import()` or a `typeof import()` type. This
 * covers every form, read from TypeScript's syntax tree — and refuses, outside test code, an
 * `import()` whose path is computed, which no scan can judge.
 */

/** `src/common/`, where this file sits. */
const COMMON_DIR = fileURLToPath(new URL(".", import.meta.url));

/** `src/projects/`, which nothing under {@link COMMON_DIR} may import. */
const PROJECTS_DIR = fileURLToPath(new URL("../projects", import.meta.url));

/**
 * What in `source`, read as the file `file`, may load product code: each specifier that names a
 * path into `src/projects/` (a package or `node:` specifier never does), and — unless `file` is test
 * code — each computed one, as `(computed) line <n>`.
 */
function productImports(file: string, source: string): string[] {
  return importsIn(file, source).flatMap(({ specifier, line }) => {
    if (specifier === undefined) {
      return isTestCode(file) ? [] : [`(computed) line ${String(line)}`];
    }
    const path = pathOf(file, specifier);
    return path !== undefined && isInside(PROJECTS_DIR, path)
      ? [specifier]
      : [];
  });
}

test.describe("src/common/ never imports src/projects/", () => {
  test("the scan sees every import form, and nothing in comments, strings or look-alike paths", () => {
    const file = join(COMMON_DIR, "hooks", "example.ts");
    const source = [
      'import { a } from "../../projects/static";',
      'import type { T } from "../../projects/type-only";',
      'import "../../projects/side-effect";',
      'export { b } from "../../projects/re-export";',
      'export * from "../../projects";',
      'const c = await import("../../projects/dynamic");',
      "const d = await import(`../../projects/template`);",
      'type U = typeof import("../../projects/type-query");',
      '// import { z } from "../../projects/in-a-comment";',
      "const s = \"import { y } from '../../projects/in-a-string'\";",
      'import { ok } from "../guards";',
      'import { near } from "../../projects-like/x";',
      'import { pkg } from "@playwright/test";',
      // A regex literal holding a backtick, `/*` or a quote ends no import that follows it.
      "const backtick = /`/g;",
      'const lazy = () => import("../../projects/after-a-backtick-regex");',
      'const trim = (p: string) => p.replace(/\\/*$/, "");',
      'import { e } from "../../projects/after-a-slash-star-regex";',
      'const quote = /"/; import("../../projects/after-a-quote-regex");',
      "const name = 'x';",
      "const f = await import(`../../projects/${name}`);",
    ].join("\n");

    expect(productImports(file, source)).toEqual([
      "../../projects/static",
      "../../projects/type-only",
      "../../projects/side-effect",
      "../../projects/re-export",
      "../../projects",
      "../../projects/dynamic",
      "../../projects/template",
      "../../projects/type-query",
      "../../projects/after-a-backtick-regex",
      "../../projects/after-a-slash-star-regex",
      "../../projects/after-a-quote-regex",
      "(computed) line 20",
    ]);
    // Test code may compute a path: it never ships.
    expect(
      productImports(join(COMMON_DIR, "hooks", "example.spec.ts"), source),
    ).not.toContain("(computed) line 20");
  });

  test("no file under src/common/ imports from src/projects/, in any form", () => {
    const offenders = readdirSync(COMMON_DIR, {
      recursive: true,
      encoding: "utf8",
    })
      .filter(isCodeFile)
      .flatMap((file) => {
        const path = join(COMMON_DIR, file);
        return productImports(path, readFileSync(path, "utf8")).map(
          (specifier) => `src/common/${file}: ${specifier}`,
        );
      });

    expect(
      offenders,
      "declare what the shared code needs on ProductConfig instead",
    ).toEqual([]);
  });
});
