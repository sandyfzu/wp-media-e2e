import { test, expect } from "@playwright/test";

import {
  escapeHtml,
  escapeRegExp,
  maskValues,
  plain,
  redactSecrets,
} from "./text";

/** A string escaped this way must match itself, literally, and nothing else. */
test.describe("escapeRegExp", () => {
  test("every metacharacter matches only itself", () => {
    const special = ".*+?^${}()|[]\\";
    const pattern = new RegExp(`^${escapeRegExp(special)}$`);
    expect(pattern.test(special)).toBe(true);
    expect(pattern.test("x".repeat(special.length))).toBe(false);
  });

  test("leaves ordinary text alone", () => {
    expect(escapeRegExp("pro@nginx_1-a")).toBe("pro@nginx_1-a");
  });
});

/** Escaped text renders as itself: no tag, entity or attribute end survives. */
test.describe("escapeHtml", () => {
  test("turns every HTML-significant character into its entity", () => {
    expect(escapeHtml(`<script>alert("x" & 'y')</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;",
    );
  });

  test("escapes an entity's own ampersand, so it shows as written", () => {
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });

  test("leaves other text, non-ASCII included, alone", () => {
    expect(escapeHtml("BackWPup Pro 9.99.99 · develop @ af1ab5c")).toBe(
      "BackWPup Pro 9.99.99 · develop @ af1ab5c",
    );
  });
});

/**
 * Every credential a log or report could quote is masked, and nothing else is touched. The shapes are
 * the ones measured: Playwright's navigation errors quote a URL's user and password verbatim, git
 * quotes a URL parameter verbatim (it hides only a URL's user and password itself), and a GitHub token
 * can be pasted anywhere.
 */
test.describe("redactSecrets", () => {
  test("masks a GitHub token in every issued prefix", () => {
    for (const token of [
      "ghp_16CharsOrMoreAAAA",
      "gho_16CharsOrMoreAAAA",
      "ghu_16CharsOrMoreAAAA",
      "ghs_16CharsOrMoreAAAA",
      "ghr_16CharsOrMoreAAAA",
      "github_pat_11ABCDEFG0aBcDeFgHiJkL",
    ]) {
      expect(redactSecrets(`bad credentials for ${token} here`)).toBe(
        "bad credentials for *** here",
      );
    }
  });

  test("masks a URL's user and password, or a lone token, keeping the scheme and host", () => {
    expect(
      redactSecrets(
        "fatal: unable to access 'https://x-access-token:SECRET@github.com/o/r.git/'",
      ),
    ).toBe("fatal: unable to access 'https://***@github.com/o/r.git/'");
    expect(
      redactSecrets(
        "page.goto: net::ERR_UNSAFE_PORT at http://admin:SECRET@127.0.0.1:9/wp-login.php",
      ),
    ).toBe(
      "page.goto: net::ERR_UNSAFE_PORT at http://***@127.0.0.1:9/wp-login.php",
    );
    expect(redactSecrets("ssh://TOKEN@host/x and HTTP://u:p@h")).toBe(
      "ssh://***@host/x and HTTP://***@h",
    );
  });

  test("masks a password holding a bare @ whole, to the authority's last @", () => {
    expect(redactSecrets("at https://user:p@ss@word@site.example/wp")).toBe(
      "at https://***@site.example/wp",
    );
  });

  test("stops at the authority: an @ in a path, query or the next word is not a credential", () => {
    for (const text of [
      "https://site.example/a@b",
      "https://site.example?mail=a@b",
      "https://site.example#a@b",
      "https://site.example and admin@site.example",
      "'https://site.example' <a@b>",
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });

  test("masks a credential URL parameter to its end, whatever its case or place", () => {
    expect(
      redactSecrets(
        "unable to access 'https://h/r.git?access_token=SECRET/': refused",
      ),
    ).toBe("unable to access 'https://h/r.git?access_token=***': refused");
    expect(
      redactSecrets(
        "https://h/x?a=1&Token=S1&password=S2#api_key=S3;apikey=S4",
      ),
    ).toBe("https://h/x?a=1&Token=***&password=***#api_key=***;apikey=***");
    // A parameter merely ending in a credential's name is not one.
    expect(redactSecrets("https://h/x?csrf_token_id=7&mytoken=8")).toBe(
      "https://h/x?csrf_token_id=7&mytoken=8",
    );
  });

  test("leaves text with no credential untouched", () => {
    for (const text of [
      "Cloning into 'backwpup-pro' from https://github.com/wp-media/backwpup-pro.git",
      "fatal: Authentication failed for 'https://github.com/wp-media/backwpup-pro.git/'",
      "git@github.com:wp-media/backwpup-pro.git",
      "ghp_short",
      "",
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });

  test("is idempotent: text masked twice on its way through is unchanged", () => {
    const once = redactSecrets(
      "https://x-access-token:ghp_16CharsOrMoreAAAA@github.com/o/r.git?token=abc",
    );
    expect(once).toBe("https://***@github.com/o/r.git?token=***");
    expect(redactSecrets(once)).toBe(once);
  });

  test("takes linear time, so a long error cannot stall a reporter", () => {
    // 400,000 characters of `a.`: a scheme tried from inside each dotted run would take tens of
    // seconds (measured: 0.4 s at 40,000, growing with the square).
    const started = performance.now();
    redactSecrets("a.".repeat(200_000));
    redactSecrets(`https://${"a".repeat(400_000)}`);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("masks every match, call after call: its shared patterns keep no state", () => {
    const text = "http://a:b@h1 http://c:d@h2";
    expect(redactSecrets(text)).toBe("http://***@h1 http://***@h2");
    expect(redactSecrets(text)).toBe("http://***@h1 http://***@h2");
  });
});

test.describe("plain", () => {
  test("one line: escape sequences gone, control characters and line separators a space", () => {
    expect(
      plain("\u001b[31mred\u001b[0m\nnext\ttab\u0085c1\u2028ls\u2029ps"),
    ).toBe("red next tab c1 ls ps");
  });

  test("drops the invisible format characters that make text display as something else", () => {
    // U+202E shows what follows right to left: "nightly‮gnp.exe" reads as "nightlyexe.png".
    expect(plain("nightly\u202egnp.exe")).toBe("nightlygnp.exe");
    expect(plain("zero\u200bwidth\ufeff")).toBe("zerowidth");
  });
});

test.describe("redactSecrets — headers, cookies and login forms", () => {
  test("masks an Authorization header's credential, a WordPress login cookie and a pwd parameter", () => {
    expect(redactSecrets("Authorization: Basic dXNlcjpwYXNz")).toBe(
      "Authorization: Basic ***",
    );
    expect(redactSecrets("authorization: Bearer v1.abc-DEF_9")).toBe(
      "authorization: Bearer ***",
    );
    expect(redactSecrets("Authorization: token 0123abcd0123abcd")).toBe(
      "Authorization: token ***",
    );
    expect(
      redactSecrets(
        "cookie wordpress_logged_in_0a1b2c=admin%7C1790000000%7Ctok%7Cmac; path=/",
      ),
    ).toBe("cookie wordpress_logged_in_0a1b2c=***; path=/");
    expect(redactSecrets("POST /wp-login.php?log=admin&pwd=hunter22")).toBe(
      "POST /wp-login.php?log=admin&pwd=***",
    );
  });
});

test.describe("maskValues", () => {
  test("masks each value wherever it appears; blank and short values are left alone", () => {
    expect(
      maskValues("a secret0123 and secret0123 again; short abc", [
        "secret0123",
        "abc",
        "",
        undefined,
        "   ",
      ]),
    ).toBe("a *** and *** again; short abc");
  });
});
