import { evalPhp, phpLiteral } from "./php";
import { isObject } from "../guards";
import type { Transport } from "../config/types";

/**
 * Reading properties of files that live on the site — and setting the one a scenario may need to
 * arrange, a file's age.
 *
 * Asked through `wp eval` rather than a shell utility so the answer is the same on every transport
 * and does not depend on which of `sha256sum` / `shasum`, or which `stat` or `touch` dialect, a host
 * happens to ship.
 */

/** A lower-case hex SHA-256, which is the only shape a successful read may produce. */
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The SHA-256 of a file on the site, as lower-case hex.
 *
 * This is the honest way to prove a file that travelled — a download, an upload — arrived intact.
 * Size is the tempting substitute and is strictly weaker: a truncated transfer that happens to be
 * padded, or a body corrupted in place, matches on size and differs here.
 *
 * The digest is computed **on the site**, so nothing large has to move to answer the question.
 *
 * @param transport - the site holding the file.
 * @param path - absolute path to the file on that site.
 * @returns the digest, lower-case hex.
 * @throws {@link Error} if the file is missing or unreadable, or if the reply is not a digest —
 * a notice printed ahead of the value would otherwise be compared as though it were one.
 *
 * @example
 * ```ts
 * const onSite = await fileChecksum(site.transport, archive.path);
 * ```
 */
export async function fileChecksum(
  transport: Transport,
  path: string,
): Promise<string> {
  const php =
    `$path = ${phpLiteral(path)};\n` +
    "if ( ! is_file( $path ) || ! is_readable( $path ) ) {\n" +
    "\tWP_CLI::error( 'no readable file at ' . $path );\n" +
    "}\n" +
    "echo hash_file( 'sha256', $path );";
  const digest = await evalPhp(
    transport,
    php,
    `checksumming "${path}"`,
    "wp/files",
  );
  if (!SHA256.test(digest)) {
    throw new Error(
      `[wp/files] expected a SHA-256 for "${path}", got ${JSON.stringify(digest)}.`,
    );
  }
  return digest;
}

/** One regular file in a site directory, as {@link listFiles} reads it. */
export interface SiteFile {
  /** Its name within the directory. */
  readonly name: string;
  /** Its size in bytes. */
  readonly size: number;
  /** When it was last written, as a Unix timestamp — by the site's clock. */
  readonly modifiedAt: number;
  /**
   * Whether the **transport's** user may write it: what PHP's `is_writable()` answers inside WP-CLI,
   * which is the check a plugin's own command makes before it deletes a file.
   */
  readonly writable: boolean;
  /** Its SHA-256 as lower-case hex, when digests were asked for. */
  readonly sha256?: string;
}

/**
 * PHP that lists the regular files directly inside `$dir` into `$files` — the fragment
 * {@link listLocatedFiles} runs once `$dir` is located. Expects `$dir` (an absolute path) and
 * `$digests` (whether to hash each file) to be set already.
 *
 * A directory that is not there is an error rather than an empty list: every caller asks because it
 * expects the directory to exist, and "no files" is exactly the answer that would pass an assertion
 * that something was removed — for a path that was simply wrong. Links and subdirectories are left
 * out, so only files the directory itself holds are counted.
 */
export const FILE_LIST_PHP = `
clearstatcache();
if ( ! is_dir( $dir ) ) {
	WP_CLI::error( 'no directory at ' . $dir );
}
$names = scandir( $dir );
if ( false === $names ) {
	WP_CLI::error( 'could not read the directory ' . $dir );
}
$files = [];
foreach ( $names as $name ) {
	$path = rtrim( $dir, '/' ) . '/' . $name;
	if ( ! is_file( $path ) || is_link( $path ) ) {
		continue;
	}
	$entry = [ 'name' => $name, 'size' => filesize( $path ), 'modified' => filemtime( $path ), 'writable' => is_writable( $path ) ];
	if ( $digests ) {
		$entry['sha256'] = hash_file( 'sha256', $path );
	}
	$files[] = $entry;
}
`;

