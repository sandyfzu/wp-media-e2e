import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeSSH } from "node-ssh";

import {
  SSH_KEEPALIVE,
  copyIntoTarget,
  disposeConnections,
  exec,
} from "./exec";
import type { SshTransport } from "../config/types";

/**
 * The ssh transport when the connection breaks — under a running command, or between two.
 *
 * Against ssh2's own in-process server, reached through a local proxy the test can cut or hold
 * half-open, so nothing leaves the machine and the client side is exactly the code the cells use.
 * What is pinned is the difference between a command failing and the **worker dying** — node-ssh
 * stops listening for connection errors once a channel is open, and an unhandled `error` event is an
 * uncaught exception — and between a dead connection costing a scenario and costing a reconnect.
 */

// The few parts of ssh2's server API used here — the package ships no type declarations.
interface ExecStream {
  write(data: string): void;
  exit(code: number): void;
  end(): void;
}
interface SftpSession {
  on(event: "OPEN", listener: (reqid: number, filename: string) => void): this;
  on(
    event: "WRITE",
    listener: (
      reqid: number,
      handle: Buffer,
      offset: number,
      data: Buffer,
    ) => void,
  ): this;
  on(event: "CLOSE", listener: (reqid: number, handle: Buffer) => void): this;
  handle(reqid: number, handle: Buffer): void;
  status(reqid: number, code: number): void;
}
interface ServerSession {
  on(
    event: "exec",
    listener: (
      accept: () => ExecStream,
      reject: () => void,
      info: { command: string },
    ) => void,
  ): this;
  on(event: "sftp", listener: (accept: () => SftpSession) => void): this;
}
interface AuthContext {
  method: string;
  accept(): void;
  reject(methods: string[]): void;
}
interface ServerConnection {
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "authentication", listener: (context: AuthContext) => void): this;
  on(event: "session", listener: (accept: () => ServerSession) => void): this;
  /** Sends the client a disconnect, then half-closes the socket. */
  end(): void;
}
interface Ssh2Server {
  listen(port: number, host: string, callback: () => void): void;
  address(): net.AddressInfo;
  close(): void;
}
interface Ssh2 {
  Server: new (
    config: { hostKeys: string[] },
    listener: (connection: ServerConnection) => void,
  ) => Ssh2Server;
  utils: {
    generateKeyPairSync(type: "ed25519"): { private: string; public: string };
    sftp: { STATUS_CODE: { OK: number } };
  };
}

const ssh2 = createRequire(import.meta.url)("ssh2") as Ssh2;

let server: Ssh2Server;
let proxy: net.Server;
let keyDir: string;
/** Where node-ssh is steered to connect: the proxy, unless a test points it at a dead port. */
let connectPort: number;
/** The proxy's own port. */
let proxyPort: number;
/** While set, the proxy passes neither side's FIN on, so a half-closed link stays half-open. */
let holdFin = false;
/** Every client-facing socket the proxy accepted, newest last — what a test cuts. */
const links: net.Socket[] = [];
/** The proxy's server-facing sockets, closed with the links after each test. */
const upstreams: net.Socket[] = [];
/** Every connection the server accepted, newest last — what a test disconnects. */
const serverConnections: ServerConnection[] = [];
/** What each upload wrote, by the path it was written to. */
const uploads = new Map<string, Buffer>();
/** Every config node-ssh was asked to connect with, newest last. */
const configs: Record<string, unknown>[] = [];
/** Resolves the moment the client has a command's channel open — see {@link runningCommand}. */
let channelOpened: (() => void) | undefined;

/**
 * Answers the three requests an upload makes — open, write, close — keeping what was written in
 * {@link uploads}. The handle is the path itself, since nothing here opens two files at once.
 */
