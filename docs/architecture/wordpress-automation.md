# WordPress automation layer

The `src/common/wp/` modules drive a WordPress site over WP-CLI, independent of
how the site is reached. Everything here is **transport-agnostic**: the same code
works whether the site is local, in Docker, or behind SSH.

## Transport & exec ([`wp/exec.ts`](../../src/common/wp/exec.ts))

A [`Transport`](../../src/common/config/types.ts) describes how WP-CLI reaches a
site, discriminated on `mode`:

| Mode     | Fields                                                                      | Dispatch                                        |
| -------- | --------------------------------------------------------------------------- | ----------------------------------------------- |
| `local`  | `rootDir`, `stagingDir?`, `elevate?`, `fileOwner?`                                      | `execa`, run in `rootDir`.                      |
| `docker` | `container`, `rootDir?`, `stagingDir?`, `elevate?`, `fileOwner?`                        | `docker exec <container> …` (see `dockerArgv`). |
| `ssh`    | `host`, `username`, `privateKeyPath`, `rootDir`, `stagingDir?`, `elevate?`, `fileOwner?` | `node-ssh` (its `exec` shell-escapes the args). |

Key design points:

- A command is always a **file + array of args** — never a shell string — so there
  is no shell interpolation and no injection surface.
- `exec(transport, file, args, opts?)` returns a structured
  [`ExecResult`](../../src/common/wp/exec.ts) `{ exitCode, stdout, stderr }`.
  Callers branch on `exitCode` (e.g. WP-CLI `is-installed`) rather than relying on
  thrown errors.
- A failure to *run the command at all* (missing binary, unreachable host, killed
  by signal) **throws** — that is an environment fault, not a command outcome.
- `wpCli(transport, args, opts?)` is the primary entry point: it runs `wp …`
  through the transport.
- **Every command runs with the WordPress root as its working directory** on all
  three modes (`rootDir` for `local`/`ssh`; the container `WORKDIR` for `docker`),
  so a relative path means the same thing everywhere.
- SSH connections are cached per endpoint and reused. Call `disposeConnections()`
  from a worker-teardown fixture to close them.

### Elevated housekeeping

Some cleanup genuinely cannot be done as the transport's user. A plugin writes files as the
**web-server** user, and when it also creates a directory only that user can write — BackWPup's
restore area is `0755 www-data`, from Monolog's `mkdir` under the default umask — nothing else can
unlink inside it. An unprivileged `rm -rf` exits 1, the directory survives, and the site keeps a
copy of its own database dump from every scenario that ever ran.

So the layer offers `execElevated(transport, file, args, opts?)`, plus
`elevationSupport(transport)` so a caller can ask before relying on it
(`available` / `unavailable` / `disabled`). Per mode:

| Mode            | How                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------- |
| `local`, `ssh`  | `sudo -n -- <file> <args…>` (see `sudoArgv`).                                              |
| `docker`        | `docker exec -u 0:0 …` — the `wordpress:cli` image ships no `sudo`, and the daemon is root. |

The limits are what make a test suite holding root uninteresting:

- **Housekeeping only** — removing leftover files, clearing `debug.log`. **Never `wp`**: WP-CLI
  refuses to run as root without `--allow-root`, and files it created as root would afterwards be
  unwritable by the web server, so the suite would break the site it is testing. `wpCli` has no way
  to request elevation, which makes that rule structural rather than a convention.
- **Never on a path a scenario asserts against.** Elevation cannot make a product behaviour pass; it
  only removes what the product left behind, after the verdict is in.
