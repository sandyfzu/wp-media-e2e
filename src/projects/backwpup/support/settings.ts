import { evalPhp, phpLiteral } from "../../../common/wp/php";
import { getOption } from "../../../common/wp/options";
import type { Transport } from "../../../common/config/types";

/**
 * BackWPup's job settings (Settings → Jobs), named by the labels that screen gives them.
 *
 * Only the ones a scenario sets are here, each with the values the screen offers — read off its
 * markup (`parts/sidebar/settings-jobs.php`) and the handler that saves it
 * (`BackWPup_Page_Settings::save_post_form`), which stores each as a whole number in a site option
 * of its own. Writing that option is therefore exactly what saving the screen does for that one
 * field, without the handler's side effect of resetting the screen's other checkboxes.
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

/** The screen's own bound on "Maximum script execution time", in seconds. */
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
  "Maximum script execution time": {
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