function serveUploads(sftp: SftpSession): void {
  const written = new Map<string, { offset: number; data: Buffer }[]>();
  const ok = ssh2.utils.sftp.STATUS_CODE.OK;
  sftp.on("OPEN", (reqid, filename) => {
    written.set(filename, []);
    sftp.handle(reqid, Buffer.from(filename));
  });
  sftp.on("WRITE", (reqid, handle, offset, data) => {
    written.get(handle.toString())?.push({ offset, data: Buffer.from(data) });
    sftp.status(reqid, ok);
  });
  sftp.on("CLOSE", (reqid, handle) => {
    const path = handle.toString();
    const chunks = (written.get(path) ?? []).sort(
      (a, b) => a.offset - b.offset,
    );
    uploads.set(path, Buffer.concat(chunks.map((chunk) => chunk.data)));
    sftp.status(reqid, ok);
  });
}

/**
 * node-ssh's `connect` and `exec`, as far as this file calls them — typed here because the ssh2
 * types they are declared with do not resolve.
 */
interface Steerable {
  connect: (this: NodeSSH, config: Record<string, unknown>) => Promise<NodeSSH>;
  exec: (
    this: NodeSSH,
    command: string,
    parameters: string[],
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
}
const prototype = NodeSSH.prototype as unknown as Steerable;
const originalConnect = prototype.connect;
const originalExec = prototype.exec;

test.beforeAll(async () => {
  const hostKey = ssh2.utils.generateKeyPairSync("ed25519");
  const clientKey = ssh2.utils.generateKeyPairSync("ed25519");
  keyDir = mkdtempSync(join(tmpdir(), "exec-ssh-"));
  writeFileSync(join(keyDir, "id"), clientKey.private, { mode: 0o600 });

  server = new ssh2.Server({ hostKeys: [hostKey.private] }, (connection) => {
    serverConnections.push(connection);
    // Cutting the link is the point of these tests; the server side has nothing to report.
    connection.on("error", () => undefined);
    connection.on("authentication", (context) => {
      if (context.method === "publickey") context.accept();
      else context.reject(["publickey"]);
    });
    connection.on("session", (accept) => {
      accept()
        .on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          // A command that never answers, standing in for a long backup: the test breaks the
          // connection underneath it.
          if (info.command.includes("sleep")) return;
          stream.write("answered\n");
          stream.exit(0);
          stream.end();
        })
        .on("sftp", (acceptSftp) => {
          serveUploads(acceptSftp());
        });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  // Half-open on both sides, and ends passed on by hand, so a test can hold one back.
  proxy = net.createServer({ allowHalfOpen: true }, (client) => {
    const upstream = net.connect({
      port: server.address().port,
      host: "127.0.0.1",
      allowHalfOpen: true,
    });
    client.pipe(upstream, { end: false });
    upstream.pipe(client, { end: false });
    client.on("end", () => {
      if (!holdFin) upstream.end();
    });
    upstream.on("end", () => {
      if (!holdFin) client.end();
    });
    const end = (): void => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", end);
    upstream.on("error", end);
    links.push(client);
    upstreams.push(upstream);
  });
  await new Promise<void>((resolve) => {
    proxy.listen(0, "127.0.0.1", resolve);
  });
  proxyPort = (proxy.address() as net.AddressInfo).port;
  connectPort = proxyPort;

  // The transport has no port of its own, so the connection is steered here.
  prototype.connect = function (config) {
    configs.push(config);
    return originalConnect.call(this, {
      ...config,
      host: "127.0.0.1",
      port: connectPort,
    });
  };
  // node-ssh calls `onChannel` right after it stops listening for connection errors itself, which
  // is the moment an error has nobody but the transport to catch it.
  prototype.exec = function (command, parameters, options = {}) {
    return originalExec.call(this, command, parameters, {
      ...options,
      onChannel: () => {
        channelOpened?.();
      },
    });
  };
});

test.afterEach(() => {
  disposeConnections();
  holdFin = false;
  connectPort = proxyPort;
  for (const socket of [...links.splice(0), ...upstreams.splice(0)]) {
    socket.destroy();
  }
});

test.afterAll(() => {
  prototype.connect = originalConnect;
  prototype.exec = originalExec;
  proxy.close();
  server.close();
  rmSync(keyDir, { recursive: true, force: true });
});

const transport = (): SshTransport => ({
  mode: "ssh",
  host: "site.test",
  username: "tester",
  privateKeyPath: join(keyDir, "id"),
  rootDir: "/var/www/site",
});

/**
 * Starts a command that never answers, and resolves once its channel is open on the client.
 *
 * Earlier than that, node-ssh's own listener catches a connection error, so a reset landing there
 * would not exercise the transport's at all. The pending command is wrapped rather than returned,
 * since an async function returning a promise would wait for it — and it never settles on its own.
 */
async function runningCommand(): Promise<{
  readonly pending: Promise<unknown>;
}> {
  const open = new Promise<void>((resolve) => {
    channelOpened = resolve;
  });
  const pending = exec(transport(), "sleep", ["30"]);
  await open;
  return { pending };
}

/**
 * Leaves the pooled connection the way ssh2 leaves one after a server's disconnect: its own side
 * closed, the server's still open, and node-ssh still calling it connected — until the server's
 * FIN arrives, which the proxy holds back. Resolves once the client has closed its side.
 */
async function halfClose(): Promise<void> {
  holdFin = true;
  const link = links.at(-1);
  const closed = new Promise<void>((resolve) => link?.once("end", resolve));
  serverConnections.at(-1)?.end();
  await closed;
}

/** A local port nothing listens on — found by listening on one and letting it go. */
async function closedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, "127.0.0.1", resolve);
  });
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });
  return port;
}

