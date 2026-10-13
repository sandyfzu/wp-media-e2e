import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import {
  importsIn,
  isCodeFile,
  isDeclarationFile,
  isInside,
  isTestCode,
  pathOf,
  type Resolver,
} from "../../src/common/__fixtures__/import-scan";

/**
 * The orchestrator's import boundary, as functions its spec can test: which files are its own code,
 * which suite modules `suite-imports.json` may admit, and which imports leave `orchestrator/` for
 * anything else.
 */

/** `orchestrator/`. */
export const ORCHESTRATOR_DIR = fileURLToPath(new URL("..", import.meta.url));

/** The repository root, which `suite-imports.json`'s paths are relative to. */
export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The command's entry, relative to `orchestrator/`: it starts the orchestrator when imported. */
export const COMMAND_ENTRY = "cli.ts";

/**
 * The suite modules that change the process as they are imported — `load-env.ts` loads `.env`,
 * `run-context.ts` stamps `RUN_ID` and imports it — relative to the repository. No admitted module
 * may reach one, at import or later.
 */
export const SIDE_EFFECT_ROOTS: readonly string[] = [
  "src/common/config/load-env.ts",
  "src/common/config/run-context.ts",
];

/**
 * The builtins orchestrator code may not load, with or without `node:`: each loads or runs code no
 * import guard sees — `require` (`module`), a thread sharing the process (`worker_threads`), a
 * context (`vm`), code evaluated in the process itself (`inspector`, `repl`). The orchestrator spawns
 * processes and needs none of them. `eslint.config.js` refuses the same list.
 */
export const REFUSED_BUILTINS: readonly string[] = [
  "module",
  "worker_threads",
  "vm",
  "inspector",
  "inspector/promises",
  "repl",
];

/**
 * The names orchestrator code may not use, and why: each runs or loads code by a string no import
 * guard reads.
 */
const REFUSED_NAMES: ReadonlyMap<string, string> = new Map([
  ["eval", "runs code from a string"],
  ["Function", "builds code from a string"],
  ["getBuiltinModule", "loads a builtin by a string"],
]);

/** Whether `specifier` names one of {@link REFUSED_BUILTINS}. */
function isRefusedBuiltin(specifier: string): boolean {
  return REFUSED_BUILTINS.includes(specifier.replace(/^node:/, ""));
}

/**
 * The name `node` spells, when it is one a reference to {@link REFUSED_NAMES} can take: an
 * identifier — a variable, a property after a dot, a key destructured — or a string literal used
 * as a property name (`process["getBuiltinModule"]`, `{ "eval": e } = globalThis`,
 * `{ ["eval"]: e } = globalThis`).
 */
function spelledName(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  const { parent } = node;
  const isPropertyName =
    (ts.isElementAccessExpression(parent) &&
      parent.argumentExpression === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node) ||
    ts.isComputedPropertyName(parent);
  return isPropertyName && ts.isStringLiteralLike(node) ? node.text : undefined;
}

/**
 * Every use of a refused name in `source`, read as the file `file`, as `<name> — <reason>`, in
 * source order: `eval`, `Function`, and `getBuiltinModule` on any object. Judged by spelling, so a
 * name reached through a string (`Reflect.get(process, "getBuiltinModule")`) or built at run time
 * (`process["get" + "BuiltinModule"]`) is not seen.
 */
export function forbiddenNames(file: string, source: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const name = spelledName(node);
    const reason = name === undefined ? undefined : REFUSED_NAMES.get(name);
    if (name !== undefined && reason !== undefined) {
      found.push(`${name} — ${reason}`);
    }
    ts.forEachChild(node, visit);
  };
  // From the file's children: every node visited then has a parent, which `spelledName` reads.
  ts.forEachChild(tree, visit);
  return found;
}

/**
 * Why each entry of `value` — `suite-imports.json`'s content — cannot be admitted; empty when all
 * can. An entry is a repository path to an existing `.ts` module under `src/`, written once and in its
 * one normal form (no `.` or `..` segment, which would let a detour leave `src/`), and never test code
 * or a declaration file.
 */
