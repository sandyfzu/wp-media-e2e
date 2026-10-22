import { posix } from "node:path";

import { assertResolvedInsideRoot, resolveOnTarget, wpRootDir } from "./exec";
import { PluginDirRemovalFailedError } from "./errors";
import { normaliseSitePath, pathInsideRoot, pluginSitePath } from "./paths";
import { evalPhp, phpLiteral } from "./php";
import { removeEscalating } from "./residue";
import { isObject } from "../guards";
import { plain } from "../text";
import type { Transport } from "../config/types";

/**
 * A plugin's folder as the site has it — which is not always what WordPress lists.
 *
 * WordPress removes a plugin entry by entry, never atomically (`WP_Filesystem_Direct::delete`, or
 * WP-CLI's `rm -rf`), so a removal stopped part-way — the QA servers restart PHP-FPM and reboot
 * several times a week — leaves part of the plugin at `<WP_PLUGIN_DIR>/<slug>`. Which part follows
 * the filesystem's directory order, so both shapes happen (measured on the two QA servers):
 *
 *  - **The main file gone, the rest kept.** WordPress lists nothing there, `wp plugin is-installed`
 *    says no, `wp plugin delete` says "already deleted" and leaves it, and every install aborts on
 *    "Destination folder already exists" — every scenario, until someone removes it by hand.
 *  - **The main file kept, `vendor` half gone.** WordPress lists the plugin, and its `uninstall.php`
 *    dies on a `require_once` of what is missing, so `wp plugin uninstall` fails and keeps it all.
 *
 * So "absent" here means **nothing at the plugin's path**, and {@link inspectPluginDir} tells the
 * three states apart in one read of the site. {@link removePluginDir} clears a folder by path, for
 * cleanup only: a removal under test judges what is left and never sweeps it.
 *
 * Only the slugs under test are ever looked at. A shared site holds other teams' folders WordPress
 * does not list either, and none of them is this suite's to judge or remove.
 */

/** Nothing at the plugin's path: not a folder, a file or a link. */
export interface AbsentPluginDir {
  readonly kind: "absent";
  /** Where the plugin would be — `WP_PLUGIN_DIR/<slug>`, as the site defines it. */
  readonly path: string;
}

/** Something at the plugin's path, and what it is. */
export interface PresentPluginDir {
  /**
   * `recognised` when WordPress lists a plugin in it (a `<slug>/<file>.php` key of `get_plugins()`,
   * the list `wp plugin is-installed` reads); `orphaned` when it does not.
   */
  readonly kind: "recognised" | "orphaned";
  /** Its absolute path, `WP_PLUGIN_DIR/<slug>` as the site defines it. */
  readonly path: string;
  /** What it is. A link is never followed: it is described, and removed, as a link. */
  readonly type: "directory" | "file" | "link";
  /** Where a link points, as written. */
  readonly target?: string;
  /**
   * How many entries lie below a folder, counted up to {@link ENTRY_COUNT_CAP}; absent for a file, a
   * link, or a folder the transport's user cannot read.
   */
  readonly entries?: number;
  /** Whether the folder holds more than {@link ENTRY_COUNT_CAP} entries, so {@link entries} is a floor. */
  readonly capped?: boolean;
  /** A folder's first top-level names, sorted, at most {@link SAMPLE_SIZE}. */
  readonly sample: readonly string[];
  /** How many top-level names a readable folder holds — more than {@link sample} shows, past its size. */
  readonly topLevel?: number;
  /** Its owner's name, or uid when the site cannot name it. */
  readonly owner: string;
  /** Seconds since it last changed, by the site's own clock. */
  readonly ageSeconds: number;
}

/** What is at a plugin's path. */
export type PluginDirState = AbsentPluginDir | PresentPluginDir;

/**
 * Entries counted before giving up — far above any real plugin (BackWPup Pro: 5 858) and cheap to
 * walk on the site, so a folder that is not a plugin at all still answers quickly.
 */
export const ENTRY_COUNT_CAP = 100_000;

/** Top-level names a description quotes: enough to recognise what survived, short enough to read. */
export const SAMPLE_SIZE = 8;

/**
 * The PHP that inspects each slug's path; it echoes one JSON object keyed by slug.
 *
 * `lstat`, so a link is seen as one and its target never walked. A slug is `recognised` when
 * `get_plugins()` — WordPress's own list, the one `wp plugin is-installed` reads — holds a plugin in
 * it: a header-bearing `.php` file directly inside the folder (`<slug>/<file>.php`). Not
 * `get_plugins( '/<slug>' )`, which also finds headers one folder deeper that WordPress never lists.
 * Exported so a spec can run it under real PHP.
 *
 * @param slugs - the plugin slugs, each a single path segment.
 * @param cap - entries counted before giving up; {@link ENTRY_COUNT_CAP} unless a spec needs it small.
 */