test("a reset under a running command fails that command, naming the lost connection", async () => {
  const { pending } = await runningCommand();
  links.at(-1)?.resetAndDestroy();

  // Unhandled, the same reset is an uncaught exception that ends the whole worker process.
  await expect(pending).rejects.toThrow(
    /the connection to site\.test was lost \(read ECONNRESET\) while "sleep" was running/,
  );
});

test("the next command opens a fresh connection instead of reusing the lost one", async () => {
  const { pending } = await runningCommand();
  links.at(-1)?.resetAndDestroy();
  await pending.catch(() => undefined);

  const opened = configs.length;
  const result = await exec(transport(), "echo", ["again"]);

  expect(result.stdout).toBe("answered");
  expect(configs.length).toBe(opened + 1);
});

// ssh2 refuses every request on such a connection before sending it, while node-ssh still reports
// it connected; left to that refusal, a live run lost a scenario.
test("a command on a connection ssh2 has half-closed runs on a new one instead of being refused", async () => {
  await exec(transport(), "echo", ["first"]);
  await halfClose();
  const opened = configs.length;

  const result = await exec(transport(), "echo", ["again"]);

  expect(result.stdout).toBe("answered");
  expect(configs.length).toBe(opened + 1);
});

test("an upload over a connection ssh2 has half-closed goes through on a new one", async () => {
  const local = join(keyDir, "plugin.zip");
  writeFileSync(local, "zip bytes");
  await exec(transport(), "echo", ["first"]);
  await halfClose();
  const opened = configs.length;

  await copyIntoTarget(transport(), local, "/var/www/site/plugin.zip");

  expect(uploads.get("/var/www/site/plugin.zip")?.toString()).toBe("zip bytes");
  expect(configs.length).toBe(opened + 1);
});

// ssh2's own reason names neither the site nor the step, and is all a scenario's report would show.
test("a connection that cannot be opened fails naming the site it was for", async () => {
  connectPort = await closedPort();

  await expect(exec(transport(), "echo", ["unreachable"])).rejects.toThrow(
    /\[wp\/exec\] could not connect to tester@site\.test: connect ECONNREFUSED/,
  );
});

// A link that goes silent is never reset, so only probing notices it; unprobed, a command on it
// waits indefinitely.
test("every connection is probed, so a silent link is given up on within a minute", async () => {
  await exec(transport(), "echo", ["probe"]);

  expect(configs.at(-1)).toMatchObject({
    keepaliveInterval: SSH_KEEPALIVE.intervalMs,
    keepaliveCountMax: SSH_KEEPALIVE.countMax,
  });
  expect(
    SSH_KEEPALIVE.intervalMs * (SSH_KEEPALIVE.countMax + 1),
  ).toBeLessThanOrEqual(60_000);
});