export function allowlistProblems(
  value: unknown,
  repoRoot: string = REPO_ROOT,
): string[] {
  if (!Array.isArray(value)) return ["must be an array of paths"];
  const seen = new Set<string>();
  return value.flatMap((entry: unknown): string[] => {
    if (typeof entry !== "string")
      return [`${JSON.stringify(entry)}: not a string`];
    const problems: string[] = [];
    if (seen.has(entry)) problems.push("listed twice");
    seen.add(entry);
    if (
      posix.normalize(entry) !== entry ||
      entry.split("/").some((segment) => segment === "." || segment === "..")
    ) {
      problems.push("not in normal form");
    }
    if (!entry.startsWith("src/") || !entry.endsWith(".ts")) {
      problems.push("not a .ts module under src/");
    }
    if (isDeclarationFile(entry)) problems.push("a declaration file");
    if (isTestCode(entry)) problems.push("test code");
    const file = join(repoRoot, entry);
    if (!existsSync(file) || !statSync(file).isFile()) {
      problems.push("no such file");
    }
    return problems.map((problem) => `${entry}: ${problem}`);
  });
}

/**
 * The orchestrator's own code in `dir`, relative to it, sorted: every file Node or tsx can load —
 * `.mts`, `.js`, `.d.ts` and the rest, so no dialect slips past the scan — but test code.
 */
export function orchestratorCode(dir: string = ORCHESTRATOR_DIR): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => isCodeFile(path) && !isTestCode(path))
    .sort();
}

/**
 * The files in `dir` that would make the orchestrator's code CommonJS, relative to it, sorted: a
 * `.cts` or `.cjs` module, or a `package.json`, which can make a `.js` one CommonJS. CommonJS hands a
 * module `require` and `module.require`, which load whatever a computed name says, and neither guard
 * follows a `require` once it is renamed. The orchestrator is ES modules only. Test code and
 * declaration files are exempt.
 */
export function commonJsFiles(dir: string = ORCHESTRATOR_DIR): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter(
      (path) =>
        (/\.c[jt]s$/.test(path) || basename(path) === "package.json") &&
        !isDeclarationFile(path) &&
        !isTestCode(path),
    )
    .sort();
}

/**
 * Whether a file of {@link orchestratorCode} is imported by the spec's probe: not the root
 * {@link COMMAND_ENTRY}, which starts the orchestrator, nor a declaration file, which has nothing to
 * run.
 */
export function isProbed(path: string): boolean {
  return path !== COMMAND_ENTRY && !isDeclarationFile(path);
}

/**
 * Why an import leading to `target` is refused — or `undefined` when it is allowed: inside
 * `orchestrator/` but test code, or outside it and not admitted.
 */
function refusal(
  target: string,
  admitted: ReadonlySet<string>,
  orchestratorDir: string,
): string | undefined {
  if (isInside(orchestratorDir, target)) {
    return isTestCode(relative(orchestratorDir, target).split(sep).join("/"))
      ? "test code"
      : undefined;
  }
  return admitted.has(target) ? undefined : "not in suite-imports.json";
}

/**
 * The imports of `source`, read as the file `file`, that the boundary refuses, as
 * `<specifier> — <reason>`: a computed path, which cannot be checked; one of
 * {@link REFUSED_BUILTINS}; a path or `#` import that leads nowhere outside `orchestrator/`; test
 * code; anything outside `orchestrator/` but an `admitted` module (absolute paths). Each import is
 * judged where it really leads — `.js` to `.ts`, a detour, a `#` import — and lexically when it leads
 * nowhere.
 */
export function forbiddenImports(
  file: string,
  source: string,
  admitted: ReadonlySet<string>,
  resolveImport: Resolver,
  orchestratorDir: string = ORCHESTRATOR_DIR,
): string[] {
  return importsIn(file, source).flatMap(({ specifier }) => {
    if (specifier === undefined) return ["(computed) — cannot be checked"];
    if (isRefusedBuiltin(specifier)) {
      return [`${specifier} — loads or runs code unchecked`];
    }
    const resolution = resolveImport(specifier, file);
    if (resolution.kind === "package") return [];
    let reason: string | undefined;
    if (resolution.kind === "file") {
      reason = refusal(resolution.path, admitted, orchestratorDir);
    } else {
      // A module of its own not written yet is judged by its path; anything else that leads
      // nowhere is refused.
      const target = pathOf(file, specifier);
      reason =
        target !== undefined && isInside(orchestratorDir, target)
          ? refusal(target, admitted, orchestratorDir)
          : "leads nowhere";
    }
    return reason === undefined ? [] : [`${specifier} — ${reason}`];
  });
}

/**
 * Everything in `source`, read as the file `file`, that the boundary refuses: its
 * {@link forbiddenImports}, then its {@link forbiddenNames}.
 */
export function boundaryViolations(
  file: string,
  source: string,
  admitted: ReadonlySet<string>,
  resolveImport: Resolver,
  orchestratorDir: string = ORCHESTRATOR_DIR,
): string[] {
  return [
    ...forbiddenImports(file, source, admitted, resolveImport, orchestratorDir),
    ...forbiddenNames(file, source),
  ];
}
