import { evalPhp, phpLiteral } from "./php";
import type { Transport } from "../config/types";

/**
 * Reading properties of files that live on the site.
 *
 * Asked through `wp eval` rather than a shell utility so the answer is the same on every transport
 * and does not depend on which of `sha256sum` / `shasum` a host happens to ship.
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
