import { randomBytes } from "node:crypto";
import { posix } from "node:path";

import { listFiles, pathFromWorkingDir } from "../../../common/wp/files";
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
 * A folder of the scenario's own on the site, for the files a `wp backwpup …` command writes or reads
 * there — a downloaded backup, an exported job, a file the scenario made, a key.
 *
 * **It is on the site, not the runner**, because that is where the commands run: inside WP-CLI there,
 * resolving a relative path against the directory WP-CLI runs in — the WordPress root, on every
 * transport this suite drives. So the folder is handed to a command as a path relative to that
 * directory, worked out on the site from where the folder and WP-CLI really are once every symlink is
 * resolved, and read back by its absolute path.
 *
 * **It is private to the transport's user**, because what lands in it can be a copy of a backup — the
 * site's whole database — an export naming that database, or a private key, and the staging area is
 * inside the docroot: the web server serves any file there it can read (measured on the cells: HTTP
 * 200). A folder only its owner may enter is one the web server cannot read from (HTTP 404), and its
 * name carries a random part, for a host where WP-CLI and the web server are one user. Nothing else
 * needs to read it: the commands that use it and the assertions that check it all run as the
 * transport's user, so it is created that way — `mkdir` with mode `0700`, the mode verified — and,
 * like everything else staged, keeps that user's ownership.
 *
 * It lives in this suite's own staging area, in a category of its own, and is removed once the
 * scenario is over. Only the scenario's own folder goes, never the category: a staging root declared
 * as an absolute path is shared by every site on the host that declares it.
 */

/** The staging-area category the scenarios' private folders live in. */
export const PRIVATE_CATEGORY = "private";

/**
 * What a file placed without content of its own holds, so "left as it was" is a comparison against a
 * known value rather than against a copy taken earlier.
 */
export const PLACED_FILE_CONTENT = "A file the scenario placed here.\n";

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
export function privateFolderKey(
  testInfo: Pick<TestInfo, "testId" | "retry">,
): string {
  const key = `${testInfo.testId}-r${String(testInfo.retry)}-${randomBytes(8).toString("hex")}`;
  if (!KEY.test(key)) {
    throw new Error(
      `[backwpup/private-folder] cannot name a folder after the test id "${testInfo.testId}": ` +
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
 * The path a command run in WP-CLI's working directory reaches the folder by, read from what
 * {@link createPrivatelyPhp} reported — once the folder is shown to have come out private.
 *
 * @param reply - what the snippet printed.
 * @param dir - the folder as this suite names it, for messages.
 * @throws {@link Error} if the reply is not JSON, the folder did not come out private, or the site
 * could not say where it or WP-CLI is.
 */
export function preparedFolderPath(reply: string, dir: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    throw new Error(
      `[backwpup/private-folder] preparing ${dir} did not come back as JSON: ${reply.slice(0, 300) || "(empty)"}`,
    );
  }
  const mode = isObject(parsed) ? parsed.mode : undefined;
  if (mode !== "700") {
    throw new Error(
      `[backwpup/private-folder] ${dir} came out with mode ${JSON.stringify(mode)}, not 700 — the ` +
        "mode that keeps what is written there to the transport's user alone.",
    );
  }
  return pathFromWorkingDir(parsed, dir);
}

/** One scenario's private folder — see the module comment. */
export class PrivateFolder {
  /** The site the folder is on. */
  private readonly transport: Transport;

  /** Its name inside the private category. */
  private readonly key: string;

  /** Whether it was handed out, and so may hold something to remove. */
  private used = false;

  /** The folder's creation, once asked for; the path a command reaches it by, once done. */
  private prepared: Promise<string> | undefined;

  /**
   * A folder by that name, not created yet — nothing happens on the site until a step uses it.
   *
   * @param transport - the site the folder is on.
   * @param key - its name inside the private category, from {@link privateFolderKey}.
   * @throws {@link Error} if the name holds anything but letters, digits and hyphens.
   */
  constructor(transport: Transport, key: string) {
    if (!KEY.test(key)) {
      throw new Error(
        `[backwpup/private-folder] "${key}" is not a usable folder name.`,
      );
    }
    this.transport = transport;
    this.key = key;
  }

  /** Where the folder is on the site, absolute — for reading back what a command wrote there. */
  async absolutePath(): Promise<string> {
    return stagingPath(
      await siteStagingDir(this.transport),
      PRIVATE_CATEGORY,
      this.key,
    );
  }

  /**
   * Where a file in the folder is on the site, absolute.
   *
   * @param name - the file's name; a single path segment.
   * @throws {@link Error} if the name is not a single segment.
   */
  async absolutePathTo(name: string): Promise<string> {
    return stagingPath(await this.absolutePath(), name);
  }

  /**
   * The folder as a command is given it: relative to the directory WP-CLI runs in — created first,
   * private to the transport's user, so nothing a command writes there is ever served.
   *
   * @throws {@link Error} if the folder could not be created, did not come out private, or could not
   * be located from where WP-CLI runs.
   */
  relativePath(): Promise<string> {
    return this.prepare();
  }

  /**
   * A file in the folder as a command is given it — see {@link PrivateFolder.relativePath}. The
   * folder is created, the file is not: a command may be about to write it.
   *
   * @param name - the file's name; a single path segment, checked before anything is created.
   * @throws {@link Error} if the name is not a single segment, or the folder could not be prepared.
   */
  async relativePathTo(name: string): Promise<string> {
    await this.absolutePathTo(name);
    return posix.join(await this.relativePath(), name);
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
   * Places a file in the folder, creating the folder first, and checks it reads back as written.
   *
   * @param name - the file's name; a single path segment, checked before anything is created.
   * @param content - what it holds; {@link PLACED_FILE_CONTENT} when the scenario only needs a file
   * it can recognise later.
   * @throws {@link Error} if the name is not a single segment, the folder could not be prepared, or
   * the file did not read back as written.
   */
  async place(name: string, content = PLACED_FILE_CONTENT): Promise<void> {
    const path = await this.absolutePathTo(name);
    await this.prepare();
    const php =
      `$path = ${phpLiteral(path)};\n` +
      `$content = ${phpLiteral(content)};\n` +
      "if ( false === file_put_contents( $path, $content ) ) {\n" +
      "\tWP_CLI::error( 'could not write ' . $path );\n" +
      "}\n" +
      "echo file_get_contents( $path ) === $content ? 'placed' : 'differs';";
    const reply = await evalPhp(
      this.transport,
      php,
      `placing ${name} in the private folder`,
      "backwpup/private-folder",
    );
    if (reply !== "placed") {
      throw new Error(
        `[backwpup/private-folder] ${name} did not read back as written (${JSON.stringify(reply)}).`,
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
      await cleanSiteStaging(this.transport, PRIVATE_CATEGORY, this.key);
    } catch (error) {
      console.warn(
        `[backwpup/private-folder] could not remove the scenario's private folder: ${errorMessage(error)}`,
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
      "preparing the private folder",
      "backwpup/private-folder",
    );
    return preparedFolderPath(reply, dir);
  }
}
