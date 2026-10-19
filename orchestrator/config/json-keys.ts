import { describeKey, formatPath } from "./parse";

/** A JSON string token, quotes included. */
// eslint-disable-next-line no-control-regex -- JSON forbids raw control characters in a string.
const STRING_TOKEN = /"(?:[^"\\\u0000-\u001f]|\\.)*"/y;

/** An object being read: the keys seen so far, the last one, and whether a key comes next. */
interface ObjectFrame {
  readonly kind: "object";
  readonly keys: Set<string>;
  key: string;
  expectsKey: boolean;
}

/** An array being read, and the index of the element being read. */
interface ArrayFrame {
  readonly kind: "array";
  index: number;
}

/**
 * The keys `JSON.parse` would lose without a word, one line each with its path: a key repeated in
 * one object (JSON keeps the last, so a second `"tasks"` silently replaces the first), and
 * `__proto__`, which no setting is named and which a record drops.
 *
 * @param text - text `JSON.parse` has already accepted; anything else gives no meaningful answer.
 * @returns one `path: problem` line per key, in the file's order; none when every key is kept.
 *
 * @example
 * ```ts
 * lostKeys('{ "tasks": [], "tasks": [] }'); // ['(root): the key "tasks" appears more than once; JSON keeps only the last']
 * ```
 */
export function lostKeys(text: string): string[] {
  const problems: string[] = [];
  const stack: (ObjectFrame | ArrayFrame)[] = [];
  for (let at = 0; at < text.length; at++) {
    const top = stack.at(-1);
    switch (text[at]) {
      case "{":
        stack.push({
          kind: "object",
          keys: new Set(),
          key: "",
          expectsKey: true,
        });
        break;
      case "[":
        stack.push({ kind: "array", index: 0 });
        break;
      case "}":
      case "]":
        stack.pop();
        break;
      case ",":
        if (top?.kind === "array") top.index++;
        else if (top !== undefined) top.expectsKey = true;
        break;
      case '"': {
        STRING_TOKEN.lastIndex = at;
        const token = STRING_TOKEN.exec(text)?.[0] ?? '""';
        at += token.length - 1;
        if (top?.kind !== "object" || !top.expectsKey) break;
        const key = JSON.parse(token) as string;
        const problem = keyProblem(top, key);
        if (problem !== undefined)
          problems.push(`${formatPath(pathTo(stack))}: ${problem}`);
        top.keys.add(key);
        top.key = key;
        top.expectsKey = false;
        break;
      }
    }
  }
  return problems;
}

/**
 * What is wrong with `key` in the object `frame` is reading, if anything. A key is shown only as
 * `describeKey` allows.
 *
 * @param frame - the object.
 * @param key - the key just read.
 * @returns the problem, or `undefined`.
 */
function keyProblem(frame: ObjectFrame, key: string): string | undefined {
  if (key === "__proto__")
    return 'no setting is named "__proto__", and JSON tools drop it';
  if (frame.keys.has(key)) {
    const shown = describeKey(key);
    return `${shown === key ? `the key "${key}"` : shown} appears more than once; JSON keeps only the last`;
  }
  return undefined;
}

/**
 * The path of the innermost object being read: each enclosing object's current key, each enclosing
 * array's current index.
 *
 * @param stack - the containers being read, outermost first.
 * @returns keys and indexes.
 */
function pathTo(stack: readonly (ObjectFrame | ArrayFrame)[]): PropertyKey[] {
  return stack
    .slice(0, -1)
    .map((frame) => (frame.kind === "object" ? frame.key : frame.index));
}
