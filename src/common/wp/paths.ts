import { posix } from "node:path";

/**
 * Path safety for anything this layer aims at a site's filesystem.
 *
 * Two guards live here, and they exist as one module for one reason: **both of them are the last
 * thing standing between a typo and a privileged `rm -rf` / `chown -R` on a real system path.** A
 * guard that is copied is a guard that drifts, so residue removal, data-directory preparation and
 * ownership normalisation all validate through this module rather than each keeping its own copy.
 *
 * The two halves are deliberately separate, because they check different things:
 *
 *  - {@link normaliseSitePath} constrains the **relative** half — that the path stays inside the
 *    WordPress root and does not name a directory WordPress itself owns. It is what stops
 *    `wp-content/uploads` (a dropped last segment) from standing in for one plugin's directory.
 *  - {@link assertSafeElevatedTarget} constrains the half the first one cannot see — that the
 *    **root** it is joined to is a plausible site root, and that joining the two really did stay
 *    inside it. Only elevated callers need it; unelevated ones already have the transport user's
 *    own permissions as a backstop.
 *
 * Neither guard is a security boundary against a hostile input — the declarations come from this
 * repository's own code and config. They are a boundary against a *mistake*, which on a host where
 * the suite can `sudo` is the more likely and the more expensive of the two.
 *
 * Each function takes the caller's own message builder rather than imposing one, so a failure reads
 * in the vocabulary of whatever was being attempted ("cannot be removed as leftover data" /
 * "cannot be used as an ownership target") and names the remedy that caller can actually offer.
 */

/**
 * Directories WordPress itself owns, which a declared path must never name.
 *
 * A guard against a typo in a config file — `wp-content/uploads` instead of
 * `wp-content/uploads/backwpup` would delete every media file on the site — not a security
 * boundary: the declarations come from our own code, and anything *below* these is fair game.
 */
export const PROTECTED_SITE_PATHS: readonly string[] = [
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
 * Validates one declared path against a site's WordPress root and returns it normalised.
 *
 * Deliberately **relative only**: such a path names something inside the WordPress install, and
 * requiring that shape is what keeps a stray leading `/` from turning a cleanup into a system-wide
 * `rm -rf`.
 *
 * @param declared - the path as it was declared, relative to the WordPress root.
 * @param describeRejection - builds the error message from the rule that was broken. The caller
 * owns the wording so the failure names *its* remedy; this module only decides what is invalid.
 * @returns the normalised path, still relative.
 * @throws Error built by `describeRejection`.
 *
 * @example
 * ```ts
 * normaliseSitePath(declared, (reason) => `[wp/residue] "${declared}" cannot be removed: ${reason}.`);
 * ```
 */
export function normaliseSitePath(
  declared: string,
  describeRejection: (reason: string) => string,
): string {
  const trimmed = declared.trim();
  const reason = sitePathRejection(trimmed);
  if (reason !== undefined) {
    throw new Error(describeRejection(reason));
  }
  return posix.normalize(trimmed).replace(/\/+$/, "");
}

/**
 * The rule `path` breaks, or `undefined` when it is a usable relative site path.
 *
 * @param path - the declared path, already trimmed.
 * @returns the reason it is unusable, phrased to follow "it …", or `undefined` when it is fine.
 */
function sitePathRejection(path: string): string | undefined {
  if (path === "") return "it is empty";
  if (path.includes("\\")) {
    return "it contains a backslash; target paths are always POSIX";
  }
  if (posix.isAbsolute(path)) {
    return "it is absolute, and site paths are resolved against the site's WordPress root";
  }
  const normalised = posix.normalize(path).replace(/\/+$/, "");
  if (normalised === "." || normalised === "..") {
    return "it resolves to the WordPress root itself";
  }
  if (normalised.startsWith("../")) {
    return "it escapes the WordPress root";
  }
  if (PROTECTED_SITE_PATHS.includes(normalised)) {
    return `it resolves to "${normalised}", a directory WordPress itself owns`;
  }
  return undefined;
}

/**
 * Where a plugin's own files live, relative to the WordPress root.
 *
 * One place for the literal, because two different operations need it — installing a plugin and
 * then giving its files back to the site's user — and because it is composed into a path a
 * privileged command acts on. The slug must be a **single segment**: `posix.join` would happily
 * resolve `..` back out of `wp-content/plugins` into a directory WordPress owns, and while slugs
 * come from our own artifact manifests, a path headed for `chown -R` is not where to rely on that.
 *
 * @param slug - the plugin's directory name, e.g. `backwpup-pro`.
 * @returns the path, relative to the WordPress root.
 * @throws Error if `slug` is not a single path segment.
 */
export function pluginSitePath(slug: string): string {
  if (slug === "" || slug.includes("/") || slug === "." || slug === "..") {
    throw new Error(
      `[wp/paths] "${slug}" is not a usable plugin slug: it must be a single path segment, ` +
        'e.g. "backwpup-pro".',
    );
  }
  return posix.join("wp-content", "plugins", slug);
}

/**
 * The guard that matters once a command runs as **root**: a nonsense `rootDir` would otherwise aim a
 * privileged `rm -rf` or `chown -R` at a real system path.
 *
 * {@link normaliseSitePath} already constrains the relative half, so this checks the half it cannot
 * see: that the root is a plausible site root (absolute, at least two segments deep — `/tmp` and `/`
 * are not site roots), and that joining the two really did stay inside it. Unelevated callers are
 * left alone; there the transport's own permissions are the backstop, and tightening it would break
 * nothing an operator asked for.
 *
 * The containment check is made against the **normalised** target, so a caller that composed one by
 * hand cannot slip `..` past it. Every caller here builds the path with `posix.join`, which already
 * normalises — but this is exported, and a guard that only holds for careful callers is not one.
 *
 * @param target - the absolute path the privileged command would act on.
 * @param root - the site's WordPress root, as the transport resolved it.
 * @param describeRejection - builds the error message from the rule that was broken, so the failure
 * names the remedy the calling operation can offer.
 * @throws Error built by `describeRejection`.
 */
export function assertSafeElevatedTarget(
  target: string,
  root: string,
  describeRejection: (reason: string) => string,
): void {
  const trimmed = trimTrailingSlashes(root);
  const depth = trimmed.split("/").filter((segment) => segment !== "").length;
  const resolved = trimTrailingSlashes(posix.normalize(target));

  let reason: string | undefined;
  if (!posix.isAbsolute(trimmed)) {
    reason = "it is not an absolute path";
  } else if (depth < 2) {
    reason = "it is a filesystem or top-level system directory";
  } else if (!resolved.startsWith(`${trimmed}/`)) {
    reason = `"${target}" does not resolve inside it`;
  }

  if (reason !== undefined) {
    throw new Error(describeRejection(reason));
  }
}

/**
 * Drops trailing slashes, keeping a bare `"/"` intact.
 *
 * Written as a slice rather than `replace(/(?!^)\/+$/, "")`: that pattern is **quadratic** on a long
 * run of slashes (measured: 200 000 slashes took 14 s), and this is fed a `rootDir` straight from
 * configuration, before any normalisation has collapsed them.
 *
 * @param path - any path.
 * @returns the path without trailing slashes, or `"/"` if that is all it was.
 */
function trimTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 1 && path.charCodeAt(end - 1) === 47) end -= 1;
  return path.slice(0, end);
}