export function pluginDirPhp(
  slugs: readonly string[],
  cap: number = ENTRY_COUNT_CAP,
): string {
  return (
    `$slugs = ${phpLiteral(slugs)};\n` +
    `$cap = ${phpLiteral(cap)};\n` +
    `$sample_size = ${phpLiteral(SAMPLE_SIZE)};\n` +
    "if ( ! function_exists( 'get_plugins' ) ) {\n" +
    "\trequire_once ABSPATH . 'wp-admin/includes/plugin.php';\n" +
    "}\n" +
    // The folders WordPress lists a plugin in: each key is `<folder>/<file>.php`, or a bare file.
    "$listed = array_map( 'dirname', array_keys( get_plugins() ) );\n" +
    "$report = [];\n" +
    "foreach ( $slugs as $slug ) {\n" +
    "\t$path = WP_PLUGIN_DIR . '/' . $slug;\n" +
    "\tclearstatcache( true, $path );\n" +
    "\t$stat = @lstat( $path );\n" +
    "\tif ( false === $stat ) {\n" +
    "\t\t$report[ $slug ] = [ 'kind' => 'absent', 'path' => $path ];\n" +
    "\t\tcontinue;\n" +
    "\t}\n" +
    "\t$link = is_link( $path );\n" +
    "\t$dir = ! $link && is_dir( $path );\n" +
    "\t$owner = function_exists( 'posix_getpwuid' ) ? posix_getpwuid( $stat['uid'] ) : false;\n" +
    "\t$entry = [\n" +
    "\t\t'kind' => in_array( $slug, $listed, true ) ? 'recognised' : 'orphaned',\n" +
    "\t\t'path' => $path,\n" +
    "\t\t'type' => $link ? 'link' : ( $dir ? 'directory' : 'file' ),\n" +
    "\t\t'owner' => is_array( $owner ) ? $owner['name'] : (string) $stat['uid'],\n" +
    "\t\t'age' => time() - $stat['mtime'],\n" +
    "\t\t'sample' => [],\n" +
    "\t];\n" +
    "\tif ( $link ) {\n" +
    // `@`: a warning printed here would land in the JSON reply.
    "\t\t$entry['target'] = (string) @readlink( $path );\n" +
    "\t}\n" +
    "\t$names = $dir ? @scandir( $path ) : false;\n" +
    "\tif ( is_array( $names ) ) {\n" +
    "\t\t$names = array_values( array_diff( $names, [ '.', '..' ] ) );\n" +
    "\t\t$entry['top'] = count( $names );\n" +
    "\t\t$entry['sample'] = array_slice( $names, 0, $sample_size );\n" +
    "\t\t$count = 0;\n" +
    "\t\t$walk = new RecursiveIteratorIterator(\n" +
    "\t\t\tnew RecursiveDirectoryIterator( $path, FilesystemIterator::SKIP_DOTS ),\n" +
    "\t\t\tRecursiveIteratorIterator::SELF_FIRST,\n" +
    "\t\t\tRecursiveIteratorIterator::CATCH_GET_CHILD\n" +
    "\t\t);\n" +
    // One past the cap, so `capped` means strictly more than it, never exactly it.
    "\t\tforeach ( $walk as $unused ) {\n" +
    "\t\t\tif ( ++$count > $cap ) {\n" +
    "\t\t\t\tbreak;\n" +
    "\t\t\t}\n" +
    "\t\t}\n" +
    "\t\t$entry['entries'] = min( $count, $cap );\n" +
    "\t\t$entry['capped'] = $count > $cap;\n" +
    "\t}\n" +
    "\t$report[ $slug ] = $entry;\n" +
    "}\n" +
    "echo wp_json_encode( (object) $report );"
  );
}

/**
 * What is at each slug's path, in one `wp eval` — WordPress loaded without plugins or themes, so a
 * broken copy of the plugin under test cannot stop the question being answered.
 *
 * @param transport - the site to inspect.
 * @param slugs - the plugin slugs to look at; none asks nothing.
 * @returns each slug's state.
 * @throws Error if a slug is not a single path segment, the snippet failed, or its reply is not one
 * state per slug.
 */
export async function inspectPluginDirs(
  transport: Transport,
  slugs: readonly string[],
): Promise<ReadonlyMap<string, PluginDirState>> {
  if (slugs.length === 0) return new Map();
  // The same rule the install and the ownership handover apply, before the slug reaches the site.
  for (const slug of slugs) pluginSitePath(slug);
  const reply = await evalPhp(
    transport,
    pluginDirPhp(slugs),
    `inspecting the plugin folder(s) ${slugs.join(", ")}`,
    "wp/plugin-dir",
    { skipPlugins: true, skipThemes: true },
  );
  return parsePluginDirReport(reply, slugs);
}

