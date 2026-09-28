import { evalPhp, phpLiteral } from "../../../common/wp/php";
import { getOption } from "../../../common/wp/options";
import type { Transport } from "../../../common/config/types";

/**
 * BackWPup's settings, stored as its own screens store them: the job settings (Advanced Settings →
 * Jobs), named by the labels that screen gives them, and the Pro Encryption panel's key.
 *
 * Only the ones a scenario sets are here, each labelled and valued as the screen offers it — read off
 * its markup (`parts/sidebar/settings-jobs.php`, the settings panel of the dashboard, whose wording
 * is kept as it is) and the handler that saves it (`BackWPup_Page_Settings::save_post_form`), which
 * stores each as a whole number in a site option of its own. Writing that option is therefore
 * exactly what saving the screen does for that one field, without the handler's side effect of
 * resetting the screen's other checkboxes.
 */

/** One setting: the site option it lives in, and how a scenario's word becomes its stored value. */
interface JobSetting {
  readonly option: string;
  /** The stored value for a word, or `undefined` when the screen offers no such value. */
  readonly valueOf: (word: string) => number | undefined;
  /** What the screen accepts, for a refusal's message. */
  readonly accepts: string;
}

/** "Reduce server load": a pause, in microseconds, the job takes each time it updates its progress. */
const SERVER_LOAD: Readonly<Record<string, number>> = {
  disabled: 0,
  minimum: 10_000,
  medium: 30_000,
  maximum: 90_000,
};

/** The bound the settings handler keeps the maximum script execution time within, in seconds. */
const MAX_EXECUTION_SECONDS = 300;

/** The settings a scenario can name, by label. */
const JOB_SETTINGS: Readonly<Record<string, JobSetting>> = {
  "Reduce server load": {
    option: "backwpup_cfg_jobwaittimems",
    valueOf: (word) => SERVER_LOAD[word],
    accepts: Object.keys(SERVER_LOAD).join(", "),
  },
  // How long one request may run a job before handing it over to a fresh one. `0` means no maximum:
  // the whole run then stays in a single request.
  "Maximum number script execution time (in seconds)": {
    option: "backwpup_cfg_jobmaxexecutiontime",
    valueOf: (word) =>
      /^\d+$/.test(word) && Number(word) <= MAX_EXECUTION_SECONDS
        ? Number(word)
        : undefined,
    accepts: `a whole number of seconds from 0 to ${String(MAX_EXECUTION_SECONDS)}`,
  },
};

/**
 * The option and value saving a setting on the screen would store.
 *
 * @param label - the setting's label, e.g. `Reduce server load`.
 * @param word - the value as the screen shows it, e.g. `maximum` or `0`.
 * @throws {@link Error} if the screen has no such setting, or does not offer that value.
 */
export function jobSettingValue(
  label: string,
  word: string,
): { readonly option: string; readonly value: number } {
  const setting = JOB_SETTINGS[label];
  if (setting === undefined) {
    throw new Error(
      `[backwpup/settings] no job setting is labelled "${label}". Known: ${Object.keys(JOB_SETTINGS).join(", ")}.`,
    );
  }
  const value = setting.valueOf(word);
  if (value === undefined) {
    throw new Error(
      `[backwpup/settings] "${label}" cannot be "${word}" — the screen accepts ${setting.accepts}.`,
    );
  }
  return { option: setting.option, value };
}

/**
 * Sets one job setting as the Settings screen saves it, and confirms the site kept it.
 *
 * Read back through a second request, since the one that wrote it answers from its own cache. The
 * option goes with the plugin's own uninstall, like every other `backwpup_cfg_*` row.
 *
 * @param transport - the site to configure.
 * @param label - the setting's label, e.g. `Reduce server load`.
 * @param word - the value as the screen shows it, e.g. `maximum`.
 * @throws {@link Error} if the setting or value is unknown, if PHP failed, or if the site does not
 * hold the value afterwards.
 */
export async function setJobSetting(
  transport: Transport,
  label: string,
  word: string,
): Promise<void> {
  const { option, value } = jobSettingValue(label, word);
  await evalPhp(
    transport,
    `update_site_option( ${phpLiteral(option)}, ${phpLiteral(value)} );`,
    `saving BackWPup's "${label}" setting`,
    "backwpup/settings",
  );
  const stored = await getOption(transport, option);
  if (stored?.trim() !== String(value)) {
    throw new Error(
      `[backwpup/settings] "${label}" should now be stored as ${String(value)} in ${option}, ` +
        `but the site holds ${JSON.stringify(stored)}.`,
    );
  }
}

