import { lstat, stat } from "node:fs/promises";

/**
 * Whether a folder the orchestrator keeps its state in is safe to use: a real folder, this user's,
 * and closed to others as far as its use needs — a folder anyone else can write to lets them plant a
 * link or a file where the orchestrator then writes, or remove what it relies on.
 */

/** How a folder is judged. */
export interface OwnFolderRule {
  /**
   * `false`: a link in the folder's place is refused (`notFolder`) — for a folder the orchestrator
   * made itself. `true` for one the operator chose, whose link is their choice.
   */
  readonly followLink: boolean;
  /** The permission bits no one but the owner may have: `0o077` for "0700 only", `0o022` for "no one else writes". */
  readonly closedTo: number;
}

/** A folder the orchestrator made, for its own files alone: a real folder, mode 0700. */
export const PRIVATE_FOLDER: OwnFolderRule = {
  followLink: false,
  closedTo: 0o077,
};

/**
 * The state directory, the operator's choice (a link to it followed): no one else may write in it.
 * Others reading it is not refused: the lock and counters are the owner's alone, the run folders
 * 0700, and the config's own mode is warned about when it loads.
 */
export const STATE_FOLDER: OwnFolderRule = {
  followLink: true,
  closedTo: 0o022,
};

/** A folder as judged: fine, or what is wrong with it. */
export type OwnFolderCheck =
  | { readonly kind: "ok" }
  /** Not a folder — a file, or a link when links are not followed. */
  | { readonly kind: "notFolder" }
  /** Another user's: its owner's uid, and its permission bits. */
  | { readonly kind: "notOwn"; readonly uid: number; readonly mode: number }
  /** Open to others beyond the rule: its permission bits. */
  | { readonly kind: "open"; readonly mode: number };

/**
 * Judges a folder by its type, owner and mode.
 *
 * @param path - the folder.
 * @param rule - whether a link is followed, and the bits refused.
 * @param uid - this user's id; `process.getuid()` by default, and no owner check where there is none
 *   (Windows).
 * @returns `ok`, or what is wrong.
 * @throws what `lstat`/`stat` throws — `ENOENT` when nothing is there.
 *
 * @example
 * ```ts
 * const check = await checkOwnFolder(dir, { followLink: false, closedTo: 0o077 });
 * if (check.kind !== "ok") throw new Error(`${dir} is not private`);
 * ```
 */
export async function checkOwnFolder(
  path: string,
  rule: OwnFolderRule,
  uid: number | undefined = process.getuid?.(),
): Promise<OwnFolderCheck> {
  const stats = await (rule.followLink ? stat(path) : lstat(path));
  if (!stats.isDirectory()) return { kind: "notFolder" };
  if (uid !== undefined && stats.uid !== uid)
    return { kind: "notOwn", uid: stats.uid, mode: stats.mode & 0o777 };
  if ((stats.mode & rule.closedTo) !== 0)
    return { kind: "open", mode: stats.mode & 0o777 };
  return { kind: "ok" };
}

/**
 * What {@link checkOwnFolder} found wrong, as the end of a sentence naming the folder.
 *
 * @param check - a failed check.
 * @returns `"is not a folder"`, `"is owned by uid 0, not this user"` or `"is mode 777"`.
 */
export function describeFolderProblem(
  check: Exclude<OwnFolderCheck, { kind: "ok" }>,
): string {
  switch (check.kind) {
    case "notFolder":
      return "is not a folder";
    case "notOwn":
      return `is owned by uid ${String(check.uid)}, not this user`;
    case "open":
      return `is mode ${check.mode.toString(8)}`;
  }
}
