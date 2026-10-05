import { logName, loggedRun, readHistory } from "./history";
import { theScheduledJob } from "./job-options";
import {
  backupPathFromWorkingDir,
  markerPathFromLogFolder,
} from "./plugin-folders";
import {
  fillPlaceholders,
  parseCommandText,
  refusePathsOffTheSite,
} from "./cli-session";
import type { ArchiveSnapshot } from "./archive-snapshot";
import type { PlaceholderResolvers } from "./cli-session";
import type { ScenarioKeys } from "./encryption-keys";
import type { PrivateFolder } from "./private-folder";
import type { RunOrder } from "./history";
import type { Transport } from "../../../common/config/types";

/**
 * The placeholders a scenario may write into a `wp backwpup …` command, and where each one's value
 * comes from.
 *
 * Every value comes from a source the command under test has no hand in: the jobs the site stores,
 * the backup history the runs themselves wrote, the scenario's own record of the archives it made,
 * and the keys it drew. So `{oldest backup}` is the archive the scenario's first backup left,
 * whatever any listing command would say — which is what lets a scenario ask a command about one
 * file and then check, independently, what happened to that file.
 */

/** Where a scenario's placeholders are read from: its site, and what it has arranged there. */
export interface CommandScope {
  /** The scenario's site. */
  readonly transport: Transport;
  /** The scenario's private folder on the site. */
  readonly privateFolder: PrivateFolder;
  /** The archives the scenario's backups left, in the order they were made. */
  readonly archives: ArchiveSnapshot;
  /** The keys the scenario encrypts and decrypts with. */
  readonly keys: ScenarioKeys;
}

/** The log of the oldest or newest run that wrote one. */
async function logFileName(
  transport: Transport,
  order: RunOrder,
): Promise<string> {
  return logName(loggedRun(await readHistory(transport), order));
}

/**
 * The oldest or newest archive the scenario made, as a command run in WP-CLI's working directory
 * reaches it.
 */
async function backupPath(
  transport: Transport,
  archives: ArchiveSnapshot,
  order: RunOrder,
): Promise<string> {
  const job = await theScheduledJob(transport);
  return backupPathFromWorkingDir(transport, job.jobId, archives.named(order));
}

/**
 * The placeholders a command may use in this product's scenarios:
 *
 *  - `{job}` — the id of the site's one scheduled job;
 *  - `{oldest backup}`, `{newest backup}` — the archive the scenario's first or latest backup left,
 *    as the steps that made them recorded it;
 *  - `{path to the oldest backup}`, `{path to the newest backup}` — the same archive as a path from
 *    the directory WP-CLI runs in, which is how `backup-encrypt` and `backup-decrypt` take one;
 *  - `{oldest log}`, `{newest log}` — the log the first or the latest run the history records wrote;
 *  - `{private folder}` — the scenario's own folder on the site, relative to the directory WP-CLI
 *    runs in, as the site itself resolves both;
 *  - `{encryption key}`, `{another encryption key}` — two hex keys drawn for the scenario;
 *  - `{public key file}`, `{private key file}` — an RSA key pair drawn for it, its two halves
 *    placed in the private folder;
 *  - `{path from the log folder to the marker file}` — a path out of BackWPup's log folder to the
 *    file the `markers` fixture plants, proved on the site to lead there.
 *
 * @param scope - the scenario's site and what it has arranged there.
 */
export function commandPlaceholders(scope: CommandScope): PlaceholderResolvers {
  const { transport, privateFolder, archives, keys } = scope;
  return new Map([
    ["job", async () => String((await theScheduledJob(transport)).jobId)],
    ["oldest backup", () => Promise.resolve(archives.named("oldest"))],
    ["newest backup", () => Promise.resolve(archives.named("newest"))],
    [
      "path to the oldest backup",
      () => backupPath(transport, archives, "oldest"),
    ],
    [
      "path to the newest backup",
      () => backupPath(transport, archives, "newest"),
    ],
    ["oldest log", () => logFileName(transport, "oldest")],
    ["newest log", () => logFileName(transport, "newest")],
    ["private folder", () => privateFolder.relativePath()],
    ["encryption key", () => Promise.resolve(keys.hexKey("encryption key"))],
    [
      "another encryption key",
      () => Promise.resolve(keys.hexKey("another encryption key")),
    ],
    ["public key file", () => keys.publicKeyFile()],
    ["private key file", () => keys.privateKeyFile()],
    [
      "path from the log folder to the marker file",
      () => markerPathFromLogFolder(transport),
    ],
  ]);
}

/**
 * The command a scenario wrote, placeholders filled, as the argv to run — what every step that runs
 * a `wp backwpup …` command does with its text. The text as written may not name a path off the
 * site; the values its placeholders are filled with may, since the suite works each one out on the
 * site itself.
 *
 * @param text - the command as written in the feature, without `wp backwpup`.
 * @param scope - the scenario's site and what it has arranged there.
 * @throws {@link Error} if the text names a path off the site, a placeholder cannot be filled, or the
 * text is not a command `parseCommandText` accepts.
 */
export async function commandArgv(
  text: string,
  scope: CommandScope,
): Promise<readonly string[]> {
  refusePathsOffTheSite(text);
  return parseCommandText(
    await fillPlaceholders(text, commandPlaceholders(scope)),
  );
}
