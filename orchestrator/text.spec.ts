import { test, expect } from "@playwright/test";

import { cut, oneLine, safeBlock, safeLine, secretForms } from "./text";

/** A GitHub token by its shape, and its 36 characters after the prefix. */
const BODY = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const TOKEN = `ghp_${BODY}`;

/**
 * A token split by each thing a cleaned line removes — a terminal code, a zero-width space, a bidi
 * override, a soft hyphen — and the same, coloured whole.
 */
const SPLIT_TOKENS = [
  `ghp_\u001b[0m${BODY}`,
  `ghp_\u200b${BODY}`,
  `ghp_\u202e${BODY}`,
  `ghp_\u00ad${BODY}`,
  `\u001b[36m${TOKEN}\u001b[39m`,
];

test.describe("cut", () => {
  test("keeps text within the limit as it is", () => {
    expect(cut("abc", 3)).toBe("abc");
    expect(cut("", 1)).toBe("");
  });

  test("cuts longer text to the limit, the ellipsis included", () => {
    expect(cut("abcdef", 4)).toBe("abc…");
    expect(cut("abc", 1)).toBe("…");
    expect(Array.from(cut("x".repeat(600), 500))).toHaveLength(500);
  });

  test("counts and cuts by code point, never splitting a surrogate pair", () => {
    expect(cut("😀😀😀", 3)).toBe("😀😀😀");
    expect(cut("😀😀😀😀", 3)).toBe("😀😀…");
  });

  test("refuses a limit that is not a whole number from 1, which would return more than asked", () => {
    for (const max of [0, -1, 1.5, Number.NaN, Infinity])
      expect(() => cut("abc", max), String(max)).toThrow(RangeError);
  });
});

test.describe("oneLine", () => {
  test("removes terminal codes and turns line breaks and controls into single spaces", () => {
    expect(
      oneLine("\u001b[31mred\u001b[39m\r\n  next\tline\u0085end\u0000"),
    ).toBe("red next line end");
  });

  test("drops invisible format characters and breaks a line separator, as the suite's plain does", () => {
    expect(oneLine("a\u202eb\u200bc\u2028d")).toBe("abc d");
  });

  test("trims, and leaves an empty line empty", () => {
    expect(oneLine("  a  ")).toBe("a");
    expect(oneLine("\n\t")).toBe("");
  });
});

test.describe("safeLine", () => {
  test("masks a credential by its shape, then makes one line and cuts it", () => {
    expect(
      safeLine(
        `fatal: https://x-access-token:${TOKEN}@github.com/o/r\nnext`,
        200,
      ),
    ).toBe("fatal: https://***@github.com/o/r next");
  });

  test("masks before cutting, so a cut never leaves a credential's head unmasked", () => {
    const line = safeLine(
      `${"x".repeat(20)} https://user:hunter2-secret@site.test/`,
      40,
    );
    // Cut after masking, the password's place holds the mask; cut first, its head would remain.
    expect(line).toBe(`${"x".repeat(20)} https://***@site.t…`);
    expect(Array.from(line)).toHaveLength(40);
  });

  test("masks a token that a terminal code or an invisible character splits, which cleaning would join", () => {
    for (const text of SPLIT_TOKENS)
      expect(safeLine(`boom ${text} end`, 500), JSON.stringify(text)).toBe(
        "boom *** end",
      );
  });

  test("masks a URL whose password holds a control character, which cleaning would split", () => {
    expect(safeLine("at https://user:pa\u0007ss@host.test/", 500)).toBe(
      "at https://***@host.test/",
    );
  });

  test("masks every secret value it is given, wherever it appears, the longest first", () => {
    const secrets = ["Tr0ub4dor&3xyz", "Tr0ub4dor&3xyz-and-more"];
    expect(
      safeLine("a Tr0ub4dor&3xyz-and-more b Tr0ub4dor&3xyz", 500, secrets),
    ).toBe("a *** b ***");
  });

  test("masks a secret value an invisible character splits", () => {
    expect(safeLine("pw Tr0ub4\u200bdor&3xyz", 500, ["Tr0ub4dor&3xyz"])).toBe(
      "pw ***",
    );
  });
});

test.describe("safeBlock", () => {
  test("keeps line feeds and tabs, and makes every other line break one", () => {
    expect(safeBlock("a\r\nb\rc\u2028d\u0085e\tf", 500)).toBe(
      "a\nb\nc\nd\ne\tf",
    );
  });

  test("removes terminal codes, turns other controls into spaces and drops invisible characters", () => {
    expect(safeBlock("\u001b[31mx\u001b[0m\u0007y\u202ez\u200b", 500)).toBe(
      "x yz",
    );
  });

  test("masks a URL whose password holds a control character, which cleaning would split", () => {
    expect(safeBlock("at https://user:pa\u0007ss@host.test/", 500)).toBe(
      "at https://***@host.test/",
    );
  });

  test("masks by shape and by value, a split token included, then cuts", () => {
    expect(
      safeBlock(`Expected ${SPLIT_TOKENS[1] ?? ""}\nGot Tr0ub4dor&3xyz`, 500, [
        "Tr0ub4dor&3xyz",
      ]),
    ).toBe("Expected ***\nGot ***");
    expect(Array.from(safeBlock("y".repeat(3000), 2000))).toHaveLength(2000);
  });
});

test.describe("secretForms", () => {
  test("gives a secret as written, URL-encoded, and JSON-escaped as JavaScript and PHP write it", () => {
    expect(secretForms('a"b\\c/d+e')).toEqual([
      'a"b\\c/d+e',
      "a%22b%5Cc%2Fd%2Be",
      'a\\"b\\\\c/d+e',
      'a\\"b\\\\c\\/d+e',
    ]);
    expect(secretForms("plainvalue")).toEqual(["plainvalue"]);
  });

  test("survives a lone surrogate, which has no URL form", () => {
    expect(secretForms("ab\ud800cdefgh")).toEqual([
      "ab\ud800cdefgh",
      "ab\\ud800cdefgh",
    ]);
  });

  test("lets safeLine mask each form", () => {
    const key = "key/with+plus";
    expect(
      safeLine(
        `${encodeURIComponent(key)} ${JSON.stringify(key).replaceAll("/", "\\/")}`,
        100,
        [key],
      ),
    ).toBe('*** "***"');
  });
});