// ── Encryption (Pro) ─────────────────────────────────────────────────────────

/** The Encryption panel's site options, as `EncryptionSettingUpdater` names them (BackWPup Pro). */
export const ENCRYPTION_OPTIONS = {
  type: "backwpup_cfg_encryption",
  key: "backwpup_cfg_encryptionkey",
  archiveEncryption: "backwpup_archiveencryption",
} as const;

/** A key as the Encryption panel generates one: 64 hex characters, AES-256. */
const PANEL_KEY = /^[0-9a-f]{64}$/;

/**
 * Saves an encryption key in BackWPup's settings, as saving the Encryption panel does with a
 * symmetric key given and the jobs' own archive encryption left off.
 *
 * The panel's handler (`EncryptionSettingUpdater::update()`) stores three site options: the type,
 * `backwpup_archiveencryption` — whether every job encrypts its own archives — and the key, hex, cut
 * to 64 characters. Archive encryption is stored **off**: on, each job would encrypt what it makes
 * with this key, so a scenario's backup would arrive encrypted already — and foreground runs have
 * been measured dying of a memory limit the job sets itself while it is on. All three are read back
 * by a second request, since the one that wrote them answers from its own cache; the key is compared
 * on the site, and no message ever quotes it. They go with the plugin's footprint.
 *
 * @param transport - the site to configure. BackWPup Pro must be installed and past activation.
 * @param key - the key to save: 64 lower-case hex characters.
 * @throws {@link Error} if the key is not one the panel would save as it is, if PHP failed, or if
 * the site does not hold all three afterwards.
 */
export async function saveEncryptionKey(
  transport: Transport,
  key: string,
): Promise<void> {
  if (!PANEL_KEY.test(key)) {
    throw new Error(
      "[backwpup/settings] an encryption key is 64 lower-case hex characters, as the Encryption " +
        "panel generates one — the key given is not.",
    );
  }
  await evalPhp(
    transport,
    `update_site_option( ${phpLiteral(ENCRYPTION_OPTIONS.type)}, 'symmetric' );\n` +
      `update_site_option( ${phpLiteral(ENCRYPTION_OPTIONS.archiveEncryption)}, false );\n` +
      `update_site_option( ${phpLiteral(ENCRYPTION_OPTIONS.key)}, ${phpLiteral(key)} );`,
    "saving an encryption key in BackWPup's settings",
    "backwpup/settings",
  );
  const reply = await evalPhp(
    transport,
    `echo wp_json_encode( [\n` +
      `\t'type' => get_site_option( ${phpLiteral(ENCRYPTION_OPTIONS.type)} ),\n` +
      `\t'archive_encryption' => (bool) get_site_option( ${phpLiteral(ENCRYPTION_OPTIONS.archiveEncryption)} ),\n` +
      `\t'key' => hash_equals( ${phpLiteral(key)}, (string) get_site_option( ${phpLiteral(ENCRYPTION_OPTIONS.key)} ) ),\n` +
      "] );",
    "reading BackWPup's encryption settings back",
    "backwpup/settings",
  );
  expectSavedKey(reply);
}

/**
 * Checks what the read-back reported: the type symmetric, archive encryption off, the key the one
 * saved.
 *
 * @throws {@link Error} naming what the site does not hold, without the key.
 */
function expectSavedKey(reply: string): void {
  let saved: unknown;
  try {
    saved = JSON.parse(reply);
  } catch {
    throw new Error(
      `[backwpup/settings] reading the encryption settings back did not come back as JSON: ${reply.slice(0, 300) || "(empty)"}`,
    );
  }
  const expected = { type: "symmetric", archive_encryption: false, key: true };
  if (JSON.stringify(saved) !== JSON.stringify(expected)) {
    throw new Error(
      "[backwpup/settings] the site should now hold a symmetric encryption type, archive encryption " +
        `off and the key saved (key matching: true), but it holds ${JSON.stringify(saved)}.`,
    );
  }
}
