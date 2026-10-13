import { test, expect } from "@playwright/test";

import { lostKeys } from "./json-keys";

test.describe("lostKeys", () => {
  test("finds nothing in a file whose every key is kept", () => {
    expect(lostKeys("{}")).toEqual([]);
    expect(lostKeys("[]")).toEqual([]);
    expect(lostKeys('"text"')).toEqual([]);
    expect(
      lostKeys(
        JSON.stringify({
          tasks: [
            { id: "a", plugin: { ref: "x" } },
            { id: "b", plugin: { ref: "y" } },
          ],
          secrets: { A: "id", B: '{"A": 1, "A": 2}' },
        }),
      ),
    ).toEqual([]);
  });

  test("finds a key repeated at the root, in a nested object, and in an array's object", () => {
    expect(lostKeys('{ "tasks": [], "runs": {}, "tasks": [] }')).toEqual([
      '(root): the key "tasks" appears more than once; JSON keeps only the last',
    ]);
    expect(
      lostKeys('{ "secrets": { "GH_TOKEN": "a", "GH_TOKEN": "b" } }'),
    ).toEqual([
      'secrets: the key "GH_TOKEN" appears more than once; JSON keeps only the last',
    ]);
    expect(
      lostKeys(
        '{ "tasks": [{ "id": "a" }, [1, {}], { "id": "b", "id": "c" }] }',
      ),
    ).toEqual([
      'tasks[2]: the key "id" appears more than once; JSON keeps only the last',
    ]);
  });

  test("reads keys as JSON does: escapes decoded, quotes inside strings ignored", () => {
    expect(lostKeys('{ "a": 1, "\\u0061": 2 }')).toEqual([
      '(root): the key "a" appears more than once; JSON keeps only the last',
    ]);
    expect(lostKeys('{ "a\\"b": "}{\\"a\\"", "c": "\\\\" , "d": 1}')).toEqual(
      [],
    );
    expect(lostKeys('{ "a": 1, "A": 2 }')).toEqual([]);
  });

  test("finds __proto__ wherever it is, and says it once per place", () => {
    expect(lostKeys('{ "secrets": { "__proto__": "x" } }')).toEqual([
      'secrets: no setting is named "__proto__", and JSON tools drop it',
    ]);
    expect(lostKeys('{ "__proto__": {}, "__proto__": {} }')).toEqual([
      '(root): no setting is named "__proto__", and JSON tools drop it',
      '(root): no setting is named "__proto__", and JSON tools drop it',
    ]);
  });

  test("keeps the paths of the containers it left behind", () => {
    expect(
      lostKeys(
        '{ "a": { "b": [ {}, { "c": { "d": 1, "d": 2 } } ] }, "e": { "f": 1, "f": 2 } }',
      ),
    ).toEqual([
      'a.b[1].c: the key "d" appears more than once; JSON keeps only the last',
      'e: the key "f" appears more than once; JSON keeps only the last',
    ]);
  });
});
