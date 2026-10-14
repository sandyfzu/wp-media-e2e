import { lstat } from "node:fs/promises";

/**
 * Refuses a folder anyone else could have prepared or could change: it must be a real folder (not a
 * link to one), this user's, and closed to everyone else (no group or other bit). Only then are the
 * names inside it this user's alone, so a file opened there cannot be swapped by someone else between
 * a check and a use. Folders above it are not judged.
 *
 * @param dir - the folder.
 * @param name - what it is, for the message: `"orchestrator's log folder"`.
 * @param uid - this process's user, when the platform has one.
 * @throws {@link Error} naming the folder and what is wrong, or `lstat`'s error when it cannot be read.
 */
export async function assertPrivateFolder(
  dir: string,
  name: string,
  uid: number | undefined = process.getuid?.(),
): Promise<void> {
  const stats = await lstat(dir);
  if (!stats.isDirectory())
    throw new Error(`The ${name} is not a folder: ${dir}.`);
  if (uid !== undefined && stats.uid !== uid)
    throw new Error(`The ${name} must be this user's: ${dir} is not.`);
  if ((stats.mode & 0o077) !== 0)
    throw new Error(
      `The ${name} must be this user's alone (mode 0700): ${dir} is mode ${(stats.mode & 0o777).toString(8).padStart(3, "0")}.`,
    );
}
