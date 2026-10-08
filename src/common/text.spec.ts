import { test, expect } from "@playwright/test";

import { escapeRegExp } from "./text";

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
