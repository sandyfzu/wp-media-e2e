# WordPress automation layer

The `src/common/wp/` modules drive a WordPress site over WP-CLI, independent of
how the site is reached. Everything here is **transport-agnostic**: the same code
works whether the site is local, in Docker, or behind SSH.

## Transport & exec ([`wp/exec.ts`](../../src/common/wp/exec.ts))

A [`Transport`](../../src/common/config/types.ts) describes how WP-CLI reaches a
site, discriminated on `mode`:

| Mode     | Fields                                          | Dispatch                                              |
| -------- | ----------------------------------------------- | ----------------------------------------------------- |
| `local`  | `rootDir`                                       | `execa`, run in `rootDir`.                            |
| `docker` | `container`                                     | `docker exec <container> …` (see `dockerArgv`).       |
| `ssh`    | `host`, `username`, `privateKeyPath`, `rootDir` | `node-ssh` (its `exec` shell-escapes the args).       |

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
- SSH connections are cached per endpoint and reused. Call `disposeConnections()`
  from a worker-teardown fixture to close them.

## Plugin lifecycle ([`wp/plugin.ts`](../../src/common/wp/plugin.ts))

Two delete intents are **deliberately separated** because they have opposite
correctness semantics:

| Function                          | Intent                          | Already-absent behaviour          |
| --------------------------------- | ------------------------------- | --------------------------------- |
| `ensurePluginAbsent(transport, slug)` | **Cleanup** (Before/After hooks) | Success (no-op).                  |
| `deletePlugin(transport, slug)`       | **Deletion under test**         | Throws `PluginNotInstalledError`. |

`wp plugin delete` exits non-zero for *both* "not found" and a genuine failure, so
its exit code is not trusted — removal is always re-verified with `is-installed`
(exit `0` = installed, `1` = not). Other helpers:

- `isPluginInstalled` / `isPluginActive` — boolean state checks.
- `installPlugin(transport, source, opts?)` — install from slug, local zip, or URL;
  [`InstallPluginOptions`](../../src/common/wp/plugin.ts) `{ activate?, force? }`.
- `activatePlugin(transport, slug)`.

UI-driven plugin actions (the asserted, user-facing flow through wp-admin) live in
the [`PluginsPage`](../../src/common/pages/plugins.page.ts) page object instead —
see [authoring-tests.md](../guides/authoring-tests.md).

## Error types ([`wp/errors.ts`](../../src/common/wp/errors.ts))

Distinct classes so steps and reports can tell failure modes apart — including the
two `wp plugin delete`'s ambiguous exit code cannot, and the UI-only deactivation
case:

- `PluginNotInstalledError` — expected-present plugin is absent.
- `PluginActivationFailedError` / `PluginDeactivationFailedError` — UI action failed.
- `PluginDeletionFailedError` — plugin still present after a delete attempt.

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
