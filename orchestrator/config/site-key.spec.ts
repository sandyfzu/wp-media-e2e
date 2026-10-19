import { expect, test } from "@playwright/test";

import { siteKey } from "./site-key";

test.describe("siteKey", () => {
  test("refuses credentials with an @ in the path: a password holding / or @ unescaped, split by the parser", () => {
    for (const baseURL of [
      "https://qa:S3c@ret.example/Pw-tail@qa-lnmp.example/",
      "https://admin:p@ss/word@host/",
      "https://user@host.test/a@b",
    ])
      expect(() => siteKey(baseURL), baseURL).toThrow(
        /no @ past its host: percent-encode/,
      );
  });

  test("keys an @ in a path without credentials", () => {
    expect(siteKey("https://host.test/team@site/")).toBe("host.test/team@site");
  });

  test("keys a password escaped as it must be, without it", () => {
    expect(siteKey("https://admin:p%40ss%2Fword@Host.test/wp/")).toBe(
      "host.test/wp",
    );
  });

  test("refuses anything but an http(s) URL", () => {
    for (const baseURL of ["not a url", "ftp://host.test/", ""])
      expect(() => siteKey(baseURL), baseURL).toThrow(
        /must be an http\(s\) URL/,
      );
  });
});
