import { posix } from "node:path";

import {
  assertResolvedInsideRoot,
  describeTarget,
  elevationSupport,
  exec,
  execElevated,
  wpRootDir,
} from "../../../common/wp/exec";
import { assertSafeElevatedTarget } from "../../../common/wp/paths";
import { isPlaceholderSite } from "../../../common/config/sites";
import { errorMessage } from "../../../common/guards";
import type { ExecResult } from "../../../common/wp/exec";
import type { SiteConfig, Transport } from "../../../common/config/types";

/**
 * A copy of a site's `wp-content`, taken before a command that rewrites it wholesale and put back
 * exactly afterwards — for `wp backwpup restore`, which deletes what its archive does not hold and
 * writes the rest back as the transport's user (measured on `pro@nginx`).
 *
 * **Root does both halves, from the start** — the one place elevation is not a fallback: only root
 * reads every file the web server owns and puts every owner back. Without passwordless `sudo` the
 * copy is refused, and with it the command: a rewrite that could not be undone must not run on a
 * shared cell.
 *
 * **The copy outlives a failure on purpose.** It is kept in a root-only directory at the WordPress
 * root ({@link CONTENT_COPY_DIR}) — not the scenario's staging area, which every worker's teardown
 * wipes — and removed only once it is back. A put-back that failed, or a run killed between the
 * command and the put-back, leaves it there with `wp-content` possibly as the command left it, and
 * every BackWPup worker then refuses that site until someone settles it
 * ({@link assertNoContentCopyLeft}).
 *
 * Modes, owners and hard links are kept; ACLs and extended attributes are not (none on the cells,
 * measured with `getfacl`).
 */

/** Where a copy is kept, relative to the WordPress root: root-only (`0700`), so never served. */
export const CONTENT_COPY_DIR = ".e2e_content_copy";

/** The copy's file name in {@link CONTENT_COPY_DIR}. */
export const CONTENT_COPY_FILE = "wp-content.tar";

/**
 * Space the copy needs beyond the content directory's own size before it is taken, so the shared disk
 * is never the thing that fills up.
 */
const COPY_HEADROOM_KB = 1024 * 1024;

/** The content directory's name, and so the copy's one top-level member, under the WordPress root. */
const CONTENT_DIR = "wp-content";

/**
 * GNU tar's arguments for taking the copy: `wp-content` itself, from the WordPress root — never `.`
 * from inside it, since Ubuntu's GNU tar 1.35 refuses to unlink `.` when putting such a copy back
 * (exit 2, measured on `pro@nginx` and in `ubuntu:24.04`). Root records every owner and mode, and
 * the POSIX format keeps modification times to the nanosecond, which tar's default rounds down to
 * the second (measured). The left-out paths are matched literally (`--no-wildcards`) and anchored at
 * the root, so a same-named path deeper down is still copied.
 *
 * @param archive - the copy's path on the site.
 * @param root - the WordPress root's absolute path.
 * @param keptOut - paths relative to the content directory.
 */
export function copyArgv(
  archive: string,
  root: string,
  keptOut: readonly string[],
): string[] {
  return [
    "-cf",
    archive,
    "--format=posix",
    "--no-wildcards",
    "--anchored",
    ...keptOut.map((path) => `--exclude=${CONTENT_DIR}/${path}`),
    "-C",
    root,
    CONTENT_DIR,
  ];
}

/**
 * GNU tar's arguments for putting the copy back, as root, into the WordPress root: each entry with its
 * owner and mode, and `--recursive-unlink`, which empties every directory before extracting into it —
 * `wp-content` first. So it ends as the copy holds it, exactly: what the command added goes, and a
 * directory where the copy has a file is replaced — which a plain extraction refuses, exiting 2
 * half-done. What the copy left out goes too; by then the teardowns have removed it already. A link
 * the command left is removed, never followed. All measured with GNU tar 1.34 and 1.35 (Debian,
 * Ubuntu, Alpine).
 *
 * @param archive - the copy's path on the site.
 * @param root - the WordPress root's absolute path.
 */
export function putBackArgv(archive: string, root: string): string[] {
  return ["-xpf", archive, "--recursive-unlink", "-C", root];
}

