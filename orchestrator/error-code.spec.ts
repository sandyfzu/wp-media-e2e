import { test, expect } from "@playwright/test";

import { errorCode } from "./error-code";

test.describe("errorCode", () => {
  test("gives a system error's code, and nothing for anything else", () => {
    expect(
      errorCode(Object.assign(new Error("kill ESRCH"), { code: "ESRCH" })),
    ).toBe("ESRCH");
    // Any object carrying a string code: what a callback API may hand over.
    expect(errorCode({ code: "ENOENT" })).toBe("ENOENT");
    expect(errorCode(new Error("plain"))).toBeUndefined();
    expect(errorCode({ code: 3 })).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
    expect(errorCode(undefined)).toBeUndefined();
    expect(errorCode("ESRCH")).toBeUndefined();
  });
});
