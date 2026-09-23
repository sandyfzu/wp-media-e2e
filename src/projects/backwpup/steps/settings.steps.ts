import { Given } from "../fixtures";
import { setJobSetting } from "../support/settings";

/**
 * Steps for BackWPup's own settings, named as its Settings screen names them.
 *
 * A scenario that needs a site configured a particular way says so in the words a user would see,
 * and the value is refused unless the screen actually offers it — so a feature cannot set up a site
 * no real user could have.
 */

Given(
  "BackWPup's {string} setting is {string}",
  async ({ site }, label: string, value: string) => {
    await setJobSetting(site.transport, label, value);
  },
);
