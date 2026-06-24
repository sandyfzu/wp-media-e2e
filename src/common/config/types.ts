/**
 * Configuration types shared across products.
 *
 * A `product` (wp-rocket, backwpup, …) declares its features/steps, its service
 * configuration, and a map of `cell` → cell config. A `cell` is a named environment
 * (e.g. "apache", "nginx", "pro@nginx"); each holds a pool of interchangeable WordPress
 * instances across which that product's scenarios are distributed, plus an optional
 * edition (Free/Pro) for edition-ful products.
 */

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
  /** WordPress root on the host; optional when `wp` resolves it from the working directory. */
  readonly rootDir?: string;
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

/** Plugin edition under test. Free and Pro are separate plugin packages (e.g. BackWPup). */
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
  readonly services?: ServiceConfig;
}