/**
 * What is at one plugin's path — see {@link inspectPluginDirs}.
 *
 * @param transport - the site to inspect.
 * @param slug - the plugin's slug.
 * @throws what {@link inspectPluginDirs} throws.
 */
export async function inspectPluginDir(
  transport: Transport,
  slug: string,
): Promise<PluginDirState> {
  const state = (await inspectPluginDirs(transport, [slug])).get(slug);
  // Unreachable: the parser refuses a reply without every slug.
  if (state === undefined) {
    throw new Error(`[wp/plugin-dir] no state for "${slug}".`);
  }
  return state;
}

/**
 * Reads the reply of {@link pluginDirPhp} into one state per slug.
 *
 * @param reply - what the snippet printed.
 * @param slugs - the slugs it was asked about.
 * @throws Error if the reply is not JSON, or misses or garbles a slug's state.
 */
export function parsePluginDirReport(
  reply: string,
  slugs: readonly string[],
): ReadonlyMap<string, PluginDirState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    throw new Error(
      `[wp/plugin-dir] the inspection did not come back as JSON: ${reply.slice(0, 300) || "(empty)"}`,
    );
  }
  if (!isObject(parsed)) {
    throw malformed(reply);
  }
  const states = new Map<string, PluginDirState>();
  for (const slug of slugs) {
    const state = parseState(parsed[slug]);
    if (state === undefined) throw malformed(reply);
    states.set(slug, state);
  }
  return states;
}

/** The error for a reply that is JSON but not a state per slug. */
function malformed(reply: string): Error {
  return new Error(
    `[wp/plugin-dir] the inspection's reply is not one state per plugin: ${reply.slice(0, 300)}`,
  );
}

/**
 * One slug's state from the decoded reply, or `undefined` when it is not one.
 *
 * @param value - the slug's entry in the reply.
 */
function parseState(value: unknown): PluginDirState | undefined {
  if (!isObject(value) || typeof value.path !== "string") return undefined;
  const { kind, path } = value;
  if (kind === "absent") return { kind, path };
  if (kind !== "recognised" && kind !== "orphaned") return undefined;
  const { type, owner, age, sample, target, entries, capped, top } = value;
  if (
    (type !== "directory" && type !== "file" && type !== "link") ||
    typeof owner !== "string" ||
    !Number.isInteger(age) ||
    !Array.isArray(sample) ||
    !sample.every((name) => typeof name === "string")
  ) {
    return undefined;
  }
  return {
    kind,
    path,
    type,
    owner,
    ageSeconds: Math.max(0, age as number),
    sample,
    ...(typeof target === "string" ? { target } : {}),
    ...(Number.isInteger(entries) ? { entries: entries as number } : {}),
    ...(Number.isInteger(top) ? { topLevel: top as number } : {}),
    ...(capped === true ? { capped } : {}),
  };
}

/**
 * Removes whatever is at a plugin's path, by path — cleanup's last resort for a folder WordPress
 * cannot remove, never a removal under test.
 *
 * Inspects first and acts only on what that finds: nothing there is nothing to do, and a plugin
 * WordPress lists is refused unless `options.recognised` says its own uninstall was already tried
 * and failed. The path is the one the site defines, held inside the WordPress root: lexically
 * (`normaliseSitePath`), then where its parent really leads (`assertResolvedInsideRoot` — the parent,
 * because a link at the slug is removed as a link, never followed). Removed as the transport's user
 * first, then with privileges for what survived ({@link removeEscalating}), and verified by
 * inspecting again.
 *
 * @param transport - the site to clean.
 * @param slug - the plugin's slug, a single path segment.
 * @param options - `recognised: true` also removes a plugin WordPress lists — only after its uninstall
 * failed.
 * @returns what was there before removal, or `undefined` when nothing was.
 * @throws Error if the slug or the path is unusable, if WordPress lists a plugin there and
 * `options.recognised` is not set, or {@link PluginDirRemovalFailedError} naming what is still there.
 */
export async function removePluginDir(
  transport: Transport,
  slug: string,
  options: { readonly recognised?: boolean } = {},
): Promise<PresentPluginDir | undefined> {
  const found = await inspectPluginDir(transport, slug);
  if (found.kind === "absent") return undefined;
  if (found.kind === "recognised" && options.recognised !== true) {
    throw new Error(
      `[wp/plugin-dir] refusing to remove "${found.path}" by path: WordPress lists a plugin there, ` +
        "and removing it is its own uninstall's job.",
    );
  }

  const root = await rootHolding(transport, found.path);
  const target = targetInsideRoot(found.path, slug, root);
  await assertResolvedInsideRoot(
    transport,
    posix.dirname(target),
    root,
    describeRefusal(found.path),
  );
  const removal = await removeEscalating(transport, root, [target]);

  const after = await inspectPluginDir(transport, slug);
  if (after.kind !== "absent") {
    throw new PluginDirRemovalFailedError(
      after.path,
      describePluginDir(after),
      removal.kind === "left" ? removal.elevation : undefined,
    );
  }
  return found;
}

