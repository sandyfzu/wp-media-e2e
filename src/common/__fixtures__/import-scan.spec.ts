import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createResolver,
  importsIn,
  isCodeFile,
  isDeclarationFile,
  isInside,
  isTestCode,
  localClosure,
  pathOf,
} from "./import-scan";

/**
 * The scanner both import boundaries stand on: what it reads, how it resolves, and how far it walks.
 * A boundary spec is only as good as the forms its scanner sees.
 */

/** The repository root, whose tsconfig the resolver reads. */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** A file this spec pretends to read, in `src/common/__fixtures__/`. */
const HERE = fileURLToPath(new URL("example.ts", import.meta.url));

/** The resolver, as the repository's TypeScript resolves. */
const resolveImport = createResolver(join(REPO_ROOT, "tsconfig.json"));

test.describe("importsIn", () => {
  test("reads every form that loads a module, with its line, and skips comments and strings", () => {
    const source = [
      'import { a } from "./static";',
      'export * from "./re-export";',
      'import x = require("./import-equals");',
      'const r = require("./require-call");',
      'const p = import(("./parenthesised"));',
      'type T = import("./import-type").T;',
      '/* import("./in-a-comment") */ const s = "import(\'./in-a-string\')";',
      "function later() { return import(`./lazy-template`); }",
    ].join("\n");
    expect(importsIn(HERE, source)).toEqual([
      { specifier: "./static", line: 1 },
      { specifier: "./re-export", line: 2 },
      { specifier: "./import-equals", line: 3 },
      { specifier: "./require-call", line: 4 },
      { specifier: "./parenthesised", line: 5 },
      { specifier: "./import-type", line: 6 },
      { specifier: "./lazy-template", line: 8 },
    ]);
  });

  test("reports a specifier computed at run time as undefined", () => {
    const source = [
      "const name = 'x';",
      "import(`./${name}`);",
      'import("./" + name);',
      "require(name);",
    ].join("\n");
    expect(importsIn(HERE, source)).toEqual([
      { specifier: undefined, line: 2 },
      { specifier: undefined, line: 3 },
      { specifier: undefined, line: 4 },
    ]);
  });

  test("reads each dialect by its extension", () => {
    const tsx =
      'import { a } from "./a";\nconst e = <div>{import("./b")}</div>;';
    expect(importsIn(join(REPO_ROOT, "x.tsx"), tsx)).toEqual([
      { specifier: "./a", line: 1 },
      { specifier: "./b", line: 2 },
    ]);
    expect(
      importsIn(join(REPO_ROOT, "x.cjs"), 'const a = require("./a");'),
    ).toEqual([{ specifier: "./a", line: 1 }]);
  });
});

test.describe("pathOf", () => {
  test("places relative, absolute and file: URL specifiers, lexically", () => {
    expect(pathOf(HERE, "../config/run-id")).toBe(
      join(REPO_ROOT, "src/common/config/run-id"),
    );
    expect(pathOf(HERE, "/abs/x")).toBe("/abs/x");
    expect(pathOf(HERE, pathToFileURL("/abs/y.ts").href)).toBe("/abs/y.ts");
  });

  test("places no package, builtin, # import or malformed file: URL", () => {
    for (const specifier of [
      "@playwright/test",
      "node:fs",
      "#suite/x",
      "file://host/x",
    ]) {
      expect(pathOf(HERE, specifier), specifier).toBeUndefined();
    }
  });
});

