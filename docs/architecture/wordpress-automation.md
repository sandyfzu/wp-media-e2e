# WordPress automation layer

The `src/common/wp/` modules drive a WordPress site over WP-CLI, independent of
how the site is reached. Everything here is **transport-agnostic**: the same code
works whether the site is local, in Docker, or behind SSH.

## Transport & exec ([`wp/exec.ts`](../../src/common/wp/exec.ts))

A [`Transport`](../../src/common/config/types.ts) describes how WP-CLI reaches a
site, discriminated on `mode`:

| Mode     | Fields                                                          | Dispatch                                        |
| -------- | --------------------------------------------------------------- | ----------------------------------------------- |
| `local`  | `rootDir`, `stagingDir?`                                        | `execa`, run in `rootDir`.                      |
| `docker` | `container`, `rootDir?`, `stagingDir?`                          | `docker exec <container> …` (see `dockerArgv`). |
| `ssh`    | `host`, `username`, `privateKeyPath`, `rootDir`, `stagingDir?`   | `node-ssh` (its `exec` shell-escapes the args). |

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

The module also owns the **file-transfer** primitives, because they need the same
per-mode dispatch and the same cached SSH connection:

- `wpRootDir(transport)` → the **absolute** WordPress root on the target. Declared
  for `local`/`ssh`; for `docker` it is the container `WORKDIR`, read once with
  `pwd` and cached per container (declare `rootDir` on the transport to skip that).
- `copyIntoTarget(transport, localAbs, targetAbs)` — copies a runner file onto the
  target, overwriting: `node:fs` copy (`local`), `docker cp` (`docker`, a top-level
  sub-command — see `dockerCpArgv`), SFTP `putFile` (`ssh`). It does **not** create
  the parent directory; the staging layer below does that first.

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

## Debug-log scanning ([`wp/log.ts`](../../src/common/wp/log.ts))

Reads and categorises `wp-content/debug.log` to catch PHP errors a UI assertion
would miss. Transport-agnostic, with a resilient fallback:

- Reads/clears via WP-CLI `wp eval` (PHP inside WordPress, which resolves
  `WP_CONTENT_DIR` even when customised). But `wp eval` needs WordPress to **boot**
  — and the log matters most when a fatal has broken that boot. So on a non-zero
  `wp eval` exit it logs and **falls back** to a direct file read/removal that does
  not load WordPress.

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

Typical use:

```ts
import { clearDebugLog, scanDebugLog } from "../../../common/wp/log";
import { WP_ROCKET_LOG_OPTIONS } from "../support/debug-log";

// Before hook:
await clearDebugLog(site.transport);
// After hook:
const scan = await scanDebugLog(site.transport, WP_ROCKET_LOG_OPTIONS);
if (scan.fatals.length > 0) throw new Error(scan.fatals.join("\n"));
```

## Database ([`wp/db.ts`](../../src/common/wp/db.ts))

`dbQuery(transport, sql)` runs a SQL statement via `wp db query` and returns
stdout. Throws on a non-zero exit.

## Type guards ([`guards.ts`](../../src/common/guards.ts))

Domain-free reusable guards: `isObject` (non-null, non-array object) and
`isNonEmptyString`. Module-specific validation (e.g. the `sites.json` checks)
builds on these but stays local to its module.
