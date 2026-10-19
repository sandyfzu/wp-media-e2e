/**
 * The names of the attachments the setup projects leave on their results, which the reporters read
 * back (`reporting/setup-facts.ts`). Here, free of imports, so a reporter can read them without
 * loading a setup's own modules — page objects among them, which import `@playwright/test`.
 */

/** The artifacts setup's summary of the plugin zips it resolved and verified (`artifacts.setup.ts`). */
export const ARTIFACTS_ATTACHMENT = "artifacts-resolution.json";

/** The auth setup's record of each site's versions (`setup/site-info.ts`). */
export const SITE_INFO_ATTACHMENT = "site-info.json";
