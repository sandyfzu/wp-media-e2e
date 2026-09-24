import { randomBytes } from "node:crypto";
import { posix } from "node:path";

import { listFiles } from "../../../common/wp/files";
import { evalPhp, phpLiteral } from "../../../common/wp/php";
import {
  cleanSiteStaging,
  siteStagingDir,
  stagingPath,
} from "../../../common/wp/staging";
import { errorMessage, isObject } from "../../../common/guards";
import type { TestInfo } from "@playwright/test";
import type { SiteFile } from "../../../common/wp/files";
import type { Transport } from "../../../common/config/types";

/**
 * A folder of the scenario's own on the site, for `wp backwpup backup-download` to write into.
 *
 * **It is on the site, not the runner**, because that is where the command writes: it runs inside
 * WP-CLI there, and resolves a relative destination against the directory WP-CLI runs in — the
 * WordPress root, on every transport this suite drives. So the folder is handed to a command as a
 * path relative to that directory, and read back by its absolute path. The relative path is worked
 * out on the site, from where the folder and WP-CLI really are once every symlink is resolved: a
 * path climbing out of a root reached through a symlink would otherwise climb out of its target,
 * and send the copy somewhere this folder is not.
 *
 * **It is private to the transport's user**, because what lands in it is a copy of a backup — the
 * site's whole database, for these scenarios — and the staging area is inside the docroot: the web
 * server serves any file there it can read (measured on the cells: HTTP 200). A folder only its owner
 * may enter is one the web server cannot read from (HTTP 404), and its name carries a random part,
 * for a host where WP-CLI and the web server are one user. Nothing else needs to read it: the
 * command that writes it and the assertions that check it both run as the transport's user, so it is
 * created that way — `mkdir` with mode `0700`, the mode verified — and, like everything else staged,
 * keeps that user's ownership.
 *
 * It lives in this suite's own staging area, in a category of its own, and is removed once the
 * scenario is over. Only the scenario's own folder goes, never the category: a staging root declared
 * as an absolute path is shared by every site on the host that declares it.
 */

/** The staging-area category downloads land in. */
export const DOWNLOADS_CATEGORY = "downloads";

/**
 * What a file a scenario places in the folder holds, so "left as it was" is a comparison against a
 * known value rather than against a copy taken earlier.
 */
export const PLACED_FILE_CONTENT =
  "A file the scenario placed here before downloading a backup.\n";

/** A folder name: the scenario's test id, its attempt and a random part, all of these characters. */
const KEY = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * The folder's name for one attempt at one scenario: its test id and retry number, so a leftover can
 * be traced back to the scenario that left it, then a random part, so the name cannot be guessed from
 * the repository the test id is derived from.
 *
 * @throws {@link Error} if the id holds anything but letters, digits and hyphens — the name ends up
 * on a command line split on whitespace, and in a path.
 */
export function downloadFolderKey(
  testInfo: Pick<TestInfo, "testId" | "retry">,
): string {
  const key = `${testInfo.testId}-r${String(testInfo.retry)}-${randomBytes(8).toString("hex")}`;
  if (!KEY.test(key)) {
    throw new Error(
      `[backwpup/download-folder] cannot name a folder after the test id "${testInfo.testId}": ` +
        "it holds characters a path or a command line would not carry.",
    );
  }
  return key;
}

/**
 * PHP that creates `dir` so that only its owner may enter it, then reports the mode it ended up with,
 * where it really is and where WP-CLI really runs. The parents are created as WordPress creates any
 * folder; only the folder itself is made private, by the mode it is created with — which a `umask`
 * can only narrow, and the reply shows.
 */
function createPrivatelyPhp(dir: string): string {
  return (
    `$dir = ${phpLiteral(dir)};\n` +
    "if ( ! wp_mkdir_p( dirname( $dir ) ) ) {\n" +
    "\tWP_CLI::error( 'could not create ' . dirname( $dir ) );\n" +
    "}\n" +
    "if ( ! is_dir( $dir ) && ! mkdir( $dir, 0700 ) ) {\n" +
    "\tWP_CLI::error( 'could not create ' . $dir );\n" +
    "}\n" +
    "clearstatcache( true, $dir );\n" +
    "echo wp_json_encode( [ 'mode' => decoct( fileperms( $dir ) & 0777 ), 'path' => realpath( $dir ), 'cwd' => getcwd() ] );"
  );
}

/**
 * The path a command run in WP-CLI's working directory must be given to reach the folder, from what
 * {@link createPrivatelyPhp} reported.
 *
 * Both ends are the site's own answers with every symlink resolved — `realpath()` and `getcwd()` — so
 * each step of the path, up or down, is a real directory, and it leads where it says from the
 * directory every command of the scenario runs in.
 *
 * @param reply - what the snippet printed.
 * @param dir - the folder as this suite names it, for messages.
 * @throws {@link Error} if the folder did not come out private, or the site could not say where it
 * or WP-CLI is.
 */
