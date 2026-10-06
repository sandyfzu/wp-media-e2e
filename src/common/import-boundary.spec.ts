import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

/**
 * `src/common/` never imports product code: a product hands the shared code its policy through
 * `ProductConfig` and the config factory's registries. ESLint's `no-restricted-imports` flags a
 * static import as it is typed, but not a dynamic `import()` or a `typeof import()` type. This
 * covers every form, read with TypeScript's own import scanner.
 */

/** `src/common/`, where this file sits. */
const COMMON_DIR = fileURLToPath(new URL(".", import.meta.url));

/** `src/projects/`, which nothing under {@link COMMON_DIR} may import. */
const PROJECTS_DIR = fileURLToPath(new URL("../projects", import.meta.url));

/**
 * The module specifiers in `source`, read as the file at `file`, that resolve into
 * `src/projects/`. Only relative specifiers can: a package or `node:` one never does.
 */
function productImports(file: string, source: string): string[] {
  return ts
    .preProcessFile(source, true, true)
    .importedFiles.map((imported) => imported.fileName)
    .filter((specifier) => {
      if (!specifier.startsWith(".")) return false;
      const path = relative(PROJECTS_DIR, resolve(dirname(file), specifier));
      return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
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
    ]);
  });

  test("no file under src/common/ imports from src/projects/, in any form", () => {
    const offenders = readdirSync(COMMON_DIR, {
      recursive: true,
      encoding: "utf8",
    })
      .filter((file) => file.endsWith(".ts"))
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