test.describe("file kinds", () => {
  test("isCodeFile knows every extension Node or tsx loads as code, and nothing else", () => {
    for (const file of [
      "a.ts",
      "a.mts",
      "a.cts",
      "a.tsx",
      "a.js",
      "a.mjs",
      "a.cjs",
      "a.jsx",
    ]) {
      expect(isCodeFile(file), file).toBe(true);
    }
    for (const file of ["a.json", "a.md", "a.ts.bak", "ts"]) {
      expect(isCodeFile(file), file).toBe(false);
    }
  });

  test("isDeclarationFile knows .d.ts, .d.mts and .d.cts only", () => {
    expect(["a.d.ts", "a.d.mts", "a.d.cts"].every(isDeclarationFile)).toBe(
      true,
    );
    expect(["a.ts", "d.ts", "a.d.tsx"].some(isDeclarationFile)).toBe(false);
  });

  test("isTestCode knows spec files of every dialect and anything under __fixtures__/", () => {
    for (const path of [
      "a.spec.ts",
      "x/a.run.spec.mts",
      "a.spec.js",
      "__fixtures__/h.ts",
      "x/__fixtures__/y/h.ts",
    ]) {
      expect(isTestCode(path), path).toBe(true);
    }
    for (const path of [
      "spec.ts",
      "a.specs.ts",
      "inspect.ts",
      "x/__fixtures/h.ts",
    ]) {
      expect(isTestCode(path), path).toBe(false);
    }
  });

  test("isInside tells a folder's own paths from look-alikes", () => {
    expect(isInside("/r/orchestrator", "/r/orchestrator")).toBe(true);
    expect(isInside("/r/orchestrator", "/r/orchestrator/a/b.ts")).toBe(true);
    expect(isInside("/r/orchestrator", "/r/orchestrator/..b.ts")).toBe(true);
    expect(isInside("/r/orchestrator", "/r/orchestrator-x/a.ts")).toBe(false);
    expect(isInside("/r/orchestrator", "/r/src/a.ts")).toBe(false);
  });
});

test.describe("createResolver", () => {
  test("leads a path, with or without .js, to the repository's .ts file", () => {
    const runId = join(REPO_ROOT, "src/common/config/run-id.ts");
    expect(resolveImport("../config/run-id", HERE)).toEqual({
      kind: "file",
      path: runId,
    });
    expect(resolveImport("../config/run-id.js", HERE)).toEqual({
      kind: "file",
      path: runId,
    });
  });

  test("calls a package or a builtin a package", () => {
    for (const specifier of ["@playwright/test", "typescript", "node:fs"]) {
      expect(resolveImport(specifier, HERE), specifier).toEqual({
        kind: "package",
      });
    }
  });

  test("calls a path or a # import that leads nowhere unresolved", () => {
    for (const specifier of ["./no-such-module", "#no-such-import"]) {
      expect(resolveImport(specifier, HERE), specifier).toEqual({
        kind: "unresolved",
      });
    }
  });

  test("refuses a tsconfig it cannot read, naming it", () => {
    expect(() => createResolver(join(REPO_ROOT, "no-tsconfig.json"))).toThrow(
      /cannot read .*no-tsconfig\.json/,
    );
  });
});

test.describe("localClosure", () => {
  /** A folder of small modules, written for the test. */
  let dir = "";

  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "e2e-import-scan-"));
    const modules: Readonly<Record<string, string>> = {
      "a.ts": 'import "./b";\nexport const later = () => import("./c");',
      "b.ts": 'export * from "./d.js";',
      "c.ts": "const n = 'x';\nexport const x = () => import(`./${n}`);",
      "d.ts": 'import "node:fs";\nimport "./missing";',
      "unreached.ts": "export {};",
    };
    for (const [name, source] of Object.entries(modules)) {
      writeFileSync(join(dir, name), `${source}\n`);
    }
  });

  test.afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("follows static, re-exported and lazy imports, and lists what it cannot follow", () => {
    const closure = localClosure([join(dir, "a.ts")], resolveImport);
    expect(closure.files).toEqual(
      ["a.ts", "b.ts", "c.ts", "d.ts"].map((name) => join(dir, name)),
    );
    expect(closure.unfollowed).toEqual([
      `${join(dir, "c.ts")}:2 (computed)`,
      `${join(dir, "d.ts")}:2 ./missing`,
    ]);
  });

  test("reaches run-context from a module that imports it", () => {
    const closure = localClosure(
      [join(REPO_ROOT, "src/common/config/project.ts")],
      resolveImport,
    );
    expect(closure.files).toContain(
      join(REPO_ROOT, "src/common/config/run-context.ts"),
    );
  });
});
