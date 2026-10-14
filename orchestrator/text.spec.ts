import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  cut,
  failureLine,
  oneLine,
  safeBlock,
  safeLine,
  safeSiteUrl,
  secretForms,
  shellWord,
  textOf,
} from "./text";

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

  test("masks a secret whole even where a credential's shape matches inside it", () => {
    // By shape first, `pwd=\u2026` and the token's head went alone, and the rest matched no value.
    for (const secret of [
      "Pr1vate;pwd=Zq8vLm2p",
      "ghp_shortish_but_has_1234567890-tail!!",
    ]) {
      expect(
        safeLine(`login failed with ${secret} for user`, 200, [secret]),
        secret,
      ).toBe("login failed with *** for user");
      expect(safeBlock(`failed: ${secret}`, 200, [secret]), secret).toBe(
        "failed: ***",
      );
    }
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
  test("gives a secret as written, URL-encoded with either case of hex, and JSON-escaped as JavaScript and PHP write it", () => {
    expect(secretForms('a"b\\c/d+e')).toEqual([
      'a"b\\c/d+e',
      "a%22b%5Cc%2Fd%2Be",
      "a%22b%5cc%2fd%2be",
      'a\\"b\\\\c/d+e',
      'a\\"b\\\\c\\/d+e',
    ]);
    expect(secretForms("plainvalue")).toEqual(["plainvalue"]);
  });

  test("gives a secret form-encoded as URLSearchParams writes it: a space as +, ! escaped", () => {
    const forms = secretForms("pass word!x");
    expect(forms).toContain("pass+word%21x");
    expect(forms).toContain("pass%20word!x");
    expect(new URLSearchParams("s=pass+word%21x").get("s")).toBe("pass word!x");
  });

  test("gives a secret as PHP's rawurlencode and urlencode write it, with !'()* escaped", () => {
    // Both measured in PHP 8.4.
    const forms = secretForms("a*b!c(d)e'f~g h");
    expect(forms).toContain("a%2Ab%21c%28d%29e%27f~g%20h");
    expect(forms).toContain("a%2Ab%21c%28d%29e%27f%7Eg+h");
    expect(forms).toContain("a%2ab%21c%28d%29e%27f%7eg+h");
  });

  test("gives a non-ASCII secret JSON-escaped as PHP's json_encode writes it by default", () => {
    // PHP: json_encode("pässwörd/😀") === "\"p\\u00e4ssw\\u00f6rd\\/\\ud83d\\ude00\""
    const forms = secretForms("pässwörd/😀");
    expect(forms).toContain("p\\u00e4ssw\\u00f6rd\\/\\ud83d\\ude00");
    expect(forms).toContain("p\\u00e4ssw\\u00f6rd/\\ud83d\\ude00");
    expect(forms).toContain("pässwörd/😀");
    expect(forms).toContain("p%C3%A4ssw%C3%B6rd%2F%F0%9F%98%80");
    expect(forms).toContain("p%c3%a4ssw%c3%b6rd%2f%f0%9f%98%80");
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

  test("lets safeLine mask lowercase URL escapes, a form's + and PHP's \\u escapes", () => {
    const key = "kéy/with space";
    const php = "k\\u00e9y\\/with space";
    expect(
      safeLine(
        `url ${encodeURIComponent(key).toLowerCase()} form ${new URLSearchParams({ k: key }).toString().slice(2)} php "${php}"`,
        200,
        [key],
      ),
    ).toBe('url *** form *** php "***"');
  });

  test("masks no form of a secret under 8 characters, which would mask ordinary words", () => {
    // Its URL form is 13 characters long: the floor is the secret's, never its forms'.
    expect(safeLine("a/b/c/d a%2Fb%2Fc%2Fd", 100, ["a/b/c/d"])).toBe(
      "a/b/c/d a%2Fb%2Fc%2Fd",
    );
    expect(safeLine("a/b/c/de a%2Fb%2Fc%2Fde", 100, ["a/b/c/de"])).toBe(
      "*** ***",
    );
  });
});

test.describe("textOf", () => {
  test("an Error's message, else the value, as text", () => {
    expect(textOf(new Error("disk full"))).toBe("disk full");
    expect(textOf(new TypeError(""))).toBe("");
    expect(textOf("plain")).toBe("plain");
    expect(textOf(42)).toBe("42");
    expect(textOf(undefined)).toBe("undefined");
    expect(textOf(null)).toBe("null");
    expect(textOf(Symbol("s"))).toBe("Symbol(s)");
    expect(textOf({ toString: () => "custom" })).toBe("custom");
  });

  test("a message that is not text is made text", () => {
    const error = new Error("replaced");
    Object.defineProperty(error, "message", {
      value: { toString: () => "obj" },
    });
    expect(textOf(error)).toBe("obj");
    Object.defineProperty(error, "message", { value: 7 });
    expect(textOf(error)).toBe("7");
  });

  test("total: nothing printable is the empty text, never a throw", () => {
    const throwing = {
      toString(): never {
        throw new Error("no");
      },
    };
    const error = new Error("replaced");
    Object.defineProperty(error, "message", {
      get(): never {
        throw new Error("no");
      },
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const value of [throwing, Object.create(null), error, revoked.proxy])
      expect(textOf(value)).toBe("");
  });
});

test.describe("failureLine", () => {
  test("one masked line, cut", () => {
    expect(failureLine(new Error(`bad\nkey ${TOKEN}`), 100)).toBe(
      "bad key ***",
    );
    expect(
      failureLine(new Error("storage pw no shape 42 refused"), 100, [
        "storage pw no shape 42",
      ]),
    ).toBe("*** refused");
    expect(failureLine("abcdef", 4)).toBe("abc…");
  });

  test("`failed` when it says nothing", () => {
    for (const value of [new Error(""), " \n ", Object.create(null)])
      expect(failureLine(value, 100)).toBe("failed");
  });
});

test.describe("shellWord", () => {
  test("leaves a plain path alone and single-quotes anything else", () => {
    expect(shellWord("/srv/e2e/.orchestrator/config.json")).toBe(
      "/srv/e2e/.orchestrator/config.json",
    );
    expect(shellWord("/srv/my e2e/config.json")).toBe(
      "'/srv/my e2e/config.json'",
    );
    expect(shellWord("/srv/it's/$HOME;x")).toBe("'/srv/it'\\''s/$HOME;x'");
  });

  test("gives back the path when a shell reads it", () => {
    for (const path of ["/a b/c", "/it's", "/$(x)`y`", "/a\\b", "/-x"])
      expect(
        execFileSync("/bin/sh", ["-c", `printf %s ${shellWord(path)}`], {
          encoding: "utf8",
        }),
      ).toBe(path);
  });
});

test.describe("the orchestrator's own source", () => {
  test("holds no invisible character: each is written as an escape, so a reader sees it", async () => {
    // Format characters and the non-characters U+FFFE and U+FFFF: none shows in an editor.
    const invisible = /[\p{Cf}\uFFFE\uFFFF]/u;
    const sources = (await readdir(import.meta.dirname, { recursive: true }))
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".spec.ts"))
      .filter((name) => !name.startsWith("__fixtures__"));
    expect(sources).toContain("text.ts");
    for (const name of sources) {
      const source = await readFile(join(import.meta.dirname, name), "utf8");
      expect(invisible.test(source), name).toBe(false);
    }
  });
});

test.describe("safeSiteUrl", () => {
  test("shows an http(s) URL as the suite does: credentials ***@, no query or fragment", () => {
    expect(safeSiteUrl("https://u:p@a.qa.test:8443/wp/?k=v#f", 200)).toBe(
      "https://***@a.qa.test:8443/wp/",
    );
    expect(safeSiteUrl("http://localhost:8100", 200)).toBe(
      "http://localhost:8100",
    );
  });

  test("anything but an http(s) URL is the stand-in, never its text", () => {
    for (const baseURL of [
      "not a url",
      "foo:admin:s3cr3tpw@host",
      "https://admin:hunter 22x@bad host/",
      "ftp://files.qa.test/",
    ])
      expect(safeSiteUrl(baseURL, 200), baseURL).toBe(
        "(not a valid http(s) URL)",
      );
  });

  test("masks by value before parsing, so encoding cannot hide a secret; cuts last", () => {
    expect(
      safeSiteUrl("https://a.qa.test/My Pass@word12/", 200, ["My Pass@word12"]),
    ).toBe("https://a.qa.test/***/");
    // A secret running from the path into the query: dropped half-way, only masked whole first.
    expect(
      safeSiteUrl("https://a.qa.test/Secret-Path-0001?k=v", 200, [
        "Secret-Path-0001?k=v",
      ]),
    ).toBe("https://a.qa.test/***");
    const long = safeSiteUrl(`https://a.qa.test/${"p".repeat(500)}`, 40);
    expect(Array.from(long)).toHaveLength(40);
    expect(long.startsWith("https://a.qa.test/ppp")).toBe(true);
  });
});
