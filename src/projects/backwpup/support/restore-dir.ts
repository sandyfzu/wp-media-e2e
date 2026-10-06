import { posix } from "node:path";

import { exec, wpRootDir } from "../../../common/wp/exec";
import { evalPhp } from "../../../common/wp/php";
import { isObject } from "../../../common/guards";
import { normalizeOwnership } from "../../../common/wp/ownership";
import { pathInsideRoot } from "../../../common/wp/paths";
import type {
  ResolveSiteDataDirs,
  Transport,
} from "../../../common/config/types";

/**
 * BackWPup's restore working directory — where a restore keeps its state (`restore.dat`, which holds
 * the database credentials), its log, the archive it restores and the tree it unpacks.
 *
 * Recent builds name it `uploads/backwpup-restore-<20 hex>`, the tail an option the plugin draws the
 * first time it needs it (`restore_dir_name()`), so its name is known only to the installed plugin.
 * Older ones use the fixed `uploads/backwpup-restore`, which `support/residue.ts` declares outright.
 *
 * **Both of the site's users write into it, and whichever arrives first decides whether the other
 * can.** Listing backups over WP-CLI boots it on Pro, as the transport's user: measured, the
 * directory arrived `ubuntu:ubuntu 0775`, after which every admin page that lists backups died on an
 * uncaught "Restore working directory … is not writable" (HTTP 500). With the directory opened up
 * front, the same listing still writes `restore.dat` there as `ubuntu 0664`, and every request of the
 * next restore then died on "Could not write Registry file". So the directory is prepared after each
 * install ({@link resolveRestoreWorkingDirs}), and handed to the web server again right before a
 * restore runs ({@link handRestoreWorkingDirToSite}).
 */

/**
 * Asks the installed plugin where its restore working directory is, and whether this build names one
 * at all. Mirrors the plugin's own computation (`restore_container()`, `commons.php`): the uploads
 * base directory made absolute, then the name. Calling `restore_dir_name()` draws the name if the
 * install has none yet — exactly what the plugin itself does the first time it needs the directory.
 *
 * Exported for its unit test; callers use {@link restoreWorkingDir}.
 */
export const RESTORE_DIR_PHP = `
$name = 'Inpsyde\\BackWPup\\Infrastructure\\Restore\\restore_dir_name';
if ( ! function_exists( $name ) ) {
	echo wp_json_encode( null );
	return;
}
$uploads = wp_upload_dir( null, false, false );
echo wp_json_encode( [
	'dir'  => untrailingslashit( \\BackWPup_File::get_absolute_path( $uploads['basedir'] ) ) . '/' . $name(),
	'root' => ABSPATH,
] );
`;

/**
 * Reads {@link RESTORE_DIR_PHP}'s answer: the directory relative to the WordPress root, or `undefined`
 * for a build with no runtime-named directory.
 *
 * @param reply - the snippet's output.
 * @throws {@link Error} if the reply is not one the snippet gives, or names a directory outside the
 * WordPress root — which no residue path could then remove.
 */
export function parseRestoreDirReply(reply: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    parsed = undefined;
  }
  if (parsed === null) return undefined;
  if (
    !isObject(parsed) ||
    typeof parsed.dir !== "string" ||
    typeof parsed.root !== "string"
  ) {
    throw new Error(
      `[backwpup/restore-dir] asking for the restore working directory returned an unexpected ` +
        `answer: ${reply.slice(0, 300) || "(nothing)"}`,
    );
  }
  const relative = pathInsideRoot(parsed.dir, parsed.root);
  if (relative === undefined) {
    throw new Error(
      `[backwpup/restore-dir] the restore working directory is "${parsed.dir}", outside the ` +
        `WordPress root ("${parsed.root}"), where the suite can neither prepare nor remove it.`,
    );
  }
  return relative;
}

/**
 * The installed plugin's restore working directory, relative to the WordPress root — `undefined` for
 * a build that uses only the fixed `uploads/backwpup-restore`.
 *
 * @param transport - the site, with BackWPup installed and active.
 * @throws {@link Error} if the site could not be asked, or answered with a directory outside its root.
 */
export async function restoreWorkingDir(
  transport: Transport,
): Promise<string | undefined> {
  return parseRestoreDirReply(
    await evalPhp(
      transport,
      RESTORE_DIR_PHP,
      "asking for the restore working directory",
      "backwpup/restore-dir",
    ),
  );
}

/**
 * BackWPup's `ProductConfig.resolveSiteDataDirs`: the restore working directory this install named,
 * if its build names one.
 *
 * @param transport - the freshly installed site.
 */
export const resolveRestoreWorkingDirs: ResolveSiteDataDirs = async (
  transport,
) => {
  const dir = await restoreWorkingDir(transport);
  return dir === undefined ? [] : [dir];
};

/**
 * Gives the restore working directory, and whatever WP-CLI wrote in it, back to the site's ownership
 * — for a step about to drive a restore in the browser, whose every request saves its state there as
 * the web server.
 *
 * A directory that is not there is left alone: the web server creates it itself on the restore's
 * first request, and nothing of WP-CLI's can be in it (measured on Free, whose listings never boot
 * the restore). Best-effort otherwise, like every ownership correction: a host that cannot do it is
 * warned about, and the restore then fails on its own, saying why.
 *
 * @param transport - the scenario's site.
 * @throws {@link Error} only if the plugin could not be asked where the directory is.
 */
export async function handRestoreWorkingDirToSite(
  transport: Transport,
): Promise<void> {
  const dir = await restoreWorkingDir(transport);
  if (dir === undefined) return;
  const present = await exec(transport, "test", [
    "-d",
    posix.join(await wpRootDir(transport), dir),
  ]);
  if (present.exitCode === 0) await normalizeOwnership(transport, dir);
}
