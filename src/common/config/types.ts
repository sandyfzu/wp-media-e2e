/**
 * Configuration types shared across products.
 *
 * A `product` (wp-rocket, backwpup, …) declares its features/steps, its service
 * configuration, and a map of `cell` → cell config. A `cell` is a named environment
 * (e.g. "apache", "nginx", "pro@nginx"); each holds a pool of interchangeable WordPress
 * instances across which that product's scenarios are distributed, plus an optional
 * edition (Free/Pro) for edition-ful products.
 */

// Type-only import (erased at runtime under `verbatimModuleSyntax`), so the config↔artifacts
// type reference introduces no runtime module cycle. The artifacts manifest schema lives with
// the rest of that domain in `../artifacts/types`; it is re-exported here so product-config
// authors get it and `ProductConfig` from one place.
import type { ProductArtifacts } from "../artifacts/types";
export type { ProductArtifacts };

/** WordPress hosting mode — decides how WP-CLI is dispatched (see the exec layer, a later phase). */
export type ServerMode = "ssh" | "docker" | "local";

export interface SshTransport {
  readonly mode: "ssh";
  readonly host: string;
  readonly username: string;
  readonly privateKeyPath: string;
  readonly rootDir: string;
}

export interface DockerTransport {
  readonly mode: "docker";
  readonly container: string;
}

export interface LocalTransport {
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
  readonly services?: ServiceConfig;
}
