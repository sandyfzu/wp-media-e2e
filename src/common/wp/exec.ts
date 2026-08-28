import { statSync } from "node:fs";
import { posix } from "node:path";
import { copyFile } from "node:fs/promises";

import { execa } from "execa";
import { NodeSSH } from "node-ssh";

import type {
  DockerTransport,
  LocalTransport,
  SshTransport,
  Transport,
} from "../config/types";

/**
 * Transport-agnostic command execution **and file transfer** for the WordPress automation layer.
 *
 * A command is given as a file + array of args — never a shell string — so there is no
 * shell interpolation and no injection. It is dispatched by the site's {@link Transport}:
 * `local`/`docker` via execa, `ssh` via node-ssh (whose `exec` shell-escapes the args).
 *
 * Every mode returns a structured {@link ExecResult} with an `exitCode`, so callers branch
 * on the code (e.g. WP-CLI `is-installed`) instead of relying on thrown errors. A failure
 * to *run* the command at all — missing binary, unreachable SSH host, killed by a signal —
 * throws, because that is an environment fault, not a command outcome.
 *
 * **Some housekeeping cannot be done as the transport's user at all**, and that is not a
 * misconfiguration to work around. A plugin writes files as the *web-server* user; when it also
 * creates a directory only that user can write (BackWPup's restore area is `0755 www-data`), nothing
 * else can unlink inside it, and the site keeps that data for every scenario that ever ran. So this
 * layer offers {@link execElevated} — the same file+args dispatch, run with privileges — plus
 * {@link elevationSupport} so a caller can ask before relying on it.
 *
 * Elevation is deliberately **narrow**, because a test suite holding root is only safe while what it
 * does with it is boring:
 *
 *  - **Only ever housekeeping.** Removing leftover files, clearing `debug.log`. Never `wp`: WP-CLI
 *    refuses to run as root without `--allow-root`, and files it created as root would be unwritable
 *    by the web server afterwards — the suite would break the site it is testing. {@link wpCli} has
 *    no way to request it, which is what makes that rule structural rather than a convention.
 *  - **Never on the path a scenario asserts against.** Elevation cannot make a product behaviour
 *    pass; it only removes what the product left behind after the verdict is in.
 *  - **Attempted second, never first.** Callers try as themselves and escalate only when the
 *    unprivileged attempt demonstrably failed, so a correctly-permissioned host never runs anything
 *    as root.
 *  - **Never interactive.** `sudo -n` fails immediately rather than waiting on a password prompt, so
 *    a host without passwordless sudo reports that instead of hanging a run.
 *  - **Refusable per site** (`transport.elevate: false`), and reported once per target when used.
 *
 * Running a command is not enough on its own: WP-CLI reads files from the **site's**
 * filesystem, so anything a test hands to `wp` (a plugin zip, a WXR import, a DB dump) must
 * exist there first. {@link copyIntoTarget} is that missing primitive, per transport
 * (`node:fs` copy / `docker cp` / SFTP), and {@link wpRootDir} resolves the absolute root the
 * copy target hangs off. Both live here, at the transport boundary, so the cached SSH
 * connection and the per-mode dispatch stay in one place; the staging-area layout and lifecycle
 * built on top of them live in `./staging.ts`.
 */

/** Structured outcome of a command run through a transport. */
export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  /** The process exit code. A run that could never start throws instead of returning. */
  readonly exitCode: number;
}

/** Per-call options. */
export interface ExecOptions {
  /** Working directory (local & ssh). Ignored by `docker` — the container defines it. */
  readonly cwd?: string;
}

/** Strips a single trailing newline, matching execa's default so all transports agree. */
function stripFinalNewline(text: string): string {
  return text.replace(/\r?\n$/, "");
}