export function pathFromWorkingDir(reply: string, dir: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    throw new Error(
      `[backwpup/download-folder] preparing ${dir} did not come back as JSON: ${reply.slice(0, 300) || "(empty)"}`,
    );
  }
  const { mode, path, cwd } = isObject(parsed) ? parsed : {};
  if (mode !== "700") {
    throw new Error(
      `[backwpup/download-folder] ${dir} came out with mode ${JSON.stringify(mode)}, not 700 — the ` +
        "mode that keeps a copy of a backup written there to the transport's user alone.",
    );
  }
  if (
    typeof path !== "string" ||
    !posix.isAbsolute(path) ||
    typeof cwd !== "string" ||
    !posix.isAbsolute(cwd)
  ) {
    throw new Error(
      `[backwpup/download-folder] the site could not say where ${dir} is from the directory WP-CLI ` +
        `runs in: ${reply.slice(0, 300)}`,
    );
  }
  return posix.relative(cwd, path);
}

/** One scenario's download folder — see the module comment. */
export class DownloadFolder {
  /** The site the folder is on. */
  private readonly transport: Transport;

  /** Its name inside the downloads category. */
  private readonly key: string;

  /** Whether it was handed out, and so may hold something to remove. */
  private used = false;

  /** The folder's creation, once asked for; the path a command reaches it by, once done. */
  private prepared: Promise<string> | undefined;

  /**
   * A folder by that name, not created yet — nothing happens on the site until a step uses it.
   *
   * @param transport - the site the folder is on.
   * @param key - its name inside the downloads category, from {@link downloadFolderKey}.
   * @throws {@link Error} if the name holds anything but letters, digits and hyphens.
   */
  constructor(transport: Transport, key: string) {
    if (!KEY.test(key)) {
      throw new Error(
        `[backwpup/download-folder] "${key}" is not a usable folder name.`,
      );
    }
    this.transport = transport;
    this.key = key;
  }

  /** Where the folder is on the site, absolute — for reading back what a command wrote there. */
  async absolutePath(): Promise<string> {
    return stagingPath(
      await siteStagingDir(this.transport),
      DOWNLOADS_CATEGORY,
      this.key,
    );
  }

  /**
   * The folder as a command is given it: relative to the directory WP-CLI runs in — created first,
   * private to the transport's user, so the copy a command writes there is never served.
   *
   * @throws {@link Error} if the folder could not be created, did not come out private, or could not
   * be located from where WP-CLI runs.
   */
  relativePath(): Promise<string> {
    return this.prepare();
  }

  /**
   * What the folder holds, with digests — nothing at all while it does not exist.
   *
   * @throws {@link Error} if the folder exists but cannot be read.
   */
  async list(): Promise<readonly SiteFile[]> {
    return listFiles(this.transport, await this.absolutePath(), {
      digests: true,
      missingAsEmpty: true,
    });
  }

  /**
   * Places a file holding {@link PLACED_FILE_CONTENT} in the folder, creating the folder first.
   *
   * @param name - the file's name; a single path segment, checked before anything is created.
   * @throws {@link Error} if the name is not a single segment, the folder could not be prepared, or
   * the file did not read back as written.
   */
  async place(name: string): Promise<void> {
    const path = stagingPath(await this.absolutePath(), name);
    await this.prepare();
    const php =
      `$path = ${phpLiteral(path)};\n` +
      `$content = ${phpLiteral(PLACED_FILE_CONTENT)};\n` +
      "if ( false === file_put_contents( $path, $content ) ) {\n" +
      "\tWP_CLI::error( 'could not write ' . $path );\n" +
      "}\n" +
      "echo file_get_contents( $path ) === $content ? 'placed' : 'differs';";
    const reply = await evalPhp(
      this.transport,
      php,
      `placing ${name} in the download folder`,
      "backwpup/download-folder",
    );
    if (reply !== "placed") {
      throw new Error(
        `[backwpup/download-folder] ${name} did not read back as written (${JSON.stringify(reply)}).`,
      );
    }
  }

  /**
   * Removes the folder if this scenario used it — its own folder only, since the category may hold
   * another run's. Teardown, so it never throws: a failure is reported, and the worker's own
   * teardown removes the whole staging area anyway.
   */
  async release(): Promise<void> {
    if (!this.used) return;
    try {
      await cleanSiteStaging(this.transport, DOWNLOADS_CATEGORY, this.key);
    } catch (error) {
      console.warn(
        `[backwpup/download-folder] could not remove the scenario's downloads: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Creates the folder the first time it is needed, private to the transport's user — every later
   * call reuses that. Marks it used before anything is created, so even a creation that failed
   * half-way is cleaned up.
   */
  private prepare(): Promise<string> {
    this.used = true;
    this.prepared ??= this.createPrivately();
    return this.prepared;
  }

  /** Creates the folder with mode `0700`, and returns the path a command reaches it by. */
  private async createPrivately(): Promise<string> {
    const dir = await this.absolutePath();
    const reply = await evalPhp(
      this.transport,
      createPrivatelyPhp(dir),
      "preparing the download folder",
      "backwpup/download-folder",
    );
    return pathFromWorkingDir(reply, dir);
  }
}
