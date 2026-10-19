import { lstat, stat } from "node:fs/promises";
import { userInfo } from "node:os";

import { shellWord } from "./text";

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
  /** The `chmod` mode that closes a folder as the rule asks: `700`, `go-w`. */
  readonly chmod: string;
}

/** A folder the orchestrator made, for its own files alone: a real folder, mode 0700. */
export const PRIVATE_FOLDER: OwnFolderRule = {
  followLink: false,
  closedTo: 0o077,
  chmod: "700",
};

/**
 * The state directory, the operator's choice (a link to it followed): no one else may write in it.
 * Others reading it is not refused: the lock and counters are the owner's alone, the run folders
 * 0700, and the config's own mode is warned about when it loads.
 */
export const STATE_FOLDER: OwnFolderRule = {
  followLink: true,
  closedTo: 0o022,
  chmod: "go-w",
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
 * const check = await checkOwnFolder(dir, PRIVATE_FOLDER);
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

/**
 * The command that makes a folder {@link checkOwnFolder} refused for its owner or its mode pass.
 * Another user's folder is handed to this one with `sudo` — only root may give a file away, so its
 * owner's `chmod` is no remedy here — then closed as the rule asks when it is open too.
 *
 * @param path - the folder.
 * @param check - what was wrong: another user's, or open to others.
 * @param rule - the rule it was judged by, for the mode it needs.
 * @param user - who must own it: this process's user ({@link currentUser}) by default.
 * @returns `sudo chown alice /srv/state`, `sudo chown alice /srv/state && chmod go-w /srv/state`,
 *   or `chmod 700 /srv/state/tasks`.
 *
 * @example
 * ```ts
 * if (check.kind === "notOwn" || check.kind === "open")
 *   throw new Error(`${dir} ${describeFolderProblem(check)}: ${ownFolderRemedy(dir, check, PRIVATE_FOLDER)}`);
 * ```
 */
export function ownFolderRemedy(
  path: string,
  check: Extract<OwnFolderCheck, { kind: "notOwn" | "open" }>,
  rule: OwnFolderRule,
  user: string = currentUser(),
): string {
  const folder = shellWord(path);
  const chmod = `chmod ${rule.chmod} ${folder}`;
  if (check.kind === "open") return chmod;
  const chown = `sudo chown ${shellWord(user)} ${folder}`;
  return (check.mode & rule.closedTo) === 0 ? chown : `${chown} && ${chmod}`;
}

/**
 * This process's user, as `chown` takes it: its name, or its numeric id when the system has no name
 * for it — `userInfo` throws for a user with no passwd entry, as a container run with an arbitrary
 * `--user` is (measured on `node:24`).
 *
 * @param info - `os.userInfo`.
 * @param uid - this process's user id: `process.getuid()` by default.
 * @returns the name, else the id — empty only with neither, on a system without user ids (Windows),
 *   where {@link checkOwnFolder} checks no owner, so nothing asks.
 */
export function currentUser(
  info: () => { readonly username: string } = userInfo,
  uid: number | undefined = process.getuid?.(),
): string {
  try {
    const { username } = info();
    if (username !== "") return username;
  } catch {
    // No passwd entry: the id serves `chown` as well.
  }
  return String(uid ?? "");
}
