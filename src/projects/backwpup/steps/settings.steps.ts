import { Given } from "../fixtures";
import { saveEncryptionKey, setJobSetting } from "../support/settings";

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

/**
 * An encryption key saved in BackWPup's settings, as the Pro Encryption panel saves a symmetric key
 * — the scenario's own `{encryption key}`, so a command run without `--key` uses exactly that one.
 * The jobs' own archive encryption stays off, so the backups a scenario makes are not encrypted by
 * the job before a command is asked to.
 */
Given(
  "BackWPup's encryption key is saved in its settings",
  async ({ site, keys }) => {
    await saveEncryptionKey(site.transport, keys.hexKey("encryption key"));
  },
);
