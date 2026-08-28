import { posix } from "node:path";

import {
  describeTarget,
  elevationSupport,
  exec,
  execElevated,
  assertResolvedInsideRoot,
  wpRootDir,
} from "./exec";
import { normalizeOwnership } from "./ownership";
import { assertSafeElevatedTarget, normaliseSitePath } from "./paths";
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
 * creates under its own umask locks the other out, and one created by WP-CLI is additionally owned
 * by the wrong user entirely. {@link prepareSiteDataDirs} settles both up front — mode *and*
 * ownership — instead of leaving it to whichever happened to write first.
 *
 * Which paths a product leaves is the product's own knowledge, so it declares them
 * (`ProductConfig.siteResidue`) and the shared scenario hooks read them from the per-process
 * registry. This module only knows how to prepare and remove such a path safely on any transport.
 */

/**
 * Validates one declared residue path and returns it normalised.
 *
 * The rules — relative, inside the root, never a directory WordPress itself owns — are shared with
 * every other privileged operation and live in {@link normaliseSitePath}; this only supplies the
 * wording, so a bad declaration is reported in the vocabulary of the thing that would have happened
 * to it.
 *
 * @param declared - the path as the product declared it, relative to the WordPress root.
 * @returns the normalised path, still relative.
 * @throws Error naming the path and the rule it broke.
 */
export function normaliseResiduePath(declared: string): string {
  return normaliseSitePath(
    declared,
    (reason) =>
      `[wp/residue] "${declared}" cannot be removed as leftover data: ${reason}. Declare a path ` +
      'relative to the WordPress root that the product itself created, e.g. "wp-content/uploads/<plugin>".',
  );
}

/** Runs one command against the site — either as the transport's user, or with privileges. */
type Runner = (file: string, args: string[]) => Promise<ExecResult>;

/**
 * Mode the data directories are opened to. World-writable, and deliberately so.
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
 *
 * It is a **floor, not the whole answer**: it makes the directory writable by both users but leaves
 * it owned by whichever created it, and says nothing about a subtree an earlier run left behind.
 * {@link normalizeOwnership} supplies both, so this stays the one bit that grant cannot infer — the
 * cheap guarantee that holds even on a site whose ownership cannot be corrected at all.
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
 * **Three steps, and each does something the previous one cannot.** `mkdir` settles who creates the
 * directory; {@link DATA_DIR_MODE} makes it writable by both users whatever happens next; and
 * {@link normalizeOwnership} hands it to the ownership the *site* uses. The third is not decoration
 * on the second: this suite writing into a site's docroot as the transport's user is precisely what
 * that primitive exists for, and its grant is **recursive**, so it also reaches a subtree the mode
 * above cannot — one an earlier scenario's plugin wrote as the web server, or one the plugin's own
 * activation created a moment ago as WP-CLI. Ownership correction is best-effort by contract, which
 * is why the mode is applied independently rather than left to it.
 *
 * @param transport - the target site's transport.
 * @param paths - the product's declared paths, as {@link removeSiteResidue} takes them. Empty does
 * nothing at all, not even resolving the root.
 * @throws Error if a declared path is not a usable residue path (see {@link normaliseResiduePath}),
 * if the root is unusable for a privileged step (see {@link assertSafeElevatedTarget}), if a path is
 * a symbolic link rather than a directory, or if a directory can be neither created nor opened to
 * both users. Handing over ownership never throws; a host that cannot do it is warned about.
 */
export async function prepareSiteDataDirs(
  transport: Transport,
  paths: readonly string[],
): Promise<void> {
  if (paths.length === 0) return;
  // Validated before the site is touched at all, so a typo in one declaration cannot leave the
  // others half-prepared.
  const relative = paths.map(normaliseResiduePath);
  const root = await wpRootDir(transport);

  for (const path of relative) {
    await prepareOneDataDir(transport, root, path);
  }
}

/**
 * The three steps for one declared path: make it exist, open it, hand it over.
 *
 * @param transport - the target site's transport.
 * @param root - the site's resolved WordPress root.
 * @param path - one already-normalised declared path, relative to that root.
 * @throws Error if the root is unusable for a privileged step, if the path is a symbolic link, or if
 * the directory can be neither created nor opened to both users. Handing over ownership never
 * throws.
 */
