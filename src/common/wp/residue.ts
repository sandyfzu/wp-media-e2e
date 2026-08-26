import { posix } from "node:path";

import { elevationSupport, exec, execElevated, wpRootDir } from "./exec";
import { SiteResidueRemovalFailedError } from "./errors";
import type { ExecResult } from "./exec";
import type { Transport } from "../config/types";

/**
 * The data a plugin writes to the site's **filesystem**: opening those directories before a scenario
 * ({@link prepareSiteDataDirs}), and removing them after it ({@link removeSiteResidue}). Both work
 * from the same product-declared list, and both exist because the suite reinstalls the plugin for
 * every scenario while the files the plugin wrote outlive it.
 *
 * Uninstalling a plugin removes its code and — if it implements `uninstall.php` properly — its
 * database footprint. It does not remove the files the plugin *wrote while running*, and it
 * generally should not: those are the user's data. BackWPup is the clear case, and the reason this
 * module exists: its uninstall touches no files at all, so every backup archive, log and temp file
 * it produced stays behind, under a **new randomly-named directory per install**. A suite that
 * installs the plugin once per scenario therefore leaves a fresh copy of the site's own archive on
 * disk every time, and the cell fills up. (Measured on the QA cell: 6.8 GB across 28 such
 * directories, from a few days of runs.)
 *
 * Some of that residue is worse than bulky. BackWPup's restore working directory can hold a
 * `restore.dat.bkp` containing **plaintext database credentials** — the plugin ships an admin
 * notice warning about exactly that — so clearing it is hygiene in both senses.
 *
 * **The transport's user often cannot do this alone, and that is normal.** The plugin writes as the
 * web-server user, and a directory it creates with `0755` (BackWPup's restore area, from Monolog's
 * `mkdir` under the default umask) cannot be emptied by anyone else — so an unprivileged `rm -rf`
 * fails and the site keeps a copy of its own database dump from every scenario that ever ran. So
 * removal escalates: **as ourselves first, then with privileges for whatever survived**, which keeps
 * a correctly-permissioned host from ever running `rm` as root while still finishing the job on the
 * hosts that need it. See `./exec.ts` for the limits on elevation.
 *
 * **And the transport's user is not the only user of these directories** — the other half of the
 * story. WP-CLI and the web server are different users on a real cell, so a directory either one
 * creates under its own umask locks the other out. {@link prepareSiteDataDirs} settles that up front
 * instead of leaving it to whichever happened to write first.
 *
 * Which paths a product leaves is the product's own knowledge, so it declares them
 * (`ProductConfig.siteResidue`) and the shared scenario hooks read them from the per-process
 * registry. This module only knows how to prepare and remove such a path safely on any transport.
 */

/**
 * Directories WordPress itself owns, which a residue declaration must never name.
 *
 * A guard against a typo in a config file — `wp-content/uploads` instead of
 * `wp-content/uploads/backwpup` would delete every media file on the site — not a security
 * boundary: the declarations come from our own code, and anything below these is fair game.
 */
const PROTECTED_PATHS: readonly string[] = [
  "wp-admin",
  "wp-includes",
  "wp-content",
  "wp-content/uploads",
  "wp-content/plugins",
  "wp-content/mu-plugins",
  "wp-content/themes",
  "wp-content/languages",
  "wp-content/upgrade",
];

/**
 * Validates one declared residue path and returns it normalised.
 *
 * Deliberately **relative only**: a residue path names something the product created inside the
 * WordPress install, and requiring that shape is what keeps a stray leading `/` from turning a
 * cleanup into a system-wide `rm -rf`.
 *
 * @param declared - the path as the product declared it, relative to the WordPress root.
 * @returns the normalised path, still relative.
 * @throws Error naming the path and the rule it broke.
 */
export function normaliseResiduePath(declared: string): string {
  const trimmed = declared.trim();
  const reason = residueRejection(trimmed);
  if (reason !== undefined) {
    throw new Error(
      `[wp/residue] "${declared}" cannot be removed as leftover data: ${reason}. Declare a path ` +
        'relative to the WordPress root that the product itself created, e.g. "wp-content/uploads/<plugin>".',
    );
  }
  return posix.normalize(trimmed).replace(/\/+$/, "");
}