/** How GNU tar's complaint ends, at exit 1, about a file that changed while it was copied. */
const CHANGED_WHILE_READ = ": file changed as we read it";

/** How GNU tar's complaint ends, at exit 1, about a file that went before it could be copied. */
const REMOVED_BEFORE_READ = ": File removed before we read it";

/**
 * Whether a copy tar finished at exit 1 is still a faithful one: only when every complaint is a file
 * that changed, or went, while it was read — the copy then holds it as it was a moment earlier, or not
 * at all, as the site did. Anything else at exit 1 is refused: `File shrank` pads the file with zeros
 * (the put-back would write that over a good one), and `sudo` itself exits 1 when it refuses.
 *
 * @param stderr - what tar printed.
 */
export function benignCopyWarnings(stderr: string): boolean {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return (
    lines.length > 0 &&
    lines.every(
      (line) =>
        line.endsWith(CHANGED_WHILE_READ) || line.endsWith(REMOVED_BEFORE_READ),
    )
  );
}

/** How much a copy needs and how much there is, in kilobytes. */
export interface CopyRoom {
  readonly usedKb: number;
  readonly freeKb: number;
}

/**
 * Reads `du -sk` and `df -Pk`: the content directory's size and the free space where the copy goes —
 * or `undefined` when either is not a whole number, which an empty answer (a refused `sudo du`) or an
 * unexpected format would otherwise turn into `0` and wave through.
 *
 * @param du - `du -sk <content>`.
 * @param df - `df -Pk <destination>`.
 */
export function parseCopyRoom(
  du: Pick<ExecResult, "stdout">,
  df: Pick<ExecResult, "stdout">,
): CopyRoom | undefined {
  const used = du.stdout.trim().split(/\s+/)[0] ?? "";
  const free =
    df.stdout.trim().split("\n").at(-1)?.trim().split(/\s+/)[3] ?? "";
  if (!/^\d+$/.test(used) || !/^\d+$/.test(free)) return undefined;
  return { usedKb: Number(used), freeKb: Number(free) };
}

/** Where a copy lives and what it copies, all absolute. */
interface CopyPlace {
  readonly root: string;
  readonly content: string;
  readonly dir: string;
  readonly archive: string;
}

/**
 * Where this site's copy goes. Not checked here — see {@link ContentCopy.keep} for the guards.
 *
 * @param transport - the site.
 */
async function copyPlace(transport: Transport): Promise<CopyPlace> {
  const root = await wpRootDir(transport);
  const dir = posix.join(root, CONTENT_COPY_DIR);
  return {
    root,
    content: posix.join(root, CONTENT_DIR),
    dir,
    archive: posix.join(dir, CONTENT_COPY_FILE),
  };
}

/**
 * What to tell an operator about a copy an earlier run left: it may be the only way back to the site
 * as that run found it.
 *
 * @param target - the site, as messages name it.
 * @param place - where the copy is.
 */
function leftoverMessage(target: string, place: CopyPlace): string {
  return (
    `[backwpup/content-copy] ${target}: a copy of wp-content an earlier run took is still in ` +
    `${place.dir}. That run's \`wp backwpup restore\` may have left wp-content damaged (files ` +
    "deleted, others owned by the transport's user) and never put it back. If it is damaged, put " +
    `the copy back: \`sudo tar -xpf ${place.archive} --recursive-unlink -C ${place.root}\`; ` +
    `either way remove it then: \`sudo rm -r ${place.dir}\`. BackWPup runs refuse this site until ` +
    "it is gone."
  );
}

/**
 * Refuses a site holding a copy an earlier run left — run once per BackWPup worker, before its first
 * scenario, since every result on a site whose `wp-content` may be damaged would be suspect.
 *
 * Asked as the transport's user: the copy's directory is root-only, but whether it exists is visible
 * to anyone. A site that cannot be asked is warned about, not refused — its scenarios then fail in
 * their own words — and a placeholder site is skipped.
 *
 * @param site - the worker's bound site, or `undefined` when the project has none.
 * @throws {@link Error} naming the copy and how to settle it, when one is there.
 */
