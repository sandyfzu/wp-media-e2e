import { evalPhp, phpLiteral } from "../../../common/wp/php";
import { backupArchivePhp } from "./plugin-folders";
import type { SiteFile } from "../../../common/wp/files";
import type { Transport } from "../../../common/config/types";

/**
 * What BackWPup's encryption leaves on an archive, read off the archive itself.
 *
 * `backup-encrypt` and `backup-decrypt` work **in place, under the same name**, so an archive's name
 * says nothing about whether it is encrypted — its first bytes do. BackWPup writes `BACKWPUP`, then
 * the format's version (2 for everything it writes now), then the kind of key it used
 * (`EncryptionStream::TYPE_SYMMETRIC` is 1, `TYPE_ASYMMETRIC` 2) — for a public key, then the AES key
 * wrapped with it — then the IV. A plain archive starts with a tar member's name, or gzip's or zip's
 * own magic — never with that.
 */

/** `BACKWPUP`, the eight bytes an encrypted archive starts with, as hex. */
const MAGIC = Buffer.from("BACKWPUP", "latin1").toString("hex");

/** How many bytes the header's fixed part takes: the magic, the version and the key type. */
export const HEADER_BYTES = 10;

/** The format version BackWPup writes into every archive it encrypts now. */
export const HEADER_VERSION = 2;

/** The type byte of each kind of key an archive can be encrypted with. */
export const KEY_KINDS = { "symmetric key": 1, "public key": 2 } as const;

/** One of the {@link KEY_KINDS}, in a scenario's words. */
export type KeyKind = keyof typeof KEY_KINDS;

/** The version and key type an encrypted archive's header declares. */
export interface EncryptionHeader {
  readonly version: number;
  readonly type: number;
}

/**
 * The header an archive's first bytes declare.
 *
 * @param hex - the bytes, as lower-case hex.
 * @returns the header, or `undefined` for bytes that do not begin one — an archive BackWPup has not
 * encrypted.
 * @throws {@link Error} if the reply is not hex: a notice printed ahead of it must never read as
 * "not encrypted".
 */
export function parseEncryptionHeader(
  hex: string,
): EncryptionHeader | undefined {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) {
    throw new Error(
      `[backwpup/encryption] expected an archive's first bytes as hex, got ${JSON.stringify(hex.slice(0, 200))}.`,
    );
  }
  if (!hex.startsWith(MAGIC) || hex.length < HEADER_BYTES * 2) {
    return undefined;
  }
  return {
    version: Number.parseInt(hex.slice(16, 18), 16),
    type: Number.parseInt(hex.slice(18, 20), 16),
  };
}

/**
 * The header of an archive in a job's backup folder, read on the site — only its first bytes travel.
 *
 * @param transport - the site holding the archive.
 * @param jobId - the job whose folder holds it.
 * @param name - the archive's filename.
 * @returns what {@link parseEncryptionHeader} makes of its first {@link HEADER_BYTES} bytes.
 * @throws {@link Error} if BackWPup is not loaded, the folder holds no such archive, it cannot be
 * opened, or the reply is not its bytes.
 */
export async function readEncryptionHeader(
  transport: Transport,
  jobId: number,
  name: string,
): Promise<EncryptionHeader | undefined> {
  const reply = await evalPhp(
    transport,
    backupArchivePhp(jobId, name) +
      "$handle = fopen( $path, 'rb' );\n" +
      "if ( false === $handle ) {\n" +
      "\tWP_CLI::error( 'could not open ' . $path );\n" +
      "}\n" +
      `$head = fread( $handle, ${phpLiteral(HEADER_BYTES)} );\n` +
      "fclose( $handle );\n" +
      "echo bin2hex( false === $head ? '' : $head );",
    `reading the header of ${name}`,
    "backwpup/encryption",
  );
  return parseEncryptionHeader(reply);
}

/** The temporary files the two commands write beside an archive: while encrypting, while decrypting. */
export const TEMPORARY_SUFFIXES = [".encrypted", ".decrypted"] as const;

/**
 * Which of the commands' temporary files a folder holds beside an archive — a command that completed
 * or refused cleanly leaves none.
 *
 * @param files - the folder's files.
 * @param archive - the archive's filename.
 */
export function temporaryFilesBeside(
  files: readonly SiteFile[],
  archive: string,
): readonly string[] {
  const temporary = new Set(
    TEMPORARY_SUFFIXES.map((suffix) => `${archive}${suffix}`),
  );
  return files.map((file) => file.name).filter((name) => temporary.has(name));
}