/**
 * The WordPress root `path` is written under: the site's `rootDir` as configured, or — when that is a
 * link — the path it really leads to. The site names `WP_PLUGIN_DIR` from `ABSPATH`, which WP-CLI
 * takes from its working directory with every link resolved, so a symlinked `rootDir` never prefixes
 * it. Resolved only then: an ordinary root costs no round-trip.
 *
 * @param transport - the site.
 * @param path - the folder's path as the site reported it.
 * @returns the root `path` lies under.
 * @throws Error if it lies under neither.
 */
async function rootHolding(
  transport: Transport,
  path: string,
): Promise<string> {
  const root = await wpRootDir(transport);
  if (pathInsideRoot(path, root) !== undefined) return root;
  const resolved = await resolveOnTarget(transport, root);
  if (resolved !== undefined && pathInsideRoot(path, resolved) !== undefined) {
    return resolved;
  }
  const really =
    resolved !== undefined && resolved !== root ? `, really "${resolved}"` : "";
  throw new Error(
    describeRefusal(path)(
      `it does not lie inside the WordPress root ("${root}"${really})`,
    ),
  );
}

/**
 * The absolute path removal acts on, after the lexical guards: inside the root, not a directory
 * WordPress owns, and named by the slug itself.
 *
 * @param path - the folder's path as the site reported it.
 * @param slug - the plugin's slug.
 * @param root - the WordPress root it lies under ({@link rootHolding}).
 * @throws Error naming the rule broken.
 */
function targetInsideRoot(path: string, slug: string, root: string): string {
  const describe = describeRefusal(path);
  const relative = pathInsideRoot(path, root);
  if (relative === undefined) {
    throw new Error(
      describe(`it does not lie inside the WordPress root ("${root}")`),
    );
  }
  const normalised = normaliseSitePath(relative, describe);
  if (posix.basename(normalised) !== slug) {
    throw new Error(describe(`it is not named by the slug "${slug}"`));
  }
  return posix.join(root, normalised);
}

/** The wording for a plugin folder that cannot be removed by path. */
function describeRefusal(path: string): (reason: string) => string {
  return (reason) =>
    `[wp/plugin-dir] refusing to remove the plugin folder "${path}": ${reason}. Remove it by hand, ` +
    "or fix `WP_PLUGIN_DIR` or the site's `rootDir`.";
}

/**
 * One line saying what is at a plugin's path — for reports, errors and the pre-flight check. Plain
 * text: a name on the site may hold a newline or an escape sequence, and none may break the line.
 *
 * @example
 * ```ts
 * describePluginDir(found);
 * // "/srv/site/wp-content/plugins/backwpup-pro: a folder WordPress lists no plugin in, 3830 entries
 * //  (assets, config, inc, pro, src, vendor); owner www-data; last changed 2 h ago"
 * ```
 *
 * @param dir - what the inspection found at the path.
 */
export function describePluginDir(dir: PresentPluginDir): string {
  return plain(
    `${dir.path}: ${describeWhat(dir)}; owner ${dir.owner}; ` +
      `last changed ${formatAge(dir.ageSeconds)} ago`,
  );
}

/** What a present path is, and what it holds. */
function describeWhat(dir: PresentPluginDir): string {
  const listed =
    dir.kind === "recognised"
      ? "WordPress lists a plugin in"
      : "WordPress lists no plugin in";
  if (dir.type === "link") {
    return `a link to "${dir.target ?? "?"}" (${listed} it)`;
  }
  if (dir.type === "file") return "a file, not a folder";
  const what = `a folder ${listed}`;
  if (dir.entries === undefined) return `${what}, its contents unreadable`;
  if (dir.entries === 0) return `${what}, empty`;
  const count = `${dir.capped === true ? "over " : ""}${String(dir.entries)} entries`;
  const unshown = (dir.topLevel ?? dir.sample.length) - dir.sample.length;
  const more = unshown > 0 ? `, … ${String(unshown)} more` : "";
  return `${what}, ${count} (${dir.sample.join(", ")}${more})`;
}

/**
 * A duration, rounded to the unit a person reads it in.
 *
 * @param seconds - a non-negative number of seconds.
 */
export function formatAge(seconds: number): string {
  if (seconds < 90) return `${String(Math.round(seconds))} s`;
  if (seconds < 90 * 60) return `${String(Math.round(seconds / 60))} min`;
  if (seconds < 48 * 3600) return `${String(Math.round(seconds / 3600))} h`;
  return `${String(Math.round(seconds / 86_400))} days`;
}