export async function assertNoContentCopyLeft(
  site: Pick<SiteConfig, "baseURL" | "transport"> | undefined,
): Promise<void> {
  if (site === undefined || isPlaceholderSite(site)) return;
  let place: CopyPlace;
  let found: ExecResult;
  try {
    place = await copyPlace(site.transport);
    found = await exec(site.transport, "test", ["-e", place.dir]);
  } catch (error) {
    console.warn(
      `[backwpup/content-copy] could not check ${site.baseURL} for a copy of wp-content an earlier ` +
        `run left: ${errorMessage(error)}`,
    );
    return;
  }
  if (found.exitCode === 0) {
    throw new Error(leftoverMessage(describeTarget(site.transport), place));
  }
}

/**
 * A copy of the site's content directory, taken before a command that rewrites it wholesale and put
 * back afterwards — see the module header.
 */
export class ContentCopy {
  /** Where the copy is, once taken. */
  private place: CopyPlace | undefined;

  /** Whether the copy has been put back. */
  private restored = false;

  /**
   * @param transport - the scenario's site.
   * @param leaveOut - works out, when the copy is taken, what it leaves out — paths relative to the
   * content directory that the scenario's own teardowns remove.
   */
  constructor(
    private readonly transport: Transport,
    private readonly leaveOut: () => Promise<readonly string[]>,
  ) {}

  /** Whether a copy is waiting to be put back. */
  get kept(): boolean {
    return this.place !== undefined && !this.restored;
  }

  /**
   * Takes the copy, once per scenario: the first is the state to return to.
   *
   * @throws {@link Error} — and the command must then not run — if the host cannot elevate, a path is
   * unsafe for root, an earlier run's copy is still there, the disk has no room, or the copy could not
   * be taken whole.
   */
  async keep(): Promise<void> {
    if (this.place !== undefined) return;
    const place = await copyPlace(this.transport);
    await this.assertUsable(place);
    await this.assertRoom(place);
    const keptOut = await this.leaveOut();
    try {
      await this.makeDir(place);
      await this.copy(place, keptOut);
    } catch (error) {
      // Nothing has been rewritten yet, so a copy that failed is no leftover to settle.
      await this.discard(place);
      throw error;
    }
    this.place = place;
  }

