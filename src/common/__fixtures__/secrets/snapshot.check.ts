import { test } from "@playwright/test";

/**
 * A scenario depending on `snapshot.setup.ts`: it fails with a field on the page, naming in its error
 * whether the failure snapshot was switched off in its worker. `secrets.run.spec.ts` reads its
 * `error-context.md`, which must carry the page snapshot.
 */

test("a scenario failing with a field on the page", async ({ page }) => {
  await page.setContent(
    '<label>Field<input value="scenariofieldvalue" /></label>',
  );
  throw new Error(
    `forced failure; snapshot switch: ${process.env.PLAYWRIGHT_NO_COPY_PROMPT ?? "unset"}`,
  );
});
