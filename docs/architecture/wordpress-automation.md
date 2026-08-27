# WordPress automation layer

The `src/common/wp/` modules drive a WordPress site over WP-CLI, independent of
how the site is reached. Everything here is **transport-agnostic**: the same code
works whether the site is local, in Docker, or behind SSH.

## Transport & exec ([`wp/exec.ts`](../../src/common/wp/exec.ts))

A [`Transport`](../../src/common/config/types.ts) describes how WP-CLI reaches a
site, discriminated on `mode`:

| Mode     | Fields                                                                      | Dispatch                                        |
| -------- | --------------------------------------------------------------------------- | ----------------------------------------------- |
| `local`  | `rootDir`, `stagingDir?`, `elevate?`                                        | `execa`, run in `rootDir`.                      |
| `docker` | `container`, `rootDir?`, `stagingDir?`, `elevate?`                          | `docker exec <container> …` (see `dockerArgv`). |
| `ssh`    | `host`, `username`, `privateKeyPath`, `rootDir`, `stagingDir?`, `elevate?`   | `node-ssh` (its `exec` shell-escapes the args). |

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
  correctly-permissioned host never runs a privileged command — not even the capability probe.
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
| `stageAndInstallPlugin(transport, localZip, opts?)` | `stageArtifact(category: "plugins")` → `installPlugin` from the staged path.  |
| `siteStagingDir(transport)`                         | The absolute staging directory for a site.                                   |
| `cleanSiteStaging(transport, category?)`            | `rm -rf` the whole area, or one category.                                    |
| `stagingPath(root, ...segments)`                    | Pure POSIX path builder; validates each segment.                             |

```ts
const zip = await stageAndInstallPlugin(
  site.transport,
  pluginArtifact("plugin").zipPath,
  { activate: true },
);
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
  declared list: it creates each directory and opens it to every user sharing the docroot (`0777`).
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

## Type guards ([`guards.ts`](../../src/common/guards.ts))

Domain-free reusable guards: `isObject` (non-null, non-array object) and
`isNonEmptyString`. Module-specific validation (e.g. the `sites.json` checks)
builds on these but stays local to its module.