/** The rule `path` breaks, or `undefined` when it is a usable residue path. */
function residueRejection(path: string): string | undefined {
  if (path === "") return "it is empty";
  if (path.includes("\\")) {
    return "it contains a backslash; target paths are always POSIX";
  }
  if (posix.isAbsolute(path)) {
    return "it is absolute, and residue paths are resolved against the site's WordPress root";
  }
  const normalised = posix.normalize(path).replace(/\/+$/, "");
  if (normalised === "." || normalised === "..") {
    return "it resolves to the WordPress root itself";
  }
  if (normalised.startsWith("../")) {
    return "it escapes the WordPress root";
  }
  if (PROTECTED_PATHS.includes(normalised)) {
    return `it resolves to "${normalised}", a directory WordPress itself owns`;
  }
  return undefined;
}

/** Runs one command against the site — either as the transport's user, or with privileges. */
type Runner = (file: string, args: string[]) => Promise<ExecResult>;

/**
 * Mode the data directories are created with. World-writable, and deliberately so.
 *
 * On a real cell **WP-CLI and the web server run as different users** — `ubuntu` over SSH, `www-data`
 * under PHP-FPM — sharing one docroot. Whichever of them creates one of these directories first does
 * so under its own umask (`0775`/`0755`, owned by itself), which locks the other out of a directory
 * they must both write: WP-CLI because the plugin's CLI commands log into it, the web server because
 * the plugin's admin pages do. It is not a hypothetical — see {@link prepareSiteDataDirs}.
 *
 * `0777` is what the plugin itself asks for (`mkdir($dir, 0777, true)`, narrowed only by the umask)
 * and what WordPress's own `wp_mkdir_p` would produce here, since it inherits the containing
 * directory's mode and `wp-content/uploads` on these cells is already `0777` for this very reason.
 * The sites are disposable QA installs, and removal now genuinely clears the sensitive contents
 * after every scenario where before it could not — so the exposure goes down, not up.
 */
const DATA_DIR_MODE = "0777";

/**
 * Creates a product's data directories up front, so that **which user happens to get there first
 * stops deciding whether the other one can write them.**
 *
 * Found the hard way, and only once removal started working: BackWPup's restore area used to survive
 * every teardown, so the copy created long ago by the web server was always the one in use. With it
 * genuinely removed after each scenario, the next scenario's first writer creates it instead — and
 * when that writer was a WP-CLI call, the directory arrived as `drwxrwxr-x ubuntu:ubuntu` and the
 * plugin's very next admin request died on `Folder "…/backwpup-restore" is not writable`
 * (`BackWPup_File::check_folder`, via `create_project_temp_dir`). Observed directly on the cell: the
 * directory appearing owned by the transport user at 15:38:49, the fatal at 15:38:50.
 *
 * Creating them here — before anything runs — makes that race impossible rather than unlikely. Each
 * step escalates only if the transport's user is refused, and the whole thing is idempotent, so a
 * directory an earlier run left behind is simply re-opened to both users.
 *
 * @param transport - the target site's transport.
 * @param paths - the product's declared paths, as {@link removeSiteResidue} takes them. Empty does
 * nothing at all, not even resolving the root.
 * @throws Error if a declared path is not a usable residue path (see {@link normaliseResiduePath}),
 * or if a directory can be neither created nor opened to both users.
 */
export async function prepareSiteDataDirs(
  transport: Transport,
  paths: readonly string[],
): Promise<void> {
  if (paths.length === 0) return;
  const relative = paths.map(normaliseResiduePath);
  const root = await wpRootDir(transport);

  for (const path of relative) {
    const target = posix.join(root, path);
    await escalateIfDenied(transport, "mkdir", ["-p", target]);
    await escalateIfDenied(transport, "chmod", [DATA_DIR_MODE, target]);
  }
}

/**
 * Runs `file args…` as the transport's user, retrying with privileges if it was refused.
 *
 * Used for the preparation steps above, where a non-zero exit means "not permitted" rather than a
 * legitimate answer. Reports the *unprivileged* failure when escalation is unavailable or also fails,
 * because that is the one an operator can act on.
 *
 * @throws Error naming the command, the path and how far privileges reached.
 */
async function escalateIfDenied(
  transport: Transport,
  file: string,
  args: string[],
): Promise<void> {
  const first = await exec(transport, file, args);
  if (first.exitCode === 0) return;

  const elevation = await elevationSupport(transport);
  if (elevation === "available") {
    const elevated = await execElevated(transport, file, args);
    if (elevated.exitCode === 0) return;
  }
  throw new Error(
    `[wp/residue] could not \`${file} ${args.join(" ")}\` on this ${transport.mode} site ` +
      `(exit ${String(first.exitCode)}: ${(first.stderr || first.stdout).trim() || "no output"}; ` +
      `elevation: ${elevation}). The plugin's data directories must be writable by both the ` +
      "transport's user and the web server, which share this site's docroot.",
  );
}