async function prepareOneDataDir(
  transport: Transport,
  root: string,
  path: string,
): Promise<void> {
  const target = posix.join(root, path);
  // Preparation escalates, so it needs the same root guard removal has: `normaliseResiduePath`
  // constrains the relative half, and this is the half it cannot see. Without it a site whose
  // `rootDir` is a top-level directory would have world-writable directories created **as root**
  // at the filesystem root — and teardown would then refuse to remove what setup created.
  const describe = (reason: string): string =>
    `[wp/residue] refusing to prepare the plugin's data directories: this site's WordPress root ` +
    `("${root}") cannot be used for it — ${reason}. Preparation may need privileges, so it will ` +
    "not aim one at a path it cannot place inside the site; fix the site's `rootDir`, or declare a " +
    "data path that stays within it.";
  assertSafeElevatedTarget(target, root, describe);
  // The guard above compares strings; this one asks the filesystem. A symlink **anywhere** in the
  // path — `wp-content/uploads` relocated, not just the last component — would otherwise let a
  // privileged `chmod 0777` and, later, a privileged `rm -rf` act outside the site while every
  // lexical check agreed. Measured: content outside the root was removed that way. Checked before
  // `mkdir`, which happily follows a linked parent and would hide it.
  await assertResolvedInsideRoot(transport, target, root, describe);
  // `--` ends option parsing, as the ownership commands do. The guard above already proves
  // `target` is absolute so it cannot begin with a dash — this keeps that from being the only
  // thing standing between a future refactor and a flag.
  await escalateIfDenied(transport, "mkdir", ["-p", "--", target]);
  await escalateIfDenied(transport, "chmod", ["--", DATA_DIR_MODE, target]);
  // Last, so the grant is applied while the directory is still ours to change: normalising first
  // would hand it to the site's user and make the mode above need privileges it did not need.
  await normalizeOwnership(transport, path);
}

/**
 * Runs `file args…` as the transport's user, retrying with privileges if it was refused.
 *
 * Used for the preparation steps above, where a non-zero exit means "not permitted" rather than a
 * legitimate answer. Reports the *unprivileged* failure when escalation is unavailable or also fails,
 * because that is the one an operator can act on.
 *
 * @param transport - the target site's transport.
 * @param file - the command to run.
 * @param args - its arguments, as an array so nothing is shell-interpreted.
 * @throws Error naming the site, the command, the path and how far privileges reached.
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
    `[wp/residue] ${describeTarget(transport)}: could not \`${file} ${args.join(" ")}\` ` +
      `(exit ${String(first.exitCode)}: ${(first.stderr || first.stdout).trim() || "no output"}; ` +
      `elevation: ${elevation}). The plugin's data directories must be writable by both the ` +
      "transport's user and the web server, which share this site's docroot — grant the transport's " +
      "user passwordless `sudo`, or make the parent directory writable by it.",
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
 *
 * @param targets - absolute paths to remove.
 * @param run - how to run one command, at the privilege this pass uses.
 * @returns the targets still present afterwards.
 */
async function removeEach(
  targets: readonly string[],
  run: Runner,
): Promise<string[]> {
  const survivors: string[] = [];
  for (const target of targets) {
    await run("rm", ["-rf", "--", target]);
    // `test` takes no options, so `--` would be read as an operand; the target is absolute
    // (the guards proved it) and so cannot be mistaken for one either way.
    const { exitCode } = await run("test", ["-e", target]);
    if (exitCode === 0) survivors.push(target);
  }
  return survivors;
}

/**
 * Refuses a privileged `rm -rf` whose WordPress root is not a plausible site root.
 *
 * The rule is shared with every other elevated operation ({@link assertSafeElevatedTarget}); this
 * only supplies the wording, so an operator is told which of *this* operation's knobs fixes it.
 *
 * @param target - the absolute path the privileged `rm -rf` would act on.
 * @param root - the site's resolved WordPress root.
 * @throws Error naming the value and the rule it broke.
 */
/** The wording removal uses when a path cannot be placed inside the site, shared by both guards. */
function describeRemoval(root: string): (reason: string) => string {
  return (reason) =>
    `[wp/residue] refusing to remove leftover data: this site's WordPress root ("${root}") cannot ` +
    `be used for it — ${reason}. Fix the site's \`rootDir\`, or declare a residue path that stays ` +
    "inside the site.";
}

function assertSafeElevatedRemoval(target: string, root: string): void {
  assertSafeElevatedTarget(
    target,
    root,
    (reason) =>
      `[wp/residue] refusing to remove leftover data with elevated privileges: this site's ` +
      `WordPress root ("${root}") cannot be used for it — ${reason}. Fix the site's \`rootDir\`, ` +
      "or set `transport.elevate: false` to keep cleanup unprivileged.",
  );
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

  // Before **either** pass, not just the privileged one. A path that resolves outside the site must
  // not be removed at any privilege: "unprivileged" is only a bound while the transport's user is
  // not root, which a `docker` container or a root SSH login does not guarantee — and deleting
  // another part of the filesystem is wrong either way. Measured before this existed: a symlinked
  // `wp-content/uploads` let `rm -rf` remove content outside the WordPress root.
  for (const target of targets) {
    await assertResolvedInsideRoot(
      transport,
      target,
      root,
      describeRemoval(root),
    );
  }

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