/** The message for an entry holding something its field cannot. */
function unexpectedEntry(entry: unknown, field: string, wanted: string): Error {
  return new Error(
    `[wp/files] expected "${field}" to be ${wanted} in the file entry ${JSON.stringify(entry)}.`,
  );
}

/** A count of bytes or seconds: a whole number, never negative. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Maps one entry, refusing a shape the snippet does not produce rather than guessing at it. */
function toSiteFile(entry: unknown, digests: boolean): SiteFile {
  if (!isObject(entry)) throw unexpectedEntry(entry, "entry", "an object");
  const { name, size, modified, writable, sha256 } = entry;
  if (typeof name !== "string" || name === "") {
    throw unexpectedEntry(entry, "name", "a filename");
  }
  // `filesize()` and `filemtime()` answer `false` for a file they could not stat.
  if (!isCount(size)) throw unexpectedEntry(entry, "size", "a byte count");
  if (!isCount(modified)) {
    throw unexpectedEntry(entry, "modified", "a timestamp");
  }
  if (typeof writable !== "boolean") {
    throw unexpectedEntry(entry, "writable", "true or false");
  }
  if (!digests) return { name, size, modifiedAt: modified, writable };
  // `hash_file()` answers `false` for a file it could not read.
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) {
    throw unexpectedEntry(entry, "sha256", "a SHA-256");
  }
  return { name, size, modifiedAt: modified, writable, sha256 };
}

/**
 * Maps the `$files` {@link FILE_LIST_PHP} built, once decoded from JSON.
 *
 * @param value - the decoded `$files`.
 * @param digests - whether they were asked for; every entry must then carry one.
 * @throws {@link Error} if the value is not a list of entries shaped like the snippet's — a reply
 * that cannot be read must never pass as a directory with nothing in it.
 */
export function parseFileList(
  value: unknown,
  digests: boolean,
): readonly SiteFile[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `[wp/files] expected a list of files, got ${JSON.stringify(value)}.`,
    );
  }
  return value.map((entry: unknown) => toSiteFile(entry, digests));
}

/** How {@link listFiles} and {@link listLocatedFiles} read a directory. */
export interface ListFilesOptions {
  /** Hash every file too, on the site. */
  readonly digests?: boolean;
  /**
   * Read a directory that is not there as holding nothing, instead of refusing it — only for one a
   * scenario may never have created, where "nothing" is the true answer.
   */
  readonly missingAsEmpty?: boolean;
}

/** A directory's files, and where the site says the directory is. */
export interface SiteDirectory {
  /** Its absolute path on the site, without a trailing slash. */
  readonly dir: string;
  /** The regular files directly inside it, in name order. */
  readonly files: readonly SiteFile[];
}

/** Reads what the listing snippet printed, refusing anything but a directory and its files. */
function parseListing(
  reply: string,
  digests: boolean,
  what: string,
): SiteDirectory {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    throw new Error(
      `[wp/files] listing ${what} did not come back as JSON: ${reply.slice(0, 300) || "(empty)"}`,
    );
  }
  if (
    !isObject(parsed) ||
    typeof parsed.dir !== "string" ||
    parsed.dir === ""
  ) {
    throw new Error(
      `[wp/files] listing ${what} came back as ${reply.slice(0, 300)}, not a directory and its files.`,
    );
  }
  return {
    dir: parsed.dir.replace(/(?!^)\/+$/, ""),
    files: parseFileList(parsed.files, digests),
  };
}

/**
 * The regular files directly inside a directory only the site can name — one a plugin's settings
 * decide, say — each one's size, modification time, whether the transport's user may write it and,
 * when asked, its SHA-256. Located and listed in one request, so the answer is about one moment.
 *
 * Read by the site's own PHP, so it is the site's view of the directory, and hashing happens there:
 * proving a large file is unchanged costs one small reply, not a transfer.
 *
 * @param transport - the site holding the directory.
 * @param locate - PHP that sets `$dir` to the directory's absolute path, or stops with
 * `WP_CLI::error` when it cannot.
 * @param what - the directory in words, for messages — e.g. `the log folder`.
 * @param options - see {@link ListFilesOptions}.
 * @returns the directory as the site located it, and its files in name order.
 * @throws {@link Error} if the snippet stopped, the directory is not there (unless `missingAsEmpty`)
 * or cannot be read, or the reply is not a directory and its files.
 */
