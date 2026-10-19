import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

/**
 * For specs: the modules a source file loads, read from TypeScript's syntax tree — every form, and
 * nothing in a comment or a string. Not `ts.preProcessFile`: a token scanner, it takes a regex literal
 * holding a backtick, a quote or `/*` for the start of a string or a comment, and misses every import
 * after it. ESLint's `no-restricted-imports` sees static imports only, by their spelling; an import
 * boundary is enforced by a spec built on this.
 */

/** One module a file loads. */
export interface ImportRef {
  /** The specifier as written, or `undefined` when it is computed at run time. */
  readonly specifier: string | undefined;
  /** Its 1-based line. */
  readonly line: number;
}

/** `node` without the parentheses around it: `import(("x"))` names `"x"`. */
function unwrapParentheses(node: ts.Expression): ts.Expression {
  let inner = node;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  return inner;
}

/** The text of `node` when it is a string literal — a template without substitutions included. */
function literalText(node: ts.Node | undefined): string | undefined {
  return node !== undefined &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

/**
 * The specifier node of `node` when `node` loads a module: an import or export declaration (type-only
 * included), `import x = require()`, an `import()` or `require()` call, a `typeof import()` type.
 * `null` when `node` loads nothing; `undefined` inside the pair when the specifier is not a literal.
 */
function loadedSpecifier(node: ts.Node): { node: ts.Node | undefined } | null {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier === undefined
      ? null
      : { node: node.moduleSpecifier };
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference)
  ) {
    return { node: node.moduleReference.expression };
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const loads =
      callee.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(callee) && callee.text === "require");
    const [first] = node.arguments;
    return loads
      ? { node: first === undefined ? undefined : unwrapParentheses(first) }
      : null;
  }
  if (ts.isImportTypeNode(node)) {
    return {
      node: ts.isLiteralTypeNode(node.argument)
        ? node.argument.literal
        : undefined,
    };
  }
  return null;
}

/**
 * Every module `source`, read as the file `file` (its extension picks the dialect: `.tsx`, `.mts`,
 * `.js`…), loads, in source order — a lazy `import()` inside a function included.
 */
export function importsIn(file: string, source: string): ImportRef[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: ImportRef[] = [];
  const visit = (node: ts.Node): void => {
    const loaded = loadedSpecifier(node);
    if (loaded !== null) {
      const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
      found.push({ specifier: literalText(loaded.node), line: line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

/**
 * The absolute path `specifier`, written in the file `file`, names when it is a path — relative,
 * absolute or a `file:` URL — resolved lexically (no extension or index file added). `undefined` for
 * a package, a builtin or a `#` subpath import, which only module resolution can place.
 */
export function pathOf(file: string, specifier: string): string | undefined {
  if (specifier.startsWith(".") || isAbsolute(specifier)) {
    return resolve(dirname(file), specifier);
  }
  if (specifier.startsWith("file:")) {
    try {
      return fileURLToPath(specifier);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Whether `path` names a file Node or tsx can load as code: `.ts`, `.mts`, `.cts`, `.tsx`, and the `.js` family. */
export function isCodeFile(path: string): boolean {
  return /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path);
}

/** Whether `path` is a declaration file (`.d.ts`, `.d.mts`, `.d.cts`): types only, nothing to run. */
export function isDeclarationFile(path: string): boolean {
  return /\.d\.[cm]?ts$/.test(path);
}

/** Whether `path` is test code — a `*.spec.*` file, or anything under a `__fixtures__/` folder. */
export function isTestCode(path: string): boolean {
  return (
    /\.spec(?:\.(?:[cm]?[jt]s|[jt]sx))?$/.test(path) ||
    path.split(/[\\/]/).includes("__fixtures__")
  );
}

/** Whether `path` is `dir` itself or lies under it — a lexical test, on absolute paths. */
export function isInside(dir: string, path: string): boolean {
  const rest = relative(dir, path);
  return rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}

/** Where a specifier leads. */
export type Resolution =
  /** A file of the repository, by its absolute path. */
  | { readonly kind: "file"; readonly path: string }
  /** A package or a builtin: outside the repository's own code. */
  | { readonly kind: "package" }
  /** A path or a `#` import that leads nowhere — which `tsc` refuses too. */
  | { readonly kind: "unresolved" };

/** Resolves `specifier` as written in the file `fromFile`. */
export type Resolver = (specifier: string, fromFile: string) => Resolution;

/**
 * A {@link Resolver} that resolves as the repository's TypeScript does, with the compiler options of
 * `tsconfigPath`: bundler resolution, so `.js` leads to the `.ts` file, a folder to its index, `#`
 * to `package.json`'s `imports`, and `paths` apply. A bare specifier TypeScript cannot place —
 * `node:fs`, whose types are ambient — is a builtin or a package.
 *
 * @throws {@link Error} when the tsconfig cannot be read.
 */
export function createResolver(tsconfigPath: string): Resolver {
  const read = ts.readConfigFile(tsconfigPath, (path) => ts.sys.readFile(path));
  if (read.error !== undefined) {
    throw new Error(
      `cannot read ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}`,
    );
  }
  const { options } = ts.convertCompilerOptionsFromJson(
    (read.config as { compilerOptions?: unknown }).compilerOptions,
    dirname(tsconfigPath),
  );
  return (specifier, fromFile) => {
    const resolved = ts.resolveModuleName(
      specifier,
      fromFile,
      options,
      ts.sys,
    ).resolvedModule;
    if (resolved !== undefined) {
      return resolved.isExternalLibraryImport === true
        ? { kind: "package" }
        : { kind: "file", path: resolved.resolvedFileName };
    }
    return pathOf(fromFile, specifier) !== undefined ||
      specifier.startsWith("#")
      ? { kind: "unresolved" }
      : { kind: "package" };
  };
}

/** What {@link localClosure} found. */
export interface Closure {
  /** Every repository file reached, the entries included, sorted. */
  readonly files: readonly string[];
  /** Each load it could not follow: `<file>:<line> <specifier or "(computed)">`. */
  readonly unfollowed: readonly string[];
}

/**
 * Every repository file `entries` load, transitively, at import time or later — a lazy `import()`
 * inside a function counts, since it can still run. Packages are not entered. A computed specifier,
 * or one that resolves nowhere, cannot be followed and is listed instead.
 */
export function localClosure(
  entries: readonly string[],
  resolveImport: Resolver,
): Closure {
  const seen = new Set<string>();
  const unfollowed: string[] = [];
  const queue = [...entries];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { specifier, line } of importsIn(
      file,
      readFileSync(file, "utf8"),
    )) {
      const resolution =
        specifier === undefined
          ? ({ kind: "unresolved" } as const)
          : resolveImport(specifier, file);
      if (resolution.kind === "file") queue.push(resolution.path);
      else if (resolution.kind === "unresolved") {
        unfollowed.push(`${file}:${String(line)} ${specifier ?? "(computed)"}`);
      }
    }
  }
  return { files: [...seen].sort(), unfollowed };
}