/**
 * `rm -rf`s each target with `run`, and returns the ones still there afterwards.
 *
 * Every path is attempted even when an earlier one fails, so one stubborn directory cannot leave the
 * rest behind, and a caller can report **all** the survivors at once rather than the first.
 *
 * Removal is verified rather than inferred: `rm -rf` reports success for a path it never had to
 * touch, and this suite's discipline elsewhere is to re-read the state rather than trust an exit
 * code. The check runs at the **same privilege** as the removal, because a `test -e` the transport's
 * user is not allowed to answer would report a path it cannot even see as gone.
 */
async function removeEach(
  targets: readonly string[],
  run: Runner,
): Promise<string[]> {
  const survivors: string[] = [];
  for (const target of targets) {
    await run("rm", ["-rf", target]);
    const { exitCode } = await run("test", ["-e", target]);
    if (exitCode === 0) survivors.push(target);
  }
  return survivors;
}

/**
 * The guard that matters once `rm -rf` runs as **root**: a nonsense `rootDir` would otherwise aim a
 * privileged delete at a real system path.
 *
 * {@link normaliseResiduePath} already constrains the *relative* half — inside the root, not a
 * WordPress-owned directory — so this checks the half it cannot see: that the root is a plausible
 * site root, and that joining the two really did stay inside it. Unelevated removal is left alone;
 * there the transport's own permissions are the backstop, and tightening it would break nothing an
 * operator asked for.
 *
 * @throws Error naming the value and the rule it broke.
 */
function assertSafeElevatedRemoval(target: string, root: string): void {
  const trimmed = root.replace(/(?!^)\/+$/, "");
  const depth = trimmed.split("/").filter((segment) => segment !== "").length;

  let reason: string | undefined;
  if (!posix.isAbsolute(trimmed)) {
    reason = "it is not an absolute path";
  } else if (depth < 2) {
    reason = "it is a filesystem or top-level system directory";
  } else if (!target.startsWith(`${trimmed}/`)) {
    reason = `"${target}" does not resolve inside it`;
  }

  if (reason !== undefined) {
    throw new Error(
      `[wp/residue] refusing to remove leftover data with elevated privileges: this site's ` +
        `WordPress root ("${root}") cannot be used for it — ${reason}. Fix the site's \`rootDir\`, ` +
        "or set `transport.elevate: false` to keep cleanup unprivileged.",
    );
  }
}

/**
 * Removes the declared leftovers from a site, and confirms they are gone.
 *
 * Two passes, and the order is the point: everything is attempted as the transport's own user, and
 * only what **survived** is retried with privileges. A host whose permissions are already right
 * therefore never runs a privileged command, while a host where the web-server user owns the data
 * still ends up clean. Re-running is safe either way — a path that is already gone is simply
 * confirmed gone.
 *
 * @param transport - the target site's transport.
 * @param paths - paths relative to the WordPress root, as the product declared them. An empty
 * list does nothing at all, not even resolving the root, so a product that leaves nothing behind
 * pays nothing.
 * @throws Error if a declared path is not a usable residue path (see {@link normaliseResiduePath}),
 * or if the root is unusable for a privileged removal (see {@link assertSafeElevatedRemoval}); or
 * {@link SiteResidueRemovalFailedError} naming whatever survived, and how far privileges reached.
 */
export async function removeSiteResidue(
  transport: Transport,
  paths: readonly string[],
): Promise<void> {
  if (paths.length === 0) return;
  // Validate every path before touching the site: a typo in one declaration should not leave the
  // site half-cleaned.
  const relative = paths.map(normaliseResiduePath);
  const root = await wpRootDir(transport);
  const targets = relative.map((path) => posix.join(root, path));

  const survivors = await removeEach(targets, (file, args) =>
    exec(transport, file, args),
  );
  if (survivors.length === 0) return;

  // Probed only now: a clean cell should not pay a round-trip asking about privileges it never needs.
  const elevation = await elevationSupport(transport);
  if (elevation !== "available") {
    throw new SiteResidueRemovalFailedError(survivors, elevation);
  }

  for (const target of survivors) {
    assertSafeElevatedRemoval(target, root);
  }
  const stubborn = await removeEach(survivors, (file, args) =>
    execElevated(transport, file, args),
  );
  if (stubborn.length > 0) {
    throw new SiteResidueRemovalFailedError(stubborn, elevation);
  }
}