- **Second, never first.** Callers try as themselves and escalate only what demonstrably failed, so a
  correctly-permissioned host never runs a privileged command — not even the capability probe. The one
  exception is ownership normalisation, whose `chmod` **and** `chown` are elevated without an
  unprivileged attempt: only a file's owner or root may `chown` it, and by then the owner is known
  not to be us, so trying first would be a round-trip whose answer is already decided. It still asks
  nothing of a host that does not need it — the decision is made before the capability probe, and a
  transport user that already owns the install returns without running either (see
  [File ownership](#file-ownership-wpownershipts)).
- **Never interactive.** `sudo -n` fails immediately instead of waiting on a password nobody will
  type, and `--` stops sudo parsing the target command's own flags.
- **Refusable per site** (`transport.elevate: false`), which `execElevated` enforces by throwing
  rather than trusting each caller to have checked. The probe result is cached per target, and the
  first actual use is announced once so a privileged run is never silent.

The module also owns the **file-transfer** primitives, because they need the same
per-mode dispatch and the same cached SSH connection:

- `wpRootDir(transport)` → the **absolute** WordPress root on the target. Declared
  for `local`/`ssh`; for `docker` it is the container `WORKDIR`, read once with
  `pwd` and cached per container (declare `rootDir` on the transport to skip that).
- `copyIntoTarget(transport, localAbs, targetAbs)` — copies a runner file onto the
  target, overwriting: `node:fs` copy (`local`), `docker cp` (`docker`, a top-level
  sub-command — see `dockerCpArgv`), SFTP `putFile` (`ssh`). It does **not** create
  the parent directory; the staging layer below does that first.
- `isSymlink(transport, absolutePath)` — one unprivileged `test -L`. A missing path answers `false`,
  which is the right answer for one about to be created; a transport that could not be asked throws,
  so "could not check" is never read as "not a link". Used by the two callers that are about to
  `chmod` as root — see [Symlinks](#symlinks).

## Playwright ≥ 1.62 is a floor, not a preference

**Do not downgrade below 1.62.** On 1.61 a WordPress admin save — the ordinary
post/redirect/get an options screen does — could leave the tab **permanently unable to produce
frames**: `requestAnimationFrame` dropped to 0 and never recovered, not on the next navigation and
not on a reload. Only a new tab was clean.

That silently disabled every Playwright primitive that needs a frame, while the ones that read the
DOM kept working — which is why it masqueraded as a locator problem:

| Primitive                                | Needs a frame | On a wedged tab                     |
| ---------------------------------------- | ------------- | ----------------------------------- |
| `click()` (actionability's `stable` step) | yes — an unbounded `rAF` loop with no internal timeout | never dispatches; burns the budget |
| `toBeInViewport()`                        | yes — `IntersectionObserver` + an `rAF` nudge          | never returns an answer            |
| `page.screenshot()`, video                | yes                                                     | hangs / records nothing            |
| `toBeVisible()`, text, counts, `evaluate` | no — synchronous layout reads                           | answer instantly                   |

The cause was Chromium's **`RenderDocument`**, which Playwright 1.61 put in its `--disable-features`
list as a temporary fix for its own CI bots (microsoft/playwright#37715, tracked by #37714 —
*"[internal] re-enable RenderDocument"*). Chromium fixed the underlying defect in **147+**, and
Playwright removed the line again in **1.62**; Puppeteer dropped theirs too. Verified on a real cell:
on 1.61 the chain wedges at the submit and `page.screenshot()` times out; on 1.62.1 the same chain
holds ~61 frames/0.5s throughout and screenshots take ~35 ms. No launch flag is involved either way.

**The trigger is not fully characterised.** It reproduces reliably against a real site, but a
synthetic POST → 302 → GET does not wedge — not across added latency, nor with composited,
fixed-position or large source documents — and `wp-login.php`'s own POST → redirect never wedged
either. So it needs something the real environment supplies that we did not isolate. This is
recorded because it bounds the claim, not because anything is outstanding: the version floor removes
the cause regardless.

## Site staging & file transfer ([`wp/staging.ts`](../../src/common/wp/staging.ts))

WP-CLI reads files from the **site's** filesystem, so anything a test hands to `wp`
must exist there first: a plugin zip resolved on the runner is invisible to a
remote `wp`. Only a `local` transport shares a filesystem with the runner.

One directory per site holds those files, grouped by **category**:

```text
<WP root>/.e2e_temp/            ← lives on the SITE, not in the repo
├── plugins/<name>.zip          → wp plugin install
├── imports/<name>.xml          → wp import        (future)
└── <category>/<name>           → any artifact a test needs on the target
```

It sits at the WordPress root because that is already the exec working directory on
every transport, and it is **generic by design** — `plugins/` is just the first
category, so a future artifact type reuses the same transfer and cleanup.

| Function                                            | Purpose                                                                      |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `stageArtifact(transport, localPath, { category, as? })` | `mkdir -p` the category, copy the file in, return its **absolute target path**. |
| `stageAndInstallPlugin(transport, localZip, opts?)` | `stageArtifact(category: "plugins")` → `installPlugin` from the staged path, then **restores the installed plugin's ownership** when `opts.slug` is given (see [File ownership](#file-ownership-wpownershipts) — pass it). |
| `siteStagingDir(transport)`                         | The absolute staging directory for a site.                                   |
| `cleanSiteStaging(transport, category?)`            | `rm -rf` the whole area, or one category.                                    |
| `stagingPath(root, ...segments)`                    | Pure POSIX path builder; validates each segment.                             |

```ts
const artifact = pluginArtifact("plugin");
const zip = await stageAndInstallPlugin(site.transport, artifact.zipPath, {
  activate: true,
  // Pass it: without the slug there is no way to know which directory was unpacked,
  // and the plugin stays owned by the transport's user.
  slug: artifact.slug,
});
```

- **Location override**, for a host whose user cannot write the WordPress root or to
  keep staged files out of the web docroot: the site's own `transport.stagingDir`
  (absolute, or relative to the WP root) wins over the global
  `E2E_SITE_STAGING_DIR`, which wins over the `.e2e_temp` default. A failed
  `mkdir -p` names that override in the error.
- **Idempotent** — the copy overwrites, so re-staging and residue from a crashed
  run are both harmless.
- **Safe by construction.** `category` and the target filename must each be a single
  path segment (no `/`, no `..`), so a staged file cannot land outside the area; the
  local source must be an absolute path to an existing file, and the site's WordPress
  root must be absolute (a relative one would make SFTP stage into the login user's
  home directory). Because cleanup removes the area **whole**, the staging root is
  rejected when it resolves to the WordPress root or any ancestor of it (however
  spelled — an absolute `E2E_SITE_STAGING_DIR` equal to `rootDir` included), when it
  has fewer than two path segments (`/`, `/var`), or when a relative value escapes
  the WordPress root. Staging elsewhere is fine — write it as an absolute path.
- On a `local` site the runner and the target share a filesystem, so a file can be
  staged onto itself; that is detected (device + inode) and skipped rather than
  copied, since copying a file onto itself can truncate it.
- **Cleanup** — `cleanSiteStaging` throws on a genuine failure so a dirty site is
  visible, but a teardown hook should call it **best-effort** (catch + log) so
  cleanup never fails a passing scenario.
- **Concurrency** — one worker binds to one site per invocation, so no two workers
  write one site's staging area. Only an orchestrator overlapping pools on one host
  would need per-run namespacing.
- **Exposure** — on our environments the WP root *is* the web docroot, so
  `.e2e_temp/…` is potentially HTTP-reachable (occasionally useful: an artifact a
  plugin must fetch over HTTP). It is wiped in teardown; stage outside the docroot
  via the override when that matters.

## Plugin lifecycle ([`wp/plugin.ts`](../../src/common/wp/plugin.ts))

Removal runs `wp plugin uninstall`, **not** `wp plugin delete`: `delete` only removes
the plugin's files, leaving its database footprint (options, custom tables, cron
events) behind, whereas `uninstall` first runs the plugin's own uninstall procedure
(`uninstall.php` / `register_uninstall_hook()`) and then deletes the files. The net
effect is a clean baseline for the next scenario.

An active plugin is **deactivated as its own WP-CLI call first** — never
`uninstall --deactivate`. That flag does both in one PHP process, where the plugin's
main file is already `include`d and cannot be unloaded, so a well-behaved
`uninstall.php` sees itself as still loaded and skips its cleanup. A separate
`deactivate` means the following plain `uninstall` starts a fresh process that never
loads the plugin, so its guard passes and the cleanup actually runs.

Two removal intents are **deliberately separated** because they have opposite
correctness semantics:

| Function                               | Intent                           | Already-absent behaviour          |
| -------------------------------------- | -------------------------------- | --------------------------------- |
| `ensurePluginAbsent(transport, slug)`  | **Cleanup** (Before/After hooks) | Success (no-op).                  |
| `uninstallPlugin(transport, slug)`     | **Removal under test**           | Throws `PluginNotInstalledError`. |

`wp plugin uninstall` exits non-zero for *both* "not found" and a genuine failure,
so its exit code is not trusted — removal is always re-verified with `is-installed`
(exit `0` = installed, `1` = not); a plugin that survives throws
`PluginUninstallFailedError`. Other helpers:

- `isPluginInstalled` / `isPluginActive` — boolean state checks.
- `ensurePluginDeactivated(transport, slug)` — idempotent deactivation.
- `installPlugin(transport, source, opts?)` — install from slug, a zip path **on the
  site**, or URL; [`InstallPluginOptions`](../../src/common/wp/plugin.ts)
  `{ activate?, force? }`. For a zip that lives on the runner, use
  `stageAndInstallPlugin` (above) so it reaches the site first.
- `activatePlugin(transport, slug)`.

UI-driven plugin actions (the asserted, user-facing flow through wp-admin) live in
the [`PluginsPage`](../../src/common/pages/plugins.page.ts) page object instead —
see [authoring-tests.md](../guides/authoring-tests.md).

## Error types ([`wp/errors.ts`](../../src/common/wp/errors.ts))

Distinct classes so steps and reports can tell failure modes apart — including the
two that WP-CLI's ambiguous plugin-removal exit codes cannot, and the UI-only
activation/deactivation cases:

- `PluginNotInstalledError` — expected-present plugin is absent.
- `PluginActivationFailedError` / `PluginDeactivationFailedError` — UI action failed.
- `PluginUninstallFailedError` — plugin still installed after a WP-CLI `plugin uninstall`.
- `PluginDeletionFailedError` — plugin still installed after the admin-UI Delete action.
- `DebugLogFatalError` — PHP wrote a fatal to `debug.log` during a scenario. Not a plugin
  action at all: it carries every matched fatal and quotes the first few in its message,
  so the failure is diagnosable from the reporter alone.

## Debug-log scanning ([`wp/log.ts`](../../src/common/wp/log.ts))

Reads and categorises `wp-content/debug.log` to catch PHP errors a UI assertion
would miss. Transport-agnostic, with a resilient fallback:

- Reads/clears via WP-CLI `wp eval` (PHP inside WordPress, which resolves
  `WP_CONTENT_DIR` even when customised). But `wp eval` needs WordPress to **boot**
  — and the log matters most when a fatal has broken that boot. So on a non-zero
  `wp eval` exit it logs and **falls back** to a direct file read/removal that does
  not load WordPress.
- **`wp eval` exits 0 even when its PHP failed**, so the exit code alone is not a
  verdict. `debug.log` belongs to the web-server user and WP-CLI usually runs as
  someone else, so a denied write is just a warning and the command still "succeeds".
  Each snippet therefore reports its **own** outcome and `log.ts` trusts that: the
  clear prints `cleared`/`kept`, and a read that cannot open an existing log exits
  non-zero instead of returning `""`. Both matter — a log that never clears makes one
  scenario's fatal fail every later scenario, and a read that quietly yields `""`
  turns the fatal gate into a no-op.
- Clearing **removes** the file rather than truncating it: emptying needs write
  permission on the file (the web-server user's), unlinking needs it on the directory
  (usually the transport user's). WordPress recreates it on its next write. If it
  survives both routes, `clearDebugLog` throws rather than leave the gate unscoped.

API:

- `clearDebugLog(transport)` — call in a `Before` hook to scope a scenario.
- `readDebugLog(transport)` — raw contents (`""` if absent).
- `scanDebugLog(transport, opts?)` → [`DebugLogScan`](../../src/common/wp/log.ts)
  `{ raw, fatals, warnings, notices }`, categorised by PHP severity tier.

[`ScanDebugLogOptions`](../../src/common/wp/log.ts):

- `ignore` — patterns excluded from all categories (known-benign noise; add only
  patterns confirmed from real runs, never guessed).
- `source` — restrict categorisation to lines matching these patterns (typically a
  plugin's path), so a scan attributes entries to one plugin. `raw` always holds
  the complete log regardless of `source`.

Per-product presets live in `src/projects/<product>/support/debug-log.ts`:

- `*_LOG_OPTIONS` — scan **every** source (catch fatals from anywhere).
- `*_OWN_LOG_OPTIONS` — restricted to that plugin's own entries (BackWPup matches
  both Free and Pro paths, since only the installed edition's path appears).

**Most scenarios need none of this directly.** A product declares its preset as
`ProductConfig.debugLog`, and the shared `@plugin` hooks clear the log before a scenario
and judge it afterwards — a fatal fails the scenario with the log attached (see
[CLAUDE.md → Shared scenario hooks](../../CLAUDE.md#shared-scenario-hooks)). Call
`scanDebugLog` yourself only when a **step** must assert about the log, e.g. with
`*_OWN_LOG_OPTIONS` to disregard unrelated core/plugin noise:

```ts
import { scanDebugLog } from "../../../common/wp/log";
import { WP_ROCKET_OWN_LOG_OPTIONS } from "../support/debug-log";

const scan = await scanDebugLog(site.transport, WP_ROCKET_OWN_LOG_OPTIONS);
expect(scan.warnings).toEqual([]);
```

## Worker teardown ([`wp/teardown.ts`](../../src/common/wp/teardown.ts))

`releaseSite(site)` releases everything a worker acquired on its bound site: it removes the
staging area, then closes pooled SSH connections. It runs automatically once per worker via
the `releaseBoundSite` fixture, so no scenario has to remember it.

- **Best-effort by design.** Every assertion is already made by the time it runs, so a
  staging-removal failure is warned about, never thrown — cleanup must not turn a passing
  run red. Connections are closed either way (a leaked SSH client keeps the worker process
  alive after the run).
- **Unconditional, not tracked**, so residue a *crashed* run left behind is removed too —
  that is what makes "a re-run leaves nothing on the site" true even after a kill.
- **Placeholder sites are skipped**: they have no reachable transport, so cleaning one
  would only warn on every fresh-checkout run.

## Left-over plugin data ([`wp/residue.ts`](../../src/common/wp/residue.ts))

Uninstalling a plugin removes its code and — if it implements `uninstall.php` properly — its
database footprint. It does **not** remove the files the plugin wrote while running, and generally
should not: those are the user's data. For a suite that installs the plugin afresh every scenario
that is a leak. BackWPup is the extreme case: its uninstall touches no files at all and each
install writes under a new randomly-named directory, so the site collects a complete archive of
itself per scenario (measured on the QA cell before this existed: **6.8 GB across 28 directories**).

- A product declares what it leaves as `ProductConfig.siteResidue` — paths relative to the
  WordPress root — and the shared `@plugin` teardown clears them after every tagged scenario. The
  hooks read the list from the per-process registry, so they never import product code.
- `removeSiteResidue(transport, paths)` validates every path **before** removing any (so a typo
  cannot leave the site half-cleaned), then removes each and **confirms it is gone** rather than
  trusting `rm -rf`'s exit code. Every path is attempted even if an earlier one fails, and the
  error names all the survivors.
- It runs in **two passes**: everything as the transport's own user, then whatever survived
  [with privileges](#elevated-housekeeping). That order is the point — a host whose permissions are
  already right never runs a privileged command, while a host where the web-server user owns the
  data still ends up clean. Before a privileged `rm -rf`, the site's `rootDir` must itself be
  plausible (absolute, not a top-level directory, and the target must resolve inside it): the
  relative half is already constrained by `normaliseResiduePath`, and this is the half it cannot see.
- `normaliseResiduePath` rejects anything that is not a path below the root — absolute, escaping,
  or naming a directory WordPress itself owns (`wp-content/uploads` and friends). It guards against
  a typo in a config file, not against a hostile one.
- `prepareSiteDataDirs(transport, paths)` is the other half, run by the **Before** hook over the same
  declared list: per path it creates the directory, opens it to every user sharing the docroot
  (`0777`), then hands it to the site's ownership through `normalizeOwnership` — the same primitive
  the plugin install uses, because this too writes into the docroot as the transport's user. The mode
  is a floor that holds even where ownership cannot be corrected; the correction adds the owner and,
  where it has anything to do, is **recursive**, so it reaches a subtree the mode cannot (one an
  earlier scenario wrote as the web server, or one the plugin's activation just created as WP-CLI).
  On a site whose transport user already owns the install — the `docker` case — the correction is
  `unnecessary` and only the mode applies. Ownership correction is best-effort either way, so a host
  that refuses it still gets prepared directories.
  It escalates when the transport's user is refused, so it runs the **same root-plausibility guard**
  removal does — and refuses a path that is a symlink, since the `chmod` would otherwise follow it
  out of the tree as root — before doing so — otherwise a site whose `rootDir` was a top-level directory would
  have world-writable directories created as root at the filesystem root, which teardown would then
  refuse to remove.
  On a real cell **WP-CLI and the web server are different users** — `ubuntu` over SSH, `www-data`
  under PHP-FPM — and the plugin creates these directories under whichever umask it happens to be
  running with, so the first writer locks the other one out of a directory they must both write.
  Observed on the QA cell the day removal started working: `uploads/backwpup-restore` created
  `drwxrwxr-x ubuntu:ubuntu` by a WP-CLI call at 15:38:49, and the plugin's next admin request dead at
  15:38:50 on `Folder "…/backwpup-restore" is not writable` (`BackWPup_File::check_folder`). It had
  been invisible for as long as removal was failing, because the copy the web server made months
  earlier never went away. `0777` is what the plugin asks for itself (`mkdir($dir, 0777, true)`,
  narrowed only by the umask) and what `wp_mkdir_p` would produce, since it inherits the mode of
  `wp-content/uploads` — already `0777` on these cells for the same reason.

**Removal is best-effort against permissions, and strict about everything else.** Reaching a
survivor now means privileges did not close the gap either — the site cannot escalate (no
passwordless `sudo`, or `elevate: false`), or something other than permissions is holding the path.
The error says which, because "make it writable" is useless advice once the delete has already run as
root. That is a fact about the cell, it breaks no later scenario, and it is reported (console warning
plus an `uncleared-site-data` report attachment) rather than failing the run. A path that is not a
usable declaration, an implausible `rootDir` for a privileged delete, or a transport that cannot run
a command, still throws.

## Left-over plugin footprint ([`wp/db-residue.ts`](../../src/common/wp/db-residue.ts))

The mirror image of the section above. A plugin's uninstall keeps the *files* it wrote on purpose;
it clears its *database* footprint properly — but that cleanup lives in the plugin's own
`uninstall.php`, so it only ever runs **while the plugin's files are still there**.

`ensurePluginAbsent` is gated on `wp plugin is-installed`, which is a **file** test. So a site whose
plugin directory has gone while its rows remain looks already-clean, the uninstall block is skipped,
and the next install lands on top of the previous run's state. Measured on `pro@apache` with
BackWPup: `wp plugin uninstall <slug> --deactivate` — the one call [the plugin
lifecycle](#plugin-lifecycle-wpplugints) forbids, precisely because the plugin's own guard then
skips its cleanup — deletes the files and leaves **26 options and `wp_bwpup_backups`** behind. The
next run then fails in the product's own setup with *"a freshly installed BackWPup should owe its
onboarding"*, because the plugin reads its leftover `backwpup_version`, concludes it is an upgrade
rather than a first install, and never sets the onboarding flag.

So the sweep keys off the **footprint**, never off whether the plugin is installed.

- A product declares it as `ProductConfig.siteDbResidue` — `optionsContaining` (fragments of option
  names) and `tables` (unprefixed) — and the shared `@plugin` hooks sweep it whenever they find it.
  Read from the per-process registry, so the hooks never import product code.
- **Fragments match anywhere in a name, not as a prefix.** A plugin's transients are options whose
  names it does not begin: BackWPup's `backwpup_<jobid>_gdrive` is stored as
  `_site_transient_backwpup_<jobid>_gdrive`, observed on a cell during an ordinary scenario. They are
  matched *literally* — `%` and `_` are escaped with `esc_like` — so a fragment can only ever mean
  itself.
- **Ordering is the guarantee, and it is not cosmetic.** Both callers sweep immediately after
  `ensurePluginAbsent`, which throws rather than return with the plugin still installed. Measured on
  a cell: sweeping while the plugin is active *does* delete the rows, and the very next WordPress
  request puts all 26 options and the table straight back, because the plugin re-creates its own
  footprint on `init`.
- **Rows go through `delete_option`, not a `DELETE`**, so WordPress invalidates its own caches as it
  would for any other deletion — which is why no cache flush follows. Tables are dropped with
  `IF EXISTS`. Removal is then **verified by re-reading**, in a second process and straight from the
  database: `DROP` reports success for a table it never touched, and `delete_option` returns false
  both for "absent" and for "a filter refused it".
- WordPress is loaded **without its plugins** (`--skip-plugins`), so the sweep's outcome cannot
  depend on what else the site has installed — these cells carry plugins that hook option and
  transient writes. Core, and so `delete_option`, is unaffected.
- **Two guards, both aimed at a wrong declaration rather than a hostile one.** `PROTECTED_TABLES`
  refuses a declaration naming one of WordPress's own tables, at declaration time. `PROTECTED_OPTIONS`
  is checked against what the query actually *matched* — a fragment is not a name, and only the site
  can say what it reaches — and refuses the **whole** sweep, before anything is deleted, if the match
  reached `siteurl`, `active_plugins`, `cron`, the prefixed `user_roles`, or the rest of that list.
  The same bet `PROTECTED_SITE_PATHS` makes for a privileged `rm -rf`, made here for a `DELETE`.
  A fragment shorter than three characters is refused outright: matched anywhere in a name, it would
  sweep the site rather than the product.
- Nothing here is ever **elevated** — it is WP-CLI and SQL, not the filesystem. Verified on both
  cells: a sweep of a clean site leaves its entire state (options, tables, user meta, roles,
  capabilities, cron) byte-identical and runs no privileged command.
- Multisite is **refused**, not half-handled: there a plugin keeps its options in `sitemeta` per
  network, and a sweep that quietly looked in the wrong table would report a dirty site as clean.

**Scope, deliberately.** Only options and tables, because those are the two that *block a fresh
install* — the options are what a plugin reads to decide it has been installed before, the table is
what its installer tries to create again. A footprint also holds roles, capabilities and user meta;
none of those blocks anything, activation re-establishes them idempotently, and the next scenario's
own uninstall removes them, so they cannot accumulate. Declaring them would mean reproducing the
plugin's role handling here — a second implementation to keep in step with it.

## File ownership ([`wp/ownership.ts`](../../src/common/wp/ownership.ts))

The same two-user problem as the data directories above, one step earlier: **WP-CLI unpacks a
plugin as the transport's user, so the web server cannot write inside it.** On a real cell `wp`
runs as for example `ubuntu` under a `0002` umask, and everything `wp plugin install` extracts arrives
`ubuntu:ubuntu` — `775` directories, `664` files. Let's say `www-data` is the web server user; it is then denied on its very next write:
a plugin creating a working directory of its own, a plugin update, a delete through wp-admin.

It is **not** the familiar "WordPress wants FTP credentials" symptom. Read from WP 7.1 core on the
cell, `get_filesystem_method()` compares the owner of a *core* file with a temp file it writes, and
both are `www-data`, so WordPress still selects its `direct` method correctly — and then fails with a
plain permission error on the actual call.

**Who the files should belong to is detected, never assumed.** `stat -c '%U:%G:%u:%g'` on
`wp-content` (falling back to the WordPress root) answers it, and the answer is *not* always the web
server: on a docroot deployed over SFTP the owner is the deployment account and `www-data` (or whatever the web server user is called) only
shares the group. Measured on two QA cells:

| Cell | Web/PHP process user | Docroot owner |
| --- | --- | --- |
| nginx | `www-data` | `www-data:www-data` |
| apache | `www-data` | **`sftp_backwpup:www-data`** |

Probing the running web-server process would name `www-data` on both, and would be wrong on the
second. A site may override the detection with `transport.fileOwner` (see
[configuration.md](../guides/configuration.md#transport-modes-transport)).

### What it does, and in what order

`normalizeOwnership(transport, sitePath)` takes a path **relative to the WordPress root** and:

1. Decides, via `planOwnership` — the same function pre-flight calls to *report* what will happen, so
   the two can never describe different things.
2. **Does nothing at all** when the transport's user already owns the install with the same uid *and*
   gid. That is the `docker` case (the wp-cli containers run as `33:33`, matching the `wordpress`
   containers), and it returns before privileges are even probed.
3. Otherwise applies **the mode grant first**, then the chown (shown as `local`/`ssh` dispatches;
   on `docker`, `execElevated` uses `docker exec -u 0:0` instead of `sudo`):

   ```
   sudo -n -- chmod -R -- <mode> <abs>
   sudo -n -- chown -Rh -- <user>:<group> <abs>
   ```

   The order is load-bearing. The commands commute in their final effect but not in their
   intermediate one: chowning first leaves the tree owned by the site's user with **no grant yet** —
   which is exactly what locks the transport user out of `wp plugin uninstall`. Granting first means
   a failed chown leaves the tree as it was.
4. **Verifies** by re-reading the ownership, never inferring it from `chown`'s exit code.

**The grant keeps both users working**, and its scope is measured rather than assumed:

| The transport user is… | Grant |
| --- | --- |
| the target owner, or in the target group | `ug+rwX` |
| neither | `ug+rwX,o+rwX` — world-writable, and it says so |

`ug+rwX` is applied in both branches because after the chown the owner and group are the docroot's
own pair, and where those are two different accounts the **group half is the web server's only
access**. `o+rwX` is added only when the transport user is outside both, so it can still remove what
it installed; that case emits a one-time notice naming the fix (put the transport user in the site's
group). Every mode is additive (`+`, never `=`) so this can never tighten a host, and uses `X` not
`x` so directories become traversable without making PHP files executable.

### Symlinks

The guards in [`wp/paths.ts`](../../src/common/wp/paths.ts) are **lexical** — they compare path
strings. What a path *really* points at is a separate question, and the privileged commands do not
answer it the same way. Measured on GNU coreutils 9.4 (Ubuntu, kernel 6.8) and on BusyBox 1.37:

| | A link as the **operand** | A link found during **recursion** |
| --- | --- | --- |
| `chmod -R` | **followed** — and it recurses into the referent's whole tree | not followed |
| `chown -Rh` | not followed — `-h` acts on the link | not followed |
| `rm -rf` | not followed — removes the link | not followed |

Recursion is safe in all three: GNU's `-P` ("do not traverse any symbolic links") is the default
under `-R`, and `-Rh` is what additionally makes `chown` safe on the operand.

**But the operand is not the only place a link can sit.** A link in any *parent* is resolved by the
kernel before the command ever sees the path, so `wp-content/uploads` relocated to another volume
sends every one of these commands elsewhere while each lexical guard agrees the target is inside the
root. Measured: with `uploads` linked out, `rm -rf <root>/wp-content/uploads/backwpup` deleted
`/out/backwpup`, and `mkdir -p` created `/out/newdir` — both outside the WordPress root.

So the check is not "is the last component a link?" but **"where does this path really lead?"**
`assertResolvedInsideRoot` ([`wp/exec.ts`](../../src/common/wp/exec.ts)) resolves the target and the
root with `readlink -f` and requires the first to be inside the second. A path that does not exist
yet cannot be a link, so it walks up to the deepest ancestor that does — rather than relying on
`readlink -f` tolerating one absent component, which GNU and BusyBox do and other implementations do
not. A path it cannot resolve at all is **refused**: nothing is then known about where a root command
would land, and the only safe reading of "unknown" is "no".

It runs before every privileged path — ownership normalisation (warns, returns `failed`), data-directory
preparation and residue removal (both throw). Removal is guarded before **both** of its passes, not
only the elevated one: "unprivileged" is a bound only while the transport's user is not root, which a
container or a root SSH login does not guarantee, and deleting another part of the filesystem is wrong
at any privilege. Verified against a live container: with a linked ancestor in place, preparation and
removal both refused and the outside directory kept its contents and its `0700` mode.

It is a check-then-act, and not claimed to be more: the path could be replaced between the resolution
and the command. `chmod` has no "do not follow" flag, so the window cannot be closed here. Winning it
needs write access to the docroot — which on these cells means the plugin under test — and before this
check there was no window at all, only an open door.

Relocating a data directory outside the root is therefore refused rather than followed. That is the
deliberate trade: point the site's `rootDir` at the real location, or declare a residue path that
stays within it.

`--` ends option parsing in both commands, because `chown` permutes options anywhere in its argv:
without it, a `fileOwner` of `--reference=/etc/hostname` reaches root as a *flag* and takes ownership
from that file (measured; with `--` it is an "invalid user" error).

### It never fails a run

The elevation probe follows the same rule as the ownership probes: a `sudo` that **runs and
refuses** is remembered for the process, a transport that could not be asked at all is not. Caching
the second would let one dropped connection disable escalation for every later scenario in that
worker, on a host that is fine.

Ownership is housekeeping — it makes no claim about the product under test — so
`normalizeOwnership` **never throws**. It returns `normalized` / `unnecessary` / `skipped` /
`disabled` / `failed`, and warns once per site *per reason* (two different failures never silence
each other). A host with no passwordless `sudo` cannot do it at all, since `chown` always needs root;
that is reported by pre-flight and by the run-level warning, not treated as a fault.

Detection, identity and the notices are cached **per install**, not per host: one machine routinely
serves several sites and they need not agree — measured on the apache cell,
`sftp_backwpup:www-data` and `sftp_wprocket:www-data` under the same `ubuntu@host`.

> **MUST — any code that writes files into a site's docroot as the transport's user must call
> `normalizeOwnership` on what it wrote.** Never call `chown`/`chmod` directly, and never elevate
> `wp`: WP-CLI as root would leave the site unwritable by the web server, which is this module's
> problem in a more expensive form. `stageAndInstallPlugin` does it for you when given the plugin's
> `slug` — pass it. The staging area itself is deliberately left alone: only the transport user ever
> reads it.

**Linux only, deliberately.** `stat -c` and `id` are read in their GNU form; BusyBox (what the
`wordpress:cli` container provides) implements both compatibly. Both reads are confined to one
function each, so a future BSD branch stays local.

## Path guards ([`wp/paths.ts`](../../src/common/wp/paths.ts))

The two guards that stand between a typo and a privileged `rm -rf` / `chown -R` on a real system path,
plus the composer that builds the path they are most often asked about. They live in one module because
a copied guard is a guard that drifts, and residue removal, data-directory preparation and ownership
normalisation all validate through them.

- `normaliseSitePath(declared, describeRejection)` constrains the **relative** half: inside the
  WordPress root, never a directory WordPress itself owns (`PROTECTED_SITE_PATHS`).
- `assertSafeElevatedTarget(target, root, describeRejection)` constrains the half the first cannot
  see: that the root is a plausible site root (absolute, at least two segments — `/` and `/tmp` are
  not) and that joining the two stayed inside it. It is run by the three operations that build a
  privileged target out of a site's declared `rootDir` — residue removal, data-directory
  preparation and ownership normalisation. The other elevated callers do not need it because they
  do not compose such a path: the staging area has its own dedicated-directory guard, and
  `debug.log` is a fixed relative path. Unprivileged callers have the transport user's own
  permissions as a backstop.
- `pluginSitePath(slug)` composes `wp-content/plugins/<slug>` and requires a **single segment**,
  because `posix.join` would otherwise resolve `..` back out into a directory WordPress owns.

Both **guards** take the caller's own message builder, so a failure reads in the vocabulary of what
was being attempted and names the remedy that caller can offer; `pluginSitePath` throws its own fixed
message, having only one thing it can be used for. Neither guard is a boundary against hostile input —
the declarations are our own — but on a host where the suite can `sudo`, a mistake is the more
expensive of the two.

Both are **lexical**: they reason about the path string, not about what is on disk. See
[Symlinks](#symlinks) for the one thing that distinction leaves open,
and what closes it.

## Options ([`wp/options.ts`](../../src/common/wp/options.ts))

Reads WordPress options over WP-CLI, so a scenario can check what a plugin actually
persisted instead of re-reading the screen that rendered it.

- `getOption(transport, name)` → the raw value, or `undefined` when the option is not
  set. An option set to `""` returns `""`, so "present but empty" stays distinct from
  "absent".
- `getOptionJson<T>(transport, name)` → the value deserialised from `--format=json`.
  **A PHP array is not always a JSON array**: WP-CLI emits an object as soon as the keys
  are not a 0-based sequence, which is what deleting an entry from the middle of a list
  produces. Callers expecting a list must accept both shapes.

`wp option get` exits non-zero both for a missing option **and** for a WordPress that
cannot boot, so the two are told apart by WP-CLI's own "Does it exist?" wording: only
that one is reported as `undefined`, everything else throws. Reporting a broken site as
"no such option" is the false negative these readers exist to prevent.

Single-site only — a *network* option on multisite lives behind `wp site option`.

## Database ([`wp/db.ts`](../../src/common/wp/db.ts))

`dbQuery(transport, sql)` runs a SQL statement via `wp db query` and returns
stdout. Throws on a non-zero exit.

`tablePrefix(transport)` returns this install's table prefix from `wp db prefix` — i.e.
`$wpdb->prefix`, which on multisite includes the per-blog segment a config file never
shows. Needed wherever a plugin distinguishes *this* install's tables from other tables
sharing the database; a hard-coded `wp_` would quietly assert the wrong thing on any site
not using the default.

## WP-Cron ([`wp/cron.ts`](../../src/common/wp/cron.ts))

Lets a scenario about a *scheduled* feature answer its two separate questions: **is the
event registered**, and **what happens when it fires**.

- `nextScheduled(transport, hook, args?)` → the Unix timestamp of the next run, or
  `undefined` when nothing is scheduled. Asked of `wp_next_scheduled` rather than read
  out of `wp cron event list`, which prints a formatted date and cannot tell two events
  on the same hook apart. Args matter: WordPress keys an event by hook **and** argument
  array, so a plugin that schedules one event per job (BackWPup does) needs both.
- `triggerScheduledEvent(transport, hook, args?)` → re-schedules **that one event** into
  the past and hands it to WordPress's own `spawn_cron()`. Throws if the event is not
  scheduled, so a scenario cannot "trigger" something the product never registered. A
  recurring event stays recurring — its schedule is read back and re-applied, so this
  cannot silently downgrade one to a single event. Only the target event is *moved*;
  whatever the site already had due runs alongside it, as on any real cron tick. Returns
  as soon as WordPress has accepted the work — the cron request is non-blocking in core,
  so callers wait on the product's own evidence that the work finished, never on this
  resolving.

**Why not `wp cron event run <hook>`** — two reasons, both measured on a live cell:

1. **It is not selective.** WP-CLI 2.12's help says it "runs the next scheduled cron
   event for the given hook"; a probe with three events on one hook executed **all
   three**, including one scheduled hours ahead. Adding `--due-now` *does* restrict it to
   genuinely due events, which is why the trigger above makes only the target event due.
2. **It runs the work inside the WP-CLI process**, whose PHP is configured nothing like
   the web server's. On a host where the CLI has `memory_limit = -1`, BackWPup's own
   "grow the limit as needed" step computes a *finite* limit from the current usage
   (`(int) '-1'` is `-1`, so any requirement looks larger) and the job then dies against
   it — a hard PHP fatal in a run that succeeds every time through the web server.

`spawn_cron()` posts to `wp-cron.php`, so the event executes in the same web context a
real schedule would. That holds whether the host disables WordPress's own cron and pokes
`wp-cron.php` from a system crontab, or lets WordPress spawn it from page loads —
`spawn_cron()` is gated by neither. The one arrangement it cannot serve is
`ALTERNATE_WP_CRON`, whose branch reads `$_SERVER['REQUEST_METHOD']` and so always
declines under WP-CLI; such a site fails loudly rather than quietly.

`spawn_cron()` also declines while another cron run holds WordPress's `doing_cron` lock, so
the trigger retries rather than reporting a property of the host as a test failure. The
lock is **never deleted**, and the budget is what makes that safe:

- Core only declines while the lock is *younger* than `WP_CRON_LOCK_TIMEOUT`
  (`if ( $lock + WP_CRON_LOCK_TIMEOUT > $gmt_time ) return false;`). It already ignores an
  abandoned one, so deleting a stale lock cannot change the outcome — it is not a fix, it
  is a no-op.
- Deleting one that a *slow* run still holds truncates that run: `wp-cron.php` re-reads the
  lock between events and returns as soon as it has changed. Since a lock is set once and
  not refreshed, any backup running longer than the timeout has a lock that merely *looks*
  abandoned.
- So the trigger simply outlasts the lock. The budget is read from the site
  (`min( 300, max( 70, WP_CRON_LOCK_TIMEOUT + 10 ) )`) rather than hard-coded, because a
  site may raise the constant; the cap stops an extreme value hanging the caller, and the
  timeout is named in the failure message when the budget is spent.

The event is unscheduled before it is re-scheduled as due — required, because core's
duplicate guard in `wp_schedule_single_event` counts *all* past identical events as
duplicates when the new timestamp is within ten minutes. If the re-schedule then fails, the
original run is **put back**, so failing to advance a schedule never costs the site the
schedule itself.

## Talking PHP to a site ([`php.ts`](../../src/common/wp/php.ts))

Every module that asks WordPress something it has no WP-CLI command for goes through here, so
the two hard parts are solved once.

- `phpLiteral(value)` embeds a value as `json_decode( base64_decode( '…' ), true )`. What lands
  in the snippet is drawn from `A-Za-z0-9+/=` — an alphabet containing no PHP metacharacter — so
  quotes, backslashes, newlines and `$` in the data cannot end the literal or interpolate. That
  is what makes it safe for values **read off a site** rather than written by hand. A value with
  no JSON form (`undefined`, a function, a symbol) throws here, naming the caller's mistake,
  instead of failing deep inside `Buffer.from`.
- `evalPhp(transport, php, what, scope, options)` runs the snippet and turns a non-zero exit into a
  throw carrying whatever PHP or WP-CLI said — including a snippet's own `WP_CLI::error()`, which is
  how a snippet refuses in the site's own words.
- `options.skipPlugins` boots WordPress **without its plugins** (`--skip-plugins`), for a snippet
  whose answer must not depend on what else the site has installed — a cleanup step, or anything
  asking about a plugin that is supposed to be gone. Core is fully loaded either way, so `$wpdb` and
  the option API behave normally; only plugin code and the filters it registers stay out. Off by
  default, because a snippet asking about a *running* site needs the site as it really runs. The
  flag leads the argv: WP-CLI reads global parameters before it dispatches, and one placed after the
  snippet is handed to `eval` as another positional argument.

**Any value that came from outside this codebase goes through `phpLiteral`** — a site's own data, a
scenario's input, a fixture. That has no exceptions: interpolating such a value into PHP source is
the same class of mistake as interpolating one into SQL, and it is avoidable in one line. A
compile-time constant of ours interpolated into snippet *source* (a budget, a destination slug) is
not a value in that sense, and the handful of sites doing it say so inline.

**Every `wp eval` in the suite runs through `evalPhp`.** There is no standing exception: a caller
that wants to interpret the reply rather than trust it validates the *returned string* after
`evalPhp` has already turned a non-zero exit into a throw — which is what `isJobRunning` does when it
insists on `"0"` or `"1"`. Guards that must not fail on a site whose plugin will not load belong in
the **PHP**, not in exit-code branching: `isJobRunning` answers "nothing is running" because its
snippet asks `class_exists( 'BackWPup' )` first.

## File properties ([`files.ts`](../../src/common/wp/files.ts))

`fileChecksum(transport, path)` returns a file's SHA-256 as lower-case hex, computed **on the
site** so nothing large has to move to answer the question.

This is the honest proof that a file which travelled arrived intact. Size is the tempting
substitute and is strictly weaker: a body corrupted in place, or a truncation that happens to be
padded, matches on size and differs here. A reply that is not a digest — a notice printed ahead of
the value, an empty string, upper-case hex — throws rather than being compared, because comparing
it would fail as "the download differs" and point at the wrong thing.

## Looking inside an archive ([`archive.ts`](../../src/common/wp/archive.ts))

A product that produces archives has to be asked what it actually put in one: a file that exists
and is the right size proves nothing about its contents. Downloading it to find out does not
scale — a files backup of a real site runs to **gigabytes** — so the questions are asked in place,
through `tar`.

- `findArchiveEntries(transport, archive, pattern)` — members matching an exact name or a glob.
  Empty when none match; **throws** when the archive itself cannot be read.
- `readArchiveEntry(transport, archive, member)` — one member's contents, streamed to stdout so
  nothing is extracted to disk.

Three decisions worth keeping:

- **The member is named to `tar`, never listed and filtered here.** That keeps the *output* small —
  a full listing of a 2 GB site is megabytes of paths nothing reads — but not the work: without
  `--occurrence` tar scans to the end anyway, and on a compressed archive it decompresses all of it.
  Measured on a 200 MB `.tar.gz`: full list 1.373 s, pattern list 1.386 s, pattern miss 1.385 s,
  first-member extract 1.393 s — and 0.160 s with `--occurrence=1`. An uncompressed `.tar` is
  seekable and costs almost nothing. `--occurrence` is deliberately **not** used, because a name can
  legitimately match two members (a docroot file sharing the database dump's name) and both are
  wanted.
- **Compression is not declared.** GNU tar detects it when reading, so one code path serves `.tar`
  and `.tar.gz`; picking a flag from the file extension would put a guess in front of an answer.
  `.zip` — also a valid BackWPup `archiveformat` — is out of scope: tar refuses it outright, so the
  answer is an error rather than a wrong result.
- **"Absent" and "unreadable" cannot be told apart from `tar`'s wording.** Both exit 2, and a
  *truncated* archive prints only `<pattern>: Not found in archive` with no corruption line at all
  (measured). So readability is decided by behaviour instead: when a pattern matches nothing, the
  archive is listed with no pattern and only the exit status is believed. Reading a damaged archive
  as "the file is not in it" would turn a corrupt backup into a confident, wrong answer — and every
  absence assertion built on it would pass.

## Type guards ([`guards.ts`](../../src/common/guards.ts))

Domain-free reusable guards: `isObject` (non-null, non-array object) and
`isNonEmptyString`. Module-specific validation (e.g. the `sites.json` checks)
builds on these but stays local to its module.
