# Configuration reference

The two configuration surfaces are **sites files** (per product, secret) and
**`.env`** (runtime flags + service credentials). This is the schema reference;
for the operational quick-start see the [README](../../README.md).

## Sites files (per product)

A product's site definitions live in one or more JSON files under
`src/projects/<product>/config/`. All are **git-ignored** because they hold
credentials. Each product ships a committed `sites.example.json` with placeholder
data on the reserved `.example.test` domain.

### Which files are loaded

Files are discovered and merged in stable order by
[`loadSites`](../../src/common/config/sites.ts):

1. **`sites.json`** — the primary file (if present).
2. **`sites.<name>.json` overlays** (e.g. `sites.docker.json`, `sites.local.json`,
   `sites.ssh.json`) — merged in alphabetically after `sites.json`. Overlay names
   must be a single segment with no extra dots (`sites.a.json` is valid;
   `sites.a.b.json` is ignored).

Each file declares a **disjoint set of cells**; a cell name appearing in two files
is a hard error that names both source files. Edition consistency (all-or-none) is
checked per-file _and_ across the merged result.

When **none** of the above exist, `sites.example.json` is loaded with a warning so
the suite still starts, `@noauth` smoke scenarios stay green, and auth setup is
skipped for all placeholder (`.example.test`) sites.

Every field is validated with an actionable error that names the offending cell and
index, so a malformed file fails fast.

### Shape

The top-level keys are **cell names** (`apache`, `nginx`, `pro@nginx`, …). A cell
is either a bare array of sites (editionless) or an object `{ edition?, sites }`:

```jsonc
{
  // Editionless cell (e.g. WP Rocket): bare site array.
  "apache": [
    {
      "baseURL": "https://example.test",
      "username": "admin",
      "password": "…",
      "transport": { "mode": "ssh", "host": "203.0.113.10", "username": "ubuntu",
                     "privateKeyPath": "/home/ci/.ssh/id_ed25519",
                     "rootDir": "/var/www/html/site" },
      "overrides": { "storage": { "ftp": { "host": "ftp.alt.example" } } }
    }
  ],

  // Edition-ful cell (e.g. BackWPup): object with an edition.
  "pro@nginx": {
    "edition": "pro",
    "sites": [ { "baseURL": "…", "username": "…", "password": "…", "transport": { … } } ]
  }
}
```

### Site fields ([`SiteInput`](../../src/common/config/types.ts))

| Field        | Required | Notes                                                              |
| ------------ | -------- | ------------------------------------------------------------------ |
| `baseURL`    | yes      | The site's URL. Each pooled worker navigates relative to its own.  |
| `username`   | yes      | WordPress admin login.                                             |
| `password`   | yes      | WordPress admin password.                                          |
| `transport`  | yes      | How WP-CLI reaches the site (below).                               |
| `overrides`  | no       | Per-site service-credential overrides, merged over product globals. |

The resolved [`SiteConfig`](../../src/common/config/types.ts) adds a computed
`storageState` path (where the worker's saved login is written).

### Transport modes ([`Transport`](../../src/common/config/types.ts))

Discriminated on `mode` — see
[wordpress-automation.md](../architecture/wordpress-automation.md) for dispatch
detail.

| `mode`   | Required fields                                          |
| -------- | ------------------------------------------------------- |
| `local`  | `rootDir`                                               |
| `docker` | `container`                                             |
| `ssh`    | `host`, `username`, `privateKeyPath`, `rootDir`         |

## Editions (Free / Pro)

For products shipped as two packages (BackWPup), a cell declares `edition`.
Editions are **all-or-none across a product's cells**: if any cell declares one,
every cell must — so an edition-ful product can never silently run an
edition-less cell. The config factory turns a cell's edition into a Cucumber tag
filter (`pro` → `not @free`, `free` → `not @pro`).

## `.env` ([`.env.example`](../../.env.example))

Copied to `.env` and loaded once by
[`load-env.ts`](../../src/common/config/load-env.ts), imported first by every
Playwright config entry. **Real environment variables always win** over `.env`
(CI secrets are never overwritten). Validation happens only at this boundary,
through the typed accessors in [`env.ts`](../../src/common/config/env.ts)
(`env`, `requireEnv`, `intEnv`, `boolEnv`).

### Runtime flags

| Var           | Default                | Purpose                                                                 |
| ------------- | ---------------------- | ----------------------------------------------------------------------- |
| `REPORT_MODE` | _(unset)_ → self-contained | `rich` → external attachments + embedded trace viewer (serve over http). |
| `CELL`        | _(via `--project`)_    | Cell to run (orchestrator path). Exactly one per invocation.            |
| `RUN_ID`      | auto-stamped           | Per-run report token; pin to share one token across a batch.            |
| `CI`          | _(unset)_              | Non-empty enables CI config (retries, `forbidOnly`).                    |
| `PRODUCT`     | `wp-rocket`            | Default product for the bare `playwright.config.ts`.                    |
| `REPORT_ROOT` | `reports`              | Report artifact root (accumulates).                                     |
| `OUTPUT_ROOT` | `test-results`         | Ephemeral Playwright artifact root.                                     |
| `AUTH_ROOT`   | `.auth`                | Ephemeral `storageState` root.                                          |

### BackWPup storage credentials

Read by [`backwpup.config.ts`](../../src/projects/backwpup/config/backwpup.config.ts)
into the product's `services`; ignored by WP Rocket. Any can be overridden per
site via that site's `overrides` block.

| Var                       | Default       |
| ------------------------- | ------------- |
| `BWP_FTP_HOST` / `BWP_FTP_USERNAME` / `BWP_FTP_PASSWORD` | _(blank)_ |
| `BWP_FTP_PORT`            | `21`          |
| `BWP_FTP_SECURE`          | `true`        |
| `BWP_S3_ACCESS_KEY_ID` / `BWP_S3_SECRET_ACCESS_KEY` / `BWP_S3_BUCKET` | _(blank)_ |
| `BWP_S3_REGION`           | `us-east-1`   |

## Local WordPress via Docker

[`docker/`](../../docker/) provides a self-contained environment for the `docker`
transport (Apache on `:8100`, Nginx on `:8101` over one MariaDB). Point a product
at it by copying [`docker/sites.example.json`](../../docker/sites.example.json)
into the product's `sites.json`. See the README's
"Local WordPress (Docker)" section for commands (`env:up` / `env:down` /
`env:logs`).
