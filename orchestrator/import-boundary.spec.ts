import { test, expect } from "@playwright/test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { Linter } from "eslint";
import tseslint from "typescript-eslint";

import {
  probeImports,
  type ImportEffects,
} from "../src/common/__fixtures__/import-probe";
import {
  createResolver,
  localClosure,
} from "../src/common/__fixtures__/import-scan";
import {
  allowlistProblems,
  forbiddenImports,
  isProbed,
  orchestratorCode,
  ORCHESTRATOR_DIR,
  REPO_ROOT,
  SIDE_EFFECT_ROOTS,
} from "./__fixtures__/import-boundary";
import suiteImports from "./suite-imports.json" with { type: "json" };

/**
 * The orchestrator is a long-lived process: it must keep the process-wide state it was started with
 * — environment, listeners on process events, working directory, exit code. `run-context.ts`, and
 * every module importing it, loads `.env` and stamps `RUN_ID` when imported, so the orchestrator's
 * code reaches outside `orchestrator/` only for the modules `suite-imports.json` admits. ESLint
 * refuses the rest as it is typed, by spelling alone. This spec judges every import where it really
 * leads, walks everything an admitted module can load, and imports the code to see what it does.
 *
 * Stated limits — the boundary catches mistakes, not evasion: a `require` made by `createRequire`
 * under another name, a `Worker`, a file read and evaluated, and what a package does are not seen.
 */

/** The admitted modules, as absolute paths. */
const ADMITTED = new Set(suiteImports.map((path) => join(REPO_ROOT, path)));

/** The resolver, as the repository's TypeScript resolves. */
const resolveImport = createResolver(join(REPO_ROOT, "tsconfig.json"));

/** The entries of `probed` that changed something, for a readable failure. */
function withEffects(probed: readonly ImportEffects[]): ImportEffects[] {
  return probed.filter((entry) => entry.effects.length > 0);
}

test.describe("suite-imports.json — the suite modules the orchestrator may import", () => {
  test("lists only existing .ts modules under src/, each once and in normal form, none of them test code", () => {
    expect(allowlistProblems(suiteImports)).toEqual([]);
  });

  test("allowlistProblems refuses every entry that is not such a module", () => {
    expect(allowlistProblems({})).toEqual(["must be an array of paths"]);
    expect(
      allowlistProblems([
        42,
        "src/common/config/run-id.ts",
        "src/common/config/run-id.ts",
        "src/common/config/./run-id.ts",
        "src/../playwright.config.ts",
        "healthcheck.ts",
        "src/common/__fixtures__/child-node.ts",
        "src/common/config/run-id.spec.ts",
        "src/common/config/types.d.ts",
        "src/common/config/no-such-module.ts",
      ]),
    ).toEqual([
      "42: not a string",
      "src/common/config/run-id.ts: listed twice",
      "src/common/config/./run-id.ts: not in normal form",
      "src/../playwright.config.ts: not in normal form",
      "healthcheck.ts: not a .ts module under src/",
      "src/common/__fixtures__/child-node.ts: test code",
      "src/common/config/run-id.spec.ts: test code",
      "src/common/config/types.d.ts: a declaration file",
      "src/common/config/types.d.ts: no such file",
      "src/common/config/no-such-module.ts: no such file",
    ]);
  });

  test("admits only modules that change nothing in the process as they are imported", async () => {
    expect(withEffects(await probeImports([...ADMITTED]))).toEqual([]);
  });

  test("admits only modules that can never load one that changes the process, even lazily", () => {
    const closure = localClosure([...ADMITTED], resolveImport);
    const roots = SIDE_EFFECT_ROOTS.map((path) => join(REPO_ROOT, path));
    expect(closure.files.filter((file) => roots.includes(file))).toEqual([]);
    expect(closure.unfollowed, "every load must be followed").toEqual([]);
  });

  test("names as side-effect roots modules that do change the process as they are imported", async () => {
    const probed = await probeImports(
      SIDE_EFFECT_ROOTS.map((path) => join(REPO_ROOT, path)),
    );
    expect(
      probed.slice(0, -1).map((entry) => entry.effects.length > 0),
    ).toEqual(SIDE_EFFECT_ROOTS.map(() => true));
  });
});

