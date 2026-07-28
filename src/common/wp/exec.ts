import { statSync } from "node:fs";
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
): Promise<ExecResult> {
  const result = await execa(file, args, {
    reject: false,
    cwd: options.cwd ?? transport.rootDir,
  });
  return fromExeca(file, result);
}

/** The `docker` argv (after the `docker` binary) to run `file args…` inside a running container. */
export function dockerArgv(
  container: string,
  file: string,
  args: string[],
): string[] {
  return ["exec", container, file, ...args];
}

async function runDocker(
  transport: DockerTransport,
  file: string,
  args: string[],
): Promise<ExecResult> {
  const result = await execa(
    "docker",
    dockerArgv(transport.container, file, args),
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
): Promise<ExecResult> {
  const ssh = await connection(transport);
  // node-ssh `exec` shell-escapes `args`, so this is injection-safe.
  const result = await ssh.exec(file, args, {
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

/** Runs `file args…` through the transport and returns its {@link ExecResult}. */
export function exec(
  transport: Transport,
  file: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  switch (transport.mode) {
    case "local":
      return runLocal(transport, file, args, options);
    case "docker":
      return runDocker(transport, file, args);
    case "ssh":
      return runSsh(transport, file, args, options);
    default: {
      // Exhaustiveness: assigning to `never` makes an unhandled transport mode a compile error.
      const exhaustive: never = transport;
      throw new Error(
        `[wp/exec] unsupported transport: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/** Runs WP-CLI (`wp args…`) through the transport. The primary entry point for the WP layer. */
export function wpCli(
  transport: Transport,
  args: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  return exec(transport, "wp", args, options);
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
