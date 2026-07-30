/**
 * Configuration types shared across products.
 *
 * A `product` (wp-rocket, backwpup, …) declares its features/steps, its service
 * configuration, and a map of `cell` → cell config. A `cell` is a named environment
 * (e.g. "apache", "nginx", "pro@nginx"); each holds a pool of interchangeable WordPress
 * instances across which that product's scenarios are distributed, plus an optional
 * edition (Free/Pro) for edition-ful products.
 */

// Both imports are type-only, so they are erased at runtime under `verbatimModuleSyntax` and the
// config↔artifacts and config↔wp type references introduce no runtime module cycles. Each schema
// lives with its own domain: the artifacts manifest in `../artifacts/types`, the debug-log scan
// options in `../wp/log` (whose presets products author in `support/debug-log.ts`).
import type { ProductArtifacts } from "../artifacts/types";
import type { ScanDebugLogOptions } from "../wp/log";

// Re-exported so a product-config author gets the manifest schema and `ProductConfig` from one
// place.
export type { ProductArtifacts };

/** WordPress hosting mode — decides how WP-CLI is dispatched (see the exec layer, a later phase). */
export type ServerMode = "ssh" | "docker" | "local";

/**
 * Fields every transport shares, independent of how commands reach the site. Kept on a common
 * base so a site-level knob is declared once instead of three times; the union stays
 * discriminated on `mode`.
 */
interface TransportBase {
  /**
   * Where this site's staging area lives — the directory on the **target** that test artifacts
   * (plugin zips, WXR imports, DB dumps) are copied into before WP-CLI reads them. Absolute, or
   * relative to the WordPress root. Defaults to `.e2e_temp` under the WordPress root, which is
   * also the web docroot on our environments; override it when the transport's user cannot write
   * there, or to keep staged files out of the docroot. Takes precedence over
   * `E2E_SITE_STAGING_DIR` (a site's own declaration beats a global default).
   *
   * Must be a **dedicated** directory: cleanup removes it whole, so the WordPress root itself,
   * any ancestor of it, and top-level paths are rejected (see `wp/staging.ts`).
   */
  readonly stagingDir?: string;
}

export interface SshTransport extends TransportBase {
  readonly mode: "ssh";
  readonly host: string;
  readonly username: string;
  readonly privateKeyPath: string;
  readonly rootDir: string;
}

export interface DockerTransport extends TransportBase {
  readonly mode: "docker";
  readonly container: string;
  /**
   * WordPress root **inside** the container. Optional because the exec layer runs every command
   * at the container's `WORKDIR`, which is the WordPress root in the images we use — so a
   * relative path already resolves correctly and the absolute root can be read back with `pwd`.
   * Declare it to skip that round-trip, or when a custom image's `WORKDIR` is not the WP root.
   */
  readonly rootDir?: string;
}

export interface LocalTransport extends TransportBase {
  readonly mode: "local";
  /**
   * WordPress root on the host — the directory containing `wp-load.php`. The exec layer runs
   * `wp` with this as its working directory so WP-CLI resolves the right install. Required: an
   * absent `rootDir` would silently run `wp` from the process CWD and target the wrong (or no)
   * WordPress, so a `local` site must always declare it.
   */
  readonly rootDir: string;
}

/** How WP-CLI reaches a given site. Discriminated on `mode`. */
export type Transport = SshTransport | DockerTransport | LocalTransport;

export interface FtpServiceConfig {
  readonly host: string;
  readonly username: string;
  readonly password: string;
  readonly port: number;
  readonly secure: boolean;
}

export interface S3ServiceConfig {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  readonly region: string;
}

/** Product-level external-service credentials (e.g. BackWPup remote storage). */
export interface ServiceConfig {
  readonly storage?: {
    readonly ftp?: FtpServiceConfig;
    readonly s3?: S3ServiceConfig;
  };
}

/** Per-site overrides of {@link ServiceConfig} (deep-partial); merged over the product globals. */
export interface ServiceOverrides {
  readonly storage?: {
    readonly ftp?: Partial<FtpServiceConfig>;
    readonly s3?: Partial<S3ServiceConfig>;
  };
}

/** A WordPress site exactly as declared in a product's `sites.json` (no derived fields). */
export interface SiteInput {
  readonly baseURL: string;
  readonly username: string;
  readonly password: string;
  readonly transport: Transport;
  /** Optional per-site service overrides (e.g. a separate FTP host to dodge rate limits). */
  readonly overrides?: ServiceOverrides;
}

/** A site resolved for a run: the declared input plus its computed per-run `storageState` path. */
export interface SiteConfig extends SiteInput {
  readonly storageState: string;
}

/** A pool of interchangeable sites backing one cell. */
export type SitePool = readonly SiteInput[];

/**
 * Plugin edition under test — the **behavioral tier** (Free vs Pro), a property of a cell.
 * Free and Pro are separate plugin packages (e.g. BackWPup); edition drives scenario
 * filtering (`@free`/`@pro`) and edition-aware page objects.
 *
 * Distinct from an APVM build **variant** (`free`/`pro-de`/`pro-en`): edition is binary and
 * language-blind, whereas a variant names an exact buildable package including language. The
 * artifacts manifest maps each edition to the one variant it builds (`pro` → `pro-en`); the
 * two are deliberately different namespaces (see `artifacts/types.ts`).
 */
export type Edition = "free" | "pro";

/**
 * One cell: its site pool plus, for edition-ful products (e.g. BackWPup), the `edition`
 * the whole cell runs. Editionless products (e.g. WP Rocket) omit `edition`.
 */
export interface CellConfig {
  readonly edition?: Edition;
  readonly sites: SitePool;
}

/** Cell name → its config. The set of cells is data-driven (the keys of `sites.json`). */
export type CellMap = Readonly<Record<string, CellConfig>>;

/** Everything that defines a product (one BDD project family). */
export interface ProductConfig {
  readonly name: string;
  // `features`/`steps` are passed to playwright-bdd's `defineBddConfig`, which expects
  // mutable `string | string[]`.
  readonly features: string | string[];
  readonly steps: string[];
  readonly sites: CellMap;
  /**
   * The plugin artifacts (zips under test) this product resolves and verifies per run —
   * default refs, version/edition policy, and per-edition identity expectations. Required,
   * so a new product can never silently ship without a build source. See
   * {@link ProductArtifacts}.
   */
  readonly artifacts: ProductArtifacts;
  /**
   * How this product's `debug.log` is scanned by the shared scenario hooks: its verified-benign
   * `ignore` patterns, and optionally a `source` restriction. Declared here (rather than
   * imported by the hooks) so the shared hooks stay product-agnostic. Omit to scan every line
   * and ignore nothing — the strictest reading, so a missing preset can only make the gate
   * stricter, never quieter.
   */
  readonly debugLog?: ScanDebugLogOptions;
  readonly services?: ServiceConfig;
}