/**
 * One import, written in `orchestrator/runs/example.ts`, and how each reader judges it: whether
 * ESLint refuses it, and what the spec's scan says (`null` when it allows it). They differ where
 * ESLint, reading spelling alone, cannot know better — the scan is the authority.
 */
interface ImportCase {
  readonly code: string;
  readonly lint: boolean;
  readonly scan: string | null;
}

/** The suite's run-context, as an absolute path without extension. */
const RUN_CONTEXT = join(REPO_ROOT, "src/common/config/run-context");

/** Every import form and spelling the two readers must agree on — or knowingly differ on. */
const CASES: readonly ImportCase[] = [
  {
    code: 'import { a } from "../../src/common/config/run-context";',
    lint: true,
    scan: "../../src/common/config/run-context — not in suite-imports.json",
  },
  {
    code: 'import type { T } from "../../src/common/config/types";',
    lint: true,
    scan: "../../src/common/config/types — not in suite-imports.json",
  },
  {
    code: 'export * from "../../src/common/artifacts/consume";',
    lint: true,
    scan: "../../src/common/artifacts/consume — not in suite-imports.json",
  },
  {
    code: 'const m = await import("../../src/common/config/run-context");',
    lint: false,
    scan: "../../src/common/config/run-context — not in suite-imports.json",
  },
  {
    code: 'type U = typeof import("../../src/common/config/project");',
    lint: false,
    scan: "../../src/common/config/project — not in suite-imports.json",
  },
  {
    code: 'const n = "run-context";\nawait import(`../../src/common/config/${n}`);',
    lint: true,
    scan: "(computed) — cannot be checked",
  },
  {
    code: 'import config from "../../playwright.config";',
    lint: false,
    scan: "../../playwright.config — not in suite-imports.json",
  },
  {
    code: `import { a } from ${JSON.stringify(RUN_CONTEXT)};`,
    lint: true,
    scan: `${RUN_CONTEXT} — not in suite-imports.json`,
  },
  {
    code: `import { a } from ${JSON.stringify(pathToFileURL(`${RUN_CONTEXT}.ts`).href)};`,
    lint: true,
    scan: `${pathToFileURL(`${RUN_CONTEXT}.ts`).href} — leads nowhere`,
  },
  {
    code: 'import { a } from "#suite/run-context";',
    lint: false,
    scan: "#suite/run-context — leads nowhere",
  },
  {
    code: 'import { h } from "./__fixtures__/helper";',
    lint: true,
    scan: "./__fixtures__/helper — test code",
  },
  {
    code: 'import { s } from "./setup.spec";',
    lint: true,
    scan: "./setup.spec — test code",
  },
  {
    code: 'import { createRequire } from "node:module";',
    lint: true,
    scan: null,
  },
  // Admitted: as written, by its .js spelling, or by a detour ESLint cannot see through.
  {
    code: 'import { p } from "../../src/projects/products";',
    lint: false,
    scan: null,
  },
  {
    code: 'import { r } from "../../src/common/config/run-id.js";',
    lint: false,
    scan: null,
  },
  {
    code: 'import { r } from "../../src/common/config/../config/run-id";',
    lint: true,
    scan: null,
  },
  // Its own modules, and a package's own `src/`.
  { code: 'import { c } from "../config/schema";', lint: false, scan: null },
  {
    code: 'import { z } from "some-package/src/index";',
    lint: false,
    scan: null,
  },
];

/** Where {@link CASES} are written. */
const EXAMPLE = join(ORCHESTRATOR_DIR, "runs", "example.ts");

/** ESLint's blocks for `orchestrator/`, from the repository's own `eslint.config.js`. */
async function orchestratorLintBlocks(): Promise<Linter.Config[]> {
  const loaded: unknown = await import(
    pathToFileURL(join(REPO_ROOT, "eslint.config.js")).href
  );
  return (loaded as { default: Linter.Config[] }).default.filter((block) =>
    [block.files]
      .flat(2)
      .some(
        (glob) => typeof glob === "string" && glob.startsWith("orchestrator/"),
      ),
  );
}

