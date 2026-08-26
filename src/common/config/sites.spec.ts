import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSites } from "./sites";
import type { SshTransport } from "./types";

/**
 * Transport parsing, from the JSON an operator writes to the object the exec layer receives.
 *
 * Narrow on purpose: `validateTransport` rebuilds the transport field by field rather than spreading
 * the parsed object, so a field nobody wires through is **silently dropped**. That is harmless for a
 * value like `stagingDir` (the default is fine) and not harmless at all for `elevate`, whose whole
 * job is to *withhold* privileged cleanup — a site that asked for unprivileged cleanup and quietly
 * got the privileged kind is the one failure mode worth a test of its own.
 */

let configDir: string;

/** Writes a `sites.json` whose single site carries `transport`, and returns its parsed form. */
function loadTransport(transport: Record<string, unknown>): SshTransport {
  writeFileSync(
    join(configDir, "sites.json"),
    JSON.stringify({
      nginx: {
        sites: [
          {
            baseURL: "https://site.example.test",
            username: "admin",
            password: "pw",
            transport,
          },
        ],
      },
    }),
  );
  const site = loadSites(configDir).nginx?.sites[0];
  if (site === undefined) throw new Error("the pool should hold one site");
  return site.transport as SshTransport;
}

const SSH = {
  mode: "ssh",
  host: "203.0.113.10",
  username: "ubuntu",
  privateKeyPath: "/home/ci/.ssh/id_ed25519",
  rootDir: "/var/www/html/site",
};

test.beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "wp-sites-config-"));
});

test.afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

test.describe("transport parsing — the elevation opt-out", () => {
  test("elevate:false reaches the transport, so cleanup really stays unprivileged", () => {
    expect(loadTransport({ ...SSH, elevate: false }).elevate).toBe(false);
  });

  test("elevate:true reaches the transport", () => {
    expect(loadTransport({ ...SSH, elevate: true }).elevate).toBe(true);
  });

  // Absent rather than present-and-undefined, matching how `stagingDir` is handled: under
  // `exactOptionalPropertyTypes` the difference is a type error waiting to happen.
  test("an undeclared elevate is omitted entirely, not set to undefined", () => {
    const transport = loadTransport(SSH);
    expect("elevate" in transport).toBe(false);
  });

  // Coercion would be the dangerous default: `"false"` is a string, and reading it as truthy would
  // grant exactly the privilege its author was switching off.
  test("a non-boolean elevate is rejected, naming the field", () => {
    expect(() => loadTransport({ ...SSH, elevate: "false" })).toThrow(
      /transport\.elevate must be a boolean/,
    );
  });

  // The two share one construction step, so this pins that adding elevate did not displace it.
  test("stagingDir still survives alongside it", () => {
    const transport = loadTransport({
      ...SSH,
      stagingDir: "/srv/e2e-staging",
      elevate: false,
    });
    expect(transport.stagingDir).toBe("/srv/e2e-staging");
    expect(transport.elevate).toBe(false);
  });
});