/** Maps an execa result (run with `reject: false`) to an {@link ExecResult}, or throws if it never ran. */
function fromExeca(
  label: string,
  result: {
    stdout: string;
    stderr: string;
    exitCode?: number;
    shortMessage?: string;
  },
): ExecResult {
  if (typeof result.exitCode !== "number") {
    throw new Error(
      `[wp/exec] "${label}" did not run: ${result.shortMessage ?? "the process failed to start or was terminated by a signal"}`,
    );
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

// ── local & docker: execa (array args ⇒ no shell, no injection) ──────────────

async function runLocal(
  transport: LocalTransport,
  file: string,
  args: string[],
  options: ExecOptions,
  elevate: boolean,
): Promise<ExecResult> {
  const [command, commandArgs] = elevate
    ? ["sudo", sudoArgv(file, args)]
    : [file, args];
  const result = await execa(command, commandArgs, {
    reject: false,
    cwd: options.cwd ?? transport.rootDir,
  });
  return fromExeca(command, result);
}

/**
 * The `docker` argv (after the `docker` binary) to run `file args…` inside a running container.
 *
 * `asRoot` is how elevation works for this transport: the wp-cli containers run as `www-data`
 * (`user: "33:33"` in the compose file) so that files WP-CLI creates match the web server's
 * ownership, which leaves the same gap an SSH user has. `-u 0:0` is the answer rather than `sudo`,
 * because the official `wordpress:cli` image has no sudo binary — and there is nothing to escalate
 * *to*: the daemon already runs as root, so this only chooses which user it hands the process.
 */
export function dockerArgv(
  container: string,
  file: string,
  args: string[],
  options: { readonly asRoot?: boolean } = {},
): string[] {
  const asRoot = options.asRoot === true ? ["-u", "0:0"] : [];
  return ["exec", ...asRoot, container, file, ...args];
}

/**
 * The `sudo` argv (after the `sudo` binary) that runs `file args…` with privileges.
 *
 * `-n` never prompts — a host without passwordless sudo fails the call instead of blocking a run on
 * a password nobody will type. `--` ends sudo's own option parsing, so a target command or argument
 * beginning with `-` can never be read as a flag to sudo itself.
 */
export function sudoArgv(file: string, args: string[]): string[] {
  return ["-n", "--", file, ...args];
}

async function runDocker(
  transport: DockerTransport,
  file: string,
  args: string[],
  elevate: boolean,
): Promise<ExecResult> {
  const result = await execa(
    "docker",
    dockerArgv(transport.container, file, args, { asRoot: elevate }),
    { reject: false },
  );
  return fromExeca(`docker exec ${transport.container} ${file}`, result);
}

// ── ssh: node-ssh, with a per-host connection cache reused across calls ───────

const connections = new Map<string, NodeSSH>();

/** Cache key for one SSH endpoint (host + user + key), so calls to the same site reuse a connection. */
function connectionKey(transport: SshTransport): string {
  return `${transport.username}@${transport.host}#${transport.privateKeyPath}`;
}

async function connection(transport: SshTransport): Promise<NodeSSH> {
  const key = connectionKey(transport);
  const existing = connections.get(key);
  if (existing?.isConnected()) return existing;
  // A cached-but-dead client is replaced below; release its resources first.
  existing?.dispose();
  const ssh = new NodeSSH();
  await ssh.connect({
    host: transport.host,
    username: transport.username,
    privateKeyPath: transport.privateKeyPath,
  });
  connections.set(key, ssh);
  return ssh;
}

async function runSsh(
  transport: SshTransport,
  file: string,
  args: string[],
  options: ExecOptions,
  elevate: boolean,
): Promise<ExecResult> {
  const ssh = await connection(transport);
  const [command, commandArgs] = elevate
    ? ["sudo", sudoArgv(file, args)]
    : [file, args];
  // node-ssh `exec` shell-escapes `args`, so this is injection-safe.
  const result = await ssh.exec(command, commandArgs, {
    cwd: options.cwd ?? transport.rootDir,
    stream: "both",
  });
  if (result.code === null) {
    throw new Error(
      `[wp/exec] "${file}" on ${transport.host} was terminated by signal ${result.signal ?? "unknown"} before exiting.`,
    );
  }
  return {
    stdout: stripFinalNewline(result.stdout),
    stderr: stripFinalNewline(result.stderr),
    exitCode: result.code,
  };
}

function dispatch(
  transport: Transport,
  file: string,
  args: string[],
  options: ExecOptions,
  elevate: boolean,
): Promise<ExecResult> {
  switch (transport.mode) {
    case "local":
      return runLocal(transport, file, args, options, elevate);
    case "docker":
      return runDocker(transport, file, args, elevate);
    case "ssh":
      return runSsh(transport, file, args, options, elevate);
    default: {
      // Exhaustiveness: assigning to `never` makes an unhandled transport mode a compile error.
      const exhaustive: never = transport;
      throw new Error(
        `[wp/exec] unsupported transport: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/** Runs `file args…` through the transport, as the transport's own user. */
export function exec(
  transport: Transport,
  file: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return dispatch(transport, file, args, options, false);
}

/**
 * Runs WP-CLI (`wp args…`) through the transport. The primary entry point for the WP layer.
 *
 * Never elevated, and deliberately unable to be: see this module's header for why running WP-CLI as
 * root would damage the site under test.
 */
export function wpCli(
  transport: Transport,
  args: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  return exec(transport, "wp", args, options);
}

// ── Elevation ────────────────────────────────────────────────────────────────

/**
 * Whether this target can run a privileged housekeeping command.
 *
 *  - `available` — it can, and {@link execElevated} will work.
 *  - `unavailable` — the host has no passwordless `sudo` for the transport's user (or no `sudo` at
 *    all). Cleanup reports what it could not remove instead of escalating.
 *  - `disabled` — the site declared `transport.elevate: false`.
 */
export type ElevationSupport = "available" | "unavailable" | "disabled";

/**
 * Probe results, keyed per target so a runner talking to several sites asks each one once.
 *
 * Cached because the answer is a property of the host, not of the call — and one wasted `sudo -n
 * true` per cleanup, on every scenario, is a round-trip nobody gets anything for.
 */
const elevationProbes = new Map<string, ElevationSupport>();

/** Targets already reported as escalating, so the notice below is printed once each. */
const elevationNotices = new Set<string>();

/**
 * Identity of a target, for any cache holding a fact about the *host* rather than about a call —
 * elevation support here, detected file ownership in `./ownership.ts`.
 *
 * `local` is keyed by its WordPress root rather than globally: passwordless sudo is really a
 * property of the machine and user, so this asks at most one extra time per site, and in exchange
 * one site's answer is never attributed to another's.
 *
 * Exported so a sibling module memoises against the *same* notion of "the same target", instead of
 * inventing a second one that could disagree.
 */
export function targetKey(transport: Transport): string {
  switch (transport.mode) {
    case "ssh":
      return `ssh:${connectionKey(transport)}`;
    case "docker":
      return `docker:${transport.container}`;
    case "local":
      return `local:${transport.rootDir}`;
    default: {
      const exhaustive: never = transport;
      throw new Error(
        `[wp/exec] unsupported transport: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * Identity of one **WordPress install**, for a cache holding a fact about the install rather than
 * about the machine hosting it.
 *
 * {@link targetKey} is deliberately coarser — passwordless sudo is a property of a host and a user,
 * so asking once per host is right. File ownership is not: one host routinely serves several sites,
 * and they need not agree. Measured on a live cell, two docroots under the same `ubuntu@host`:
 * `sftp_backwpup:www-data` and `sftp_wprocket:www-data`. Keyed by host alone, whichever was probed
 * first would answer for both — misreporting one site in a fleet check, and, in any process that
 * normalised two sites, aiming a privileged `chown -R` at the wrong owner.
 *
 * The `rootDir` is used unresolved, because that is what distinguishes two sites in configuration;
 * a `docker` transport without one contributes an empty root, so the same container reached with and
 * without a declared `rootDir` keys separately rather than being assumed identical.
 */
export function installKey(transport: Transport): string {
  switch (transport.mode) {
    case "ssh":
      return `ssh:${connectionKey(transport)}#${transport.rootDir}`;
    case "docker":
      return `docker:${transport.container}#${transport.rootDir ?? ""}`;
    case "local":
      return `local:${transport.rootDir}`;
    default: {
      const exhaustive: never = transport;
      throw new Error(
        `[wp/exec] unsupported transport: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * How a target is described in operator-facing messages — enough to identify it, no secrets.
 * Exported so sibling modules name a site the same way this one does.
 */
export function describeTarget(transport: Transport): string {
  switch (transport.mode) {
    case "ssh":
      return `${transport.username}@${transport.host}`;
    case "docker":
      return `container ${transport.container}`;
    case "local":
      return transport.rootDir;
    default: {
      const exhaustive: never = transport;
      throw new Error(
        `[wp/exec] unsupported transport: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * Whether {@link execElevated} can be used against this target — asked before escalating, so a
 * caller can report the *reason* cleanup is stuck rather than a bare permission error.
 *
 * `docker` needs no probe: the daemon runs as root, so `-u 0:0` is a choice of user rather than an
 * escalation, and it cannot be refused by the container. Otherwise this runs `sudo -n true` once per
 * target. A missing `sudo` binary makes the probe *throw* on `local` (execa cannot start it) and
 * exit non-zero over `ssh`; both mean the same thing here, so both answer `unavailable`.
 */
export async function elevationSupport(
  transport: Transport,
): Promise<ElevationSupport> {
  if (transport.elevate === false) return "disabled";
  if (transport.mode === "docker") return "available";

  const key = targetKey(transport);
  const cached = elevationProbes.get(key);
  if (cached !== undefined) return cached;

  let support: ElevationSupport;
  try {
    const { exitCode } = await exec(transport, "sudo", ["-n", "true"]);
    support = exitCode === 0 ? "available" : "unavailable";
  } catch {
    // Answered, but **not remembered**. A throw means the transport failed, not that the host has
    // no passwordless sudo — and this value gates every escalation for the rest of the process, so
    // caching one dropped connection would silently stop residue being removed and ownership being
    // corrected, on a host that is fine. The ownership probes refuse this for the same reason.
    return "unavailable";
  }
  elevationProbes.set(key, support);
  return support;
}

/**
 * Forgets the memoised elevation answers. For tests, which change a target's `sudo` between cases;
 * a run has no reason to call it, since the answer is a property of the host.
 */
export function resetElevationCaches(): void {
  elevationProbes.clear();
  elevationNotices.clear();
}

/**
 * Runs `file args…` with privileges — for housekeeping only, under the limits in this module's
 * header.
 *
 * Callers are expected to have tried unprivileged first and to have checked
 * {@link elevationSupport}; this does not probe, so a target without sudo simply returns sudo's own
 * non-zero result. The first use against a target is announced once, because a suite quietly running
 * commands as root would be the wrong kind of surprise.
 *
 * @throws Error if the site declared `transport.elevate: false` — the opt-out is authoritative, so
 * it fails loudly here rather than being silently ignored by a caller that forgot to check.
 * `async` so that refusal arrives as a rejection like every other failure from this layer, rather
 * than as a synchronous throw a caller would have to guard differently.
 */
export async function execElevated(
  transport: Transport,
  file: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  if (transport.elevate === false) {
    throw new Error(
      `[wp/exec] refusing to run "${file}" with elevated privileges: this site declares ` +
        "`transport.elevate: false`. Remove that to allow privileged cleanup, or make the paths " +
        "in question writable by the transport's user.",
    );
  }
  const key = targetKey(transport);
  if (!elevationNotices.has(key)) {
    elevationNotices.add(key);
    console.info(
      `[wp/exec] using elevated privileges on ${describeTarget(transport)} for housekeeping the ` +
        "transport's user is not permitted to do — removing files the web server owns, or reading " +
        "its debug.log. Only housekeeping is ever elevated; WP-CLI never is.",
    );
  }
  return dispatch(transport, file, args, options, true);
}

/**
 * What `absolutePath` really is on the target, with every symbolic link along it resolved.
 *
 * Exists because the guards in `./paths.ts` are **lexical**: they compare path strings, so a symlink
 * anywhere in the path — the final component, or any parent — makes them agree that a target is
 * inside the WordPress root when the kernel will resolve it somewhere else entirely. Measured: with
 * `wp-content/uploads` replaced by a link, a privileged `rm -rf` of a declared residue path deleted
 * content outside the root while every guard reported success.
 *
 * `readlink -f` is the portable choice — GNU and BusyBox both resolve links and both tolerate the
 * **last** component being absent, which a path about to be created always is. Neither resolves a
 * path missing more than that, which is why the caller falls back to the parent.
 *
 * @param transport - the target site's transport.
 * @param absolutePath - the path to resolve, absolute on the target.
 * @returns the fully resolved path, or `undefined` when it could not be resolved — which a caller
 * about to run a privileged command must treat as a refusal, never as permission.
 * @throws Error if the question could not be asked at all (the transport failed).
 */
export async function resolveOnTarget(
  transport: Transport,
  absolutePath: string,
): Promise<string | undefined> {
  const { exitCode, stdout } = await exec(transport, "readlink", [
    "-f",
    "--",
    absolutePath,
  ]);
  const resolved = stdout.trim();
  return exitCode === 0 && resolved !== "" ? resolved : undefined;
}

/**
 * Refuses a privileged target whose **resolved** path leaves the site's WordPress root.
 *
 * {@link assertSafeElevatedTarget} settles the same question lexically; this settles it against the
 * filesystem, which is the half a string comparison cannot see. Both run, and they fail for
 * different reasons, so an operator is told which.
 *
 * A path that does not exist yet cannot be a symlink, so what matters is its **deepest existing
 * ancestor** — this walks up to it rather than relying on `readlink -f` tolerating an absent
 * component, which GNU and BusyBox do and other implementations do not. If nothing on the path
 * resolves, nothing is known about where a root command would land, and the only safe reading of
 * "unknown" is "no".
 *
 * @param transport - the target site's transport.
 * @param target - the absolute path the privileged command would act on.
 * @param root - the site's WordPress root, as the transport resolved it.
 * @param describeRejection - builds the message from the rule that was broken.
 * @throws Error built by `describeRejection`.
 */
export async function assertResolvedInsideRoot(
  transport: Transport,
  target: string,
  root: string,
  describeRejection: (reason: string) => string,
): Promise<void> {
  const realRoot = await resolveOnTarget(transport, root);
  const realTarget = await resolveDeepestExisting(transport, target, root);
  if (realRoot === undefined || realTarget === undefined) {
    throw new Error(
      describeRejection(
        `"${target}" could not be resolved on this site, so where a privileged command would ` +
          "land is unknown",
      ),
    );
  }
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}/`)) {
    throw new Error(
      describeRejection(
        `"${target}" really resolves to "${realTarget}", which is outside it — a symbolic link on ` +
          "the way there points out of the site",
      ),
    );
  }
}

/**
 * Resolves `target`, or its nearest ancestor that exists, without leaving `root`'s depth.
 *
 * @param transport - the target site's transport.
 * @param target - the absolute path to resolve.
 * @param root - the site's WordPress root; the walk stops once it is shorter than this.
 * @returns the resolved path of the deepest existing ancestor, or `undefined` if none resolved.
 */
async function resolveDeepestExisting(
  transport: Transport,
  target: string,
  root: string,
): Promise<string | undefined> {
  let current = target;
  while (current.length >= root.length) {
    const resolved = await resolveOnTarget(transport, current);
    if (resolved !== undefined) return resolved;
    const parent = posix.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/** Closes all cached SSH connections. Call from a worker-teardown fixture. */
export function disposeConnections(): void {
  for (const ssh of connections.values()) {
    ssh.dispose();
  }
  connections.clear();
}

// ── WordPress root resolution ────────────────────────────────────────────────

/** Resolved container WORKDIRs, keyed by container name (a running container cannot change it). */
const dockerRoots = new Map<string, string>();

/**
 * The absolute WordPress root **on the target** — the directory {@link exec} already uses as the
 * working directory for every command. Needed because a file copy cannot rely on that working
 * directory: `docker cp` and SFTP both resolve their target path themselves.
 *
 * `local`/`ssh` take it from the site's declared `rootDir`. For `docker` it is the container's
 * `WORKDIR`, which the images we use set to the WordPress root; it is read once with `pwd` and
 * cached per container, or skipped entirely when the transport declares `rootDir`.
 *
 * @throws Error if `pwd` fails in the container (e.g. it is not running) — the message names the
 * container and suggests declaring `rootDir`.
 */
export async function wpRootDir(transport: Transport): Promise<string> {
  if (transport.mode !== "docker") return transport.rootDir;
  if (transport.rootDir !== undefined) return transport.rootDir;

  const cached = dockerRoots.get(transport.container);
  if (cached !== undefined) return cached;

  const { exitCode, stdout, stderr } = await exec(transport, "pwd", []);
  const root = stdout.trim();
  if (exitCode !== 0 || root === "") {
    throw new Error(
      `[wp/exec] could not resolve the WordPress root in container "${transport.container}" ` +
        `(\`pwd\` exited ${String(exitCode)}: ${stderr.trim() || "no output"}). ` +
        "Declare `rootDir` on the docker transport to skip this lookup.",
    );
  }
  dockerRoots.set(transport.container, root);
  return root;
}

// ── File transfer (runner → target) ──────────────────────────────────────────

/**
 * Whether two paths are the same file on this filesystem — compared by device + inode, so a
 * symlink, a hard link or a differently-spelled path to one file all count. A missing path is
 * simply "not the same file"; the copy that follows then reports the real problem.
 */
function isSameFile(a: string, b: string): boolean {
  try {
    const left = statSync(a);
    const right = statSync(b);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

/** The `docker` argv (after the `docker` binary) to copy a host file into a container. */
export function dockerCpArgv(
  container: string,
  localAbs: string,
  targetAbs: string,
): string[] {
  // `docker cp` is a top-level sub-command, NOT `docker exec` — it talks to the daemon and
  // needs no shell (or even a running shell) in the container.
  return ["cp", localAbs, `${container}:${targetAbs}`];
}

/**
 * Copies a file from the runner onto the target, overwriting `targetAbs` if it exists.
 *
 * Per transport: a same-filesystem copy (`local`), `docker cp` (`docker`), or SFTP over the
 * cached connection (`ssh`). The parent directory of `targetAbs` must already exist — none of
 * the three primitives creates it (see `staging.ts`, which does the `mkdir -p` first).
 *
 * @param transport - the target site's transport.
 * @param localAbs - absolute path of the source file on the runner.
 * @param targetAbs - absolute destination path on the target.
 * @throws Error naming the transport and both paths when the copy fails.
 */
export async function copyIntoTarget(
  transport: Transport,
  localAbs: string,
  targetAbs: string,
): Promise<void> {
  switch (transport.mode) {
    case "local":
      // Source and destination can be the SAME file here — the runner and the site share one
      // filesystem, so re-staging an already-staged path, or a site whose root contains the
      // resolved artifacts, both reach this. Copying a file onto itself opens the destination
      // for truncation, which can empty the source before a byte is read; it is already staged,
      // so the copy is simply skipped.
      if (isSameFile(localAbs, targetAbs)) return;
      await copyFile(localAbs, targetAbs).catch((cause: unknown) => {
        throw new Error(
          `[wp/exec] could not copy "${localAbs}" to "${targetAbs}" on the local filesystem.`,
          { cause },
        );
      });
      return;
    case "docker": {
      const result = await execa(
        "docker",
        dockerCpArgv(transport.container, localAbs, targetAbs),
        { reject: false },
      );
      const { exitCode, stderr } = fromExeca(
        `docker cp ${localAbs} ${transport.container}:${targetAbs}`,
        result,
      );
      if (exitCode !== 0) {
        throw new Error(
          `[wp/exec] \`docker cp\` of "${localAbs}" into "${transport.container}:${targetAbs}" ` +
            `failed (exit ${String(exitCode)}): ${stderr.trim() || "no stderr"}`,
        );
      }
      return;
    }
    case "ssh": {
      const ssh = await connection(transport);
      // SFTP upload over the connection `exec` already uses; overwrites, but does NOT create
      // missing parent directories.
      await ssh.putFile(localAbs, targetAbs).catch((cause: unknown) => {
        throw new Error(
          `[wp/exec] could not upload "${localAbs}" to ${transport.username}@${transport.host}:"${targetAbs}".`,
          { cause },
        );
      });
      return;
    }
    default: {
      // Exhaustiveness: assigning to `never` makes an unhandled transport mode a compile error.
      const exhaustive: never = transport;
      throw new Error(
        `[wp/exec] unsupported transport: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}
