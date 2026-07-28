import { execa } from "execa";
import { NodeSSH } from "node-ssh";

import type {
  DockerTransport,
  LocalTransport,
  SshTransport,
  Transport,
} from "../config/types";

/**
 * Transport-agnostic command execution for the WordPress automation layer.
 *
 * A command is given as a file + array of args — never a shell string — so there is no
 * shell interpolation and no injection. It is dispatched by the site's {@link Transport}:
 * `local`/`docker` via execa, `ssh` via node-ssh (whose `exec` shell-escapes the args).
 *
 * Every mode returns a structured {@link ExecResult} with an `exitCode`, so callers branch
 * on the code (e.g. WP-CLI `is-installed`) instead of relying on thrown errors. A failure
 * to *run* the command at all — missing binary, unreachable SSH host, killed by a signal —
 * throws, because that is an environment fault, not a command outcome.
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
