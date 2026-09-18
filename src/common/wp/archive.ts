import { exec } from "./exec";
import type { Transport } from "../config/types";

/**
 * Looking inside a tar archive that lives **on the site**, without moving it.
 *
 * A product that produces archives has to be asked what it actually put in one — a file that exists
 * and is the right size still proves nothing about its contents. Downloading it to find out is not
 * an option in general: a real site's archive runs to gigabytes, and a scenario that transfers one
 * per assertion would spend its whole budget on the wire.
 *
 * So the questions are asked in place, through `tar`. That scopes this to tar archives: a product may
 * well offer `.zip` too, and tar refuses one outright — an error rather than a wrong answer, but a
 * caller wanting zip support needs a different reader.
 *
 * Both helpers name the member they want instead of listing the archive. That keeps the **output**
 * small — a full listing of a 2 GB site is megabytes of paths nothing reads — but not the work: tar
 * scans to the end regardless, and on a compressed archive decompresses all of it (measured on a
 * 200 MB `.tar.gz`: ~1.4 s whether listing everything, matching a pattern, or matching nothing).
 * `--occurrence` would cut that, and is deliberately not used: a name can legitimately match two
 * members and both are wanted.
 *
 * Compression is **not** declared: GNU tar detects it when reading, so the same call serves `.tar`
 * and `.tar.gz` and no caller has to parse an extension to pick a flag.
 */

/** `tar`'s exit status when a named member (or a pattern) matches nothing in the archive. */
const NOT_IN_ARCHIVE = 2;

/**
 * Whether `tar` can parse `archivePath` as an archive at all.
 *
 * Asked by **listing it without a pattern** and looking only at the exit status. That is deliberate:
 * `tar` reports "you asked for something absent" and "this archive is unreadable" with the *same*
 * status, and its wording cannot tell them apart either — measured on a live cell, a 20 KB block of
 * random bytes, an empty file **and** a truncated archive all print `<pattern>: Not found in
 * archive`, and only the first two also print a corruption line. Matching on that text would
 * therefore still misread a truncated archive, so nothing here matches on text.
 *
 * Only reached when a pattern found nothing, which is the one moment the distinction matters.
 */
async function isReadableArchive(
  transport: Transport,
  archivePath: string,
): Promise<{ readonly ok: boolean; readonly stderr: string }> {
  const { stderr, exitCode } = await exec(transport, "tar", [
    "-tf",
    archivePath,
  ]);
  return { ok: exitCode === 0, stderr };
}

/**
 * The members of `archivePath` matching `pattern`, in the order `tar` reports them.
 *
 * Duplicates are collapsed: tar allows two members to share a name — a site whose docroot holds a
 * file called the same thing as the database dump produces exactly that — and reading such a name
 * returns *both* members' contents in one go, so listing it twice would only re-read them.
 *
 * @param transport - the site holding the archive.
 * @param archivePath - absolute path to the archive on that site.
 * @param pattern - an exact member name, or a shell glob (e.g. `*.sql`) — matched by `tar` itself,
 * so a huge archive is never listed in full just to answer whether one file is in it. `*` crosses
 * `/`, so a pattern need not know where in the tree the member sits.
 * @returns the matching member names; empty when the archive holds none.
 * @throws {@link Error} if the archive could not be read at all, which is a different answer from
 * "it does not contain that" and must never be reported as one — a corrupt backup would otherwise
 * come back as a confident "that file is not in it".
 *
 * @example
 * ```ts
 * const dumps = await findArchiveEntries(site.transport, archive, "*.sql");
 * ```
 */
export async function findArchiveEntries(
  transport: Transport,
  archivePath: string,
  pattern: string,
): Promise<readonly string[]> {
  const { stdout, stderr, exitCode } = await exec(transport, "tar", [
    "-tf",
    archivePath,
    "--wildcards",
    "--",
    pattern,
  ]);
  if (exitCode === NOT_IN_ARCHIVE) {
    const probe = await isReadableArchive(transport, archivePath);
    if (!probe.ok) {
      throw new Error(
        `[wp/archive] "${archivePath}" could not be read as an archive, so whether it contains ` +
          `"${pattern}" is unknown: ${probe.stderr.trim() || stderr.trim() || "(no output)"}`,
      );
    }
    return [];
  }
  if (exitCode !== 0) {
    throw new Error(
      `[wp/archive] listing "${pattern}" in "${archivePath}" exited ${String(exitCode)}: ` +
        ((stderr || stdout).trim() || "(no output)"),
    );
  }
  // Only the line separator is stripped: a member name may legitimately begin or end with a space,
  // and trimming one away would produce a name `readArchiveEntry` could never find.
  const names = stdout
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line !== "");
  return [...new Set(names)];
}

/**
 * The contents of one member of `archivePath`, as text.
 *
 * Streams the member to standard output rather than extracting anything to disk, so nothing is
 * written to the site. It does not make a large archive cheap to read — tar still scans it, and
 * decompresses it if compressed — it makes the *transfer* small. **The member itself is buffered in
 * full**, so this is for members of known-modest size: a database dump or a marker file, not a media
 * library. Over `local`/`docker` a member past execa's capture cap fails loudly; over `ssh` there is
 * no cap, only heap.
 *
 * When a name matches more than one member, tar emits every one of them, concatenated.
 *
 * @param transport - the site holding the archive.
 * @param archivePath - absolute path to the archive on that site.
 * @param member - the exact member name, as {@link findArchiveEntries} reports it. Taken literally:
 * no `--wildcards`, so a name containing `*` or `?` addresses that member and not a pattern.
 * @returns the member's contents. One trailing newline is removed by the exec layer, so this is not
 * byte-exact for a member that ends in one.
 * @throws {@link Error} if the member is absent or the archive could not be read — a caller wanting
 * "is it there?" should ask {@link findArchiveEntries}, which answers that without throwing.
 */
export async function readArchiveEntry(
  transport: Transport,
  archivePath: string,
  member: string,
): Promise<string> {
  const { stdout, stderr, exitCode } = await exec(transport, "tar", [
    "-xOf",
    archivePath,
    "--",
    member,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `[wp/archive] reading "${member}" from "${archivePath}" exited ${String(exitCode)}: ` +
        ((stderr || stdout).trim() || "(no output)"),
    );
  }
  return stdout;
}