export async function listLocatedFiles(
  transport: Transport,
  locate: string,
  what: string,
  options: ListFilesOptions = {},
): Promise<SiteDirectory> {
  const digests = options.digests === true;
  const list =
    options.missingAsEmpty === true
      ? `clearstatcache();\n$files = [];\nif ( is_dir( $dir ) ) {\n${FILE_LIST_PHP}}\n`
      : FILE_LIST_PHP;
  const reply = await evalPhp(
    transport,
    `${locate}$digests = ${phpLiteral(digests)};\n${list}` +
      "echo wp_json_encode( [ 'dir' => $dir, 'files' => $files ] );",
    `listing ${what}`,
    "wp/files",
  );
  return parseListing(reply, digests, what);
}

/**
 * The regular files directly inside a directory on the site — see {@link listLocatedFiles}, for a
 * directory whose path is already known.
 *
 * @param transport - the site holding the directory.
 * @param dir - its absolute path on that site.
 * @param options - see {@link ListFilesOptions}.
 * @returns the files, in name order.
 * @throws {@link Error} if the directory is not there (unless `missingAsEmpty`) or cannot be read, or
 * if the reply is not a list of files.
 */
export async function listFiles(
  transport: Transport,
  dir: string,
  options: ListFilesOptions = {},
): Promise<readonly SiteFile[]> {
  const listed = await listLocatedFiles(
    transport,
    `$dir = ${phpLiteral(dir)};\n`,
    `"${dir}"`,
    options,
  );
  return listed.files;
}

/**
 * Makes a file look older than it is, by setting its modification time back — for a scenario about
 * something that judges files by age.
 *
 * Measured from the **site's** clock, which is the one such a judgement uses, so a runner whose
 * clock disagrees cannot shift which side of a cut-off the file lands on. Only the file's owner may
 * set its time, so this works on a file the transport's user wrote and is refused on one the web
 * server did.
 *
 * @param transport - the site holding the file.
 * @param path - its absolute path on that site.
 * @param seconds - how far back to set it; a positive whole number.
 * @returns the timestamp it now carries.
 * @throws {@link Error} if `seconds` is not a positive whole number, if the file is missing, if its
 * time could not be set, or if it did not read back as set.
 */
export async function backdateFile(
  transport: Transport,
  path: string,
  seconds: number,
): Promise<number> {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(
      `[wp/files] cannot backdate "${path}" by ${String(seconds)} s: give a positive whole number.`,
    );
  }
  const php =
    `$path = ${phpLiteral(path)};\n` +
    `$time = time() - ${phpLiteral(seconds)};\n` +
    "if ( ! is_file( $path ) ) {\n" +
    "\tWP_CLI::error( 'no file at ' . $path );\n" +
    "}\n" +
    "if ( ! @touch( $path, $time ) ) {\n" +
    "\t$reason = error_get_last();\n" +
    "\tWP_CLI::error( 'could not set the modification time of ' . $path . ' (only its owner may): ' . ( $reason['message'] ?? 'no reason given' ) );\n" +
    "}\n" +
    "clearstatcache( true, $path );\n" +
    "if ( filemtime( $path ) !== $time ) {\n" +
    "\tWP_CLI::error( 'the modification time of ' . $path . ' did not read back as set' );\n" +
    "}\n" +
    "echo $time;";
  const reply = await evalPhp(
    transport,
    php,
    `backdating "${path}"`,
    "wp/files",
  );
  const time = Number(reply);
  if (reply === "" || !Number.isInteger(time)) {
    throw new Error(
      `[wp/files] expected the timestamp "${path}" now carries, got ${JSON.stringify(reply)}.`,
    );
  }
  return time;
}