/** The rule ids ESLint reports on `code` as the file `file`, failing on a parse error. */
async function lintRules(code: string, file: string): Promise<string[]> {
  const linter = new Linter({ configType: "flat", cwd: REPO_ROOT });
  const messages = linter.verify(
    code,
    [
      {
        files: ["**/*.{ts,mts,cts}"],
        languageOptions: { parser: tseslint.parser },
      },
      ...(await orchestratorLintBlocks()),
    ],
    file,
  );
  expect(messages.filter((message) => message.fatal === true)).toEqual([]);
  return messages.map((message) => message.ruleId ?? "");
}

test.describe("orchestrator/ code imports only itself and the admitted modules", () => {
  test("the scan refuses what leaves orchestrator/ for anything but an admitted module, judged where it leads", () => {
    for (const { code, scan } of CASES) {
      expect(
        forbiddenImports(EXAMPLE, code, ADMITTED, resolveImport),
        code,
      ).toEqual(scan === null ? [] : [scan]);
    }
  });

  test("ESLint refuses what it can see by spelling, and is stricter than the scan where spelling misleads it", async () => {
    for (const { code, lint } of CASES) {
      expect((await lintRules(code, EXAMPLE)).length > 0, code).toBe(lint);
    }
  });

  test("ESLint reads every dialect of the orchestrator's code, and leaves its test code alone", async () => {
    const code = 'import { a } from "../../src/common/config/run-context";';
    for (const name of [
      "example.mts",
      "example.cts",
      "example.js",
      "example.mjs",
    ]) {
      expect(
        await lintRules(code, join(ORCHESTRATOR_DIR, "runs", name)),
        name,
      ).toEqual(["no-restricted-imports"]);
    }
    for (const path of ["runs/example.spec.ts", "__fixtures__/helper.ts"]) {
      expect(await lintRules(code, join(ORCHESTRATOR_DIR, path)), path).toEqual(
        [],
      );
    }
  });

  test.describe("orchestratorCode and isProbed", () => {
    /** A folder shaped like `orchestrator/`, every kind of file in it. */
    let dir = "";

    test.beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "e2e-orchestrator-code-"));
      for (const path of [
        "cli.ts",
        "a.ts",
        "b.mts",
        "c.cts",
        "d.tsx",
        "e.js",
        "f.mjs",
        "g.cjs",
        "types.d.ts",
        "sub/cli.ts",
        "a.spec.ts",
        "x.run.spec.mts",
        "__fixtures__/h.ts",
        "sub/__fixtures__/i.js",
        "config.example.json",
        "README.md",
      ]) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), "export {};\n");
      }
    });

    test.afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    test("lists every dialect of code, declaration files included, and no test code", () => {
      expect(orchestratorCode(dir)).toEqual([
        "a.ts",
        "b.mts",
        "c.cts",
        "cli.ts",
        "d.tsx",
        "e.js",
        "f.mjs",
        "g.cjs",
        "sub/cli.ts",
        "types.d.ts",
      ]);
    });

    test("probes all of it but the root command entry and declaration files", () => {
      expect(orchestratorCode(dir).filter(isProbed)).toEqual([
        "a.ts",
        "b.mts",
        "c.cts",
        "d.tsx",
        "e.js",
        "f.mjs",
        "g.cjs",
        "sub/cli.ts",
      ]);
    });
  });

  test("no orchestrator code imports anything the boundary refuses, in any form", () => {
    const offenders = orchestratorCode().flatMap((path) => {
      const file = join(ORCHESTRATOR_DIR, path);
      return forbiddenImports(
        file,
        readFileSync(file, "utf8"),
        ADMITTED,
        resolveImport,
      ).map((refused) => `orchestrator/${path}: ${refused}`);
    });
    expect(
      offenders,
      "import only what suite-imports.json admits; admit a module once this spec proves it leaves the process as it was",
    ).toEqual([]);
  });

  test("importing the orchestrator's code but the command's entry changes nothing in the process", async () => {
    const files = orchestratorCode()
      .filter(isProbed)
      .map((path) => join(ORCHESTRATOR_DIR, path));
    expect(withEffects(await probeImports(files))).toEqual([]);
  });
});
