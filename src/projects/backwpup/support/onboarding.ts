import { getOption } from "../../../common/wp/options";
import type { Transport } from "../../../common/config/types";

/**
 * BackWPup's onboarding state, read from the site rather than inferred from the browser.
 *
 * The plugin gates the whole admin on one site option. While it is set, *every* `page=backwpup*`
 * request except the about, onboarding, first-backup and support screens is redirected to the
 * onboarding page, and completing onboarding deletes it. So this option — not a URL, not a heading —
 * is what
 * "has this site been onboarded?" actually means.
 *
 * **It is written lazily, and that matters.** A fresh install does not set it during the install
 * command: the plugin schedules its own upgrade routine on `init`, so the flag appears on the first
 * WordPress request that loads the activated plugin. The same request then redirects (`admin_init`
 * runs after `init`), which is why a scenario should observe the redirect first and read this
 * afterwards — reading it straight after a WP-CLI install would be a race against the product's own
 * bootstrap.
 *
 * The read and the judgement are separate so a caller can report the raw value it saw: "expected
 * true, received false" is a poor way to describe a missing option row.
 */

/**
 * The site option that keeps a site inside onboarding.
 *
 * A *site* option, which on single-site WordPress is an ordinary option row; every site this suite
 * drives is single-site.
 */
export const ONBOARDING_OPTION = "backwpup_onboarding";

/**
 * The raw value of {@link ONBOARDING_OPTION}, or `undefined` when the row does not exist.
 *
 * @param transport - the site to ask.
 * @throws {@link Error} if the option cannot be read at all — a site that cannot answer is not the
 * same as a site that has been onboarded.
 */
export function readOnboardingFlag(
  transport: Transport,
): Promise<string | undefined> {
  return getOption(transport, ONBOARDING_OPTION);
}

/**
 * Whether a raw {@link ONBOARDING_OPTION} value means "onboarding is still owed".
 *
 * The plugin writes a boolean `true`, which WordPress stores — and WP-CLI prints — as `1`, and
 * deletes the row rather than falsifying it when onboarding completes. Any falsy value is treated
 * as "not pending", the way WordPress itself would read it.
 */
export function isOnboardingPending(value: string | undefined): boolean {
  if (value === undefined) return false;
  const trimmed = value.trim();
  return trimmed !== "" && trimmed !== "0";
}