  /**
   * Puts the copy back, then removes it. Does nothing when no copy was taken, or it is back already.
   *
   * @throws {@link Error} if it could not be extracted — the copy is then **kept**, and the message
   * says how to put it back by hand.
   */
  async putBack(): Promise<void> {
    const place = this.place;
    if (place === undefined || this.restored) return;
    const result = await execElevated(
      this.transport,
      "tar",
      putBackArgv(place.archive, place.root),
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `[backwpup/content-copy] ${describeTarget(this.transport)}: could not put wp-content back ` +
          `(exit ${String(result.exitCode)}: ${result.stderr.trim().slice(0, 500) || "no output"}); ` +
          "it may be partly as the restore left it. " +
          leftoverMessage(describeTarget(this.transport), place),
      );
    }
    this.restored = true;
    await this.discard(place);
  }

  /**
   * Refuses what root must not act on: a host that cannot elevate, a path that leaves the site, a
   * content or copy directory that is a link, and a copy an earlier run left.
   */
  private async assertUsable(place: CopyPlace): Promise<void> {
    const target = describeTarget(this.transport);
    const describe = (reason: string): string =>
      `[backwpup/content-copy] ${target}: refusing to copy wp-content as root — ${reason}. The ` +
      "restore was not run.";
    const elevation = await elevationSupport(this.transport);
    if (elevation !== "available") {
      throw new Error(
        describe(
          `it needs passwordless sudo (elevation: ${elevation}) to read every file and put back ` +
            "every owner",
        ),
      );
    }
    for (const path of [place.content, place.dir]) {
      assertSafeElevatedTarget(path, place.root, describe);
      await assertResolvedInsideRoot(
        this.transport,
        path,
        place.root,
        describe,
      );
      if ((await exec(this.transport, "test", ["-L", path])).exitCode === 0) {
        throw new Error(describe(`"${path}" is a symbolic link`));
      }
    }
    if (
      (await exec(this.transport, "test", ["-e", place.dir])).exitCode === 0
    ) {
      throw new Error(
        `${leftoverMessage(target, place)} The restore was not run.`,
      );
    }
  }

  /**
   * Refuses a copy the disk has no room for: what the content directory holds, plus headroom.
   *
   * @throws {@link Error} naming both sizes, or saying they could not be told.
   */
  private async assertRoom(place: CopyPlace): Promise<void> {
    const [du, df] = await Promise.all([
      execElevated(this.transport, "du", ["-sk", "--", place.content]),
      exec(this.transport, "df", ["-Pk", "--", place.root]),
    ]);
    const room = parseCopyRoom(du, df);
    const target = describeTarget(this.transport);
    if (room === undefined) {
      throw new Error(
        `[backwpup/content-copy] ${target}: could not tell whether the disk has room for a copy of ` +
          `wp-content (du: ${du.stdout.trim().slice(0, 100) || du.stderr.trim().slice(0, 100) || "no output"}). ` +
          "The restore was not run.",
      );
    }
    if (room.freeKb < room.usedKb + COPY_HEADROOM_KB) {
      throw new Error(
        `[backwpup/content-copy] ${target}: a copy of wp-content needs about ` +
          `${String(Math.ceil(room.usedKb / 1024))} MB and 1 GB to spare, but only ` +
          `${String(Math.floor(room.freeKb / 1024))} MB are free. The restore was not run.`,
      );
    }
  }

  /** Creates the copy's directory, root-only. */
  private async makeDir(place: CopyPlace): Promise<void> {
    for (const [file, args] of [
      ["mkdir", ["--", place.dir]],
      ["chmod", ["--", "0700", place.dir]],
    ] as const) {
      const result = await execElevated(this.transport, file, [...args]);
      if (result.exitCode !== 0) {
        throw new Error(
          `[backwpup/content-copy] ${describeTarget(this.transport)}: could not prepare ${place.dir} ` +
            `for the copy (${file} exited ${String(result.exitCode)}: ` +
            `${result.stderr.trim() || "no output"}). The restore was not run.`,
        );
      }
    }
  }

  /**
   * Takes the copy and proves it reads back whole — a `tar` that exited 1 for a reason it should not
   * have, `sudo` refusing it included, leaves no archive or a short one.
   */
  private async copy(
    place: CopyPlace,
    keptOut: readonly string[],
  ): Promise<void> {
    const target = describeTarget(this.transport);
    const made = await execElevated(
      this.transport,
      "tar",
      copyArgv(place.archive, place.root, keptOut),
    );
    const benign = made.exitCode === 1 && benignCopyWarnings(made.stderr);
    if (made.exitCode !== 0 && !benign) {
      throw new Error(
        `[backwpup/content-copy] ${target}: could not copy wp-content before the restore (exit ` +
          `${String(made.exitCode)}): ${made.stderr.trim().slice(0, 500) || "no output"}. The ` +
          "restore was not run.",
      );
    }
    if (benign) {
      console.warn(
        `[backwpup/content-copy] ${target}: files changed while wp-content was copied — ` +
          made.stderr.trim().slice(0, 300),
      );
    }
    const listed = await execElevated(this.transport, "tar", [
      "-tf",
      place.archive,
    ]);
    if (listed.exitCode !== 0 || !listed.stdout.startsWith(`${CONTENT_DIR}/`)) {
      throw new Error(
        `[backwpup/content-copy] ${target}: the copy of wp-content does not read back (exit ` +
          `${String(listed.exitCode)}: ${listed.stderr.trim().slice(0, 300) || "no output"}). The ` +
          "restore was not run.",
      );
    }
  }

  /**
   * Removes the copy and its directory. Best-effort: one that stays is reported, since every later
   * BackWPup run on the site refuses it until it is gone.
   */
  private async discard(place: CopyPlace): Promise<void> {
    await execElevated(this.transport, "rm", ["-f", "--", place.archive]);
    await execElevated(this.transport, "rmdir", ["--", place.dir]);
    if (
      (await exec(this.transport, "test", ["-e", place.dir])).exitCode === 0
    ) {
      console.warn(
        `[backwpup/content-copy] ${describeTarget(this.transport)}: could not remove ${place.dir}; ` +
          `remove it by hand (\`sudo rm -r ${place.dir}\`) — BackWPup runs refuse this site until it ` +
          "is gone.",
      );
    }
  }
}
