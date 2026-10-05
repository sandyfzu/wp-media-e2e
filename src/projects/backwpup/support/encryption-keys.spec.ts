import { test, expect } from "@playwright/test";
import { createPrivateKey, createPublicKey } from "node:crypto";

import {
  HEX_KEY_NAMES,
  KEY_FILES,
  ScenarioKeys,
  generatePemKeyPair,
} from "./encryption-keys";
import type { KeyFolder, PemKeyPair } from "./encryption-keys";

/** A stand-in private folder, recording what was placed in it. */
function folder(): KeyFolder & { readonly placed: Map<string, string> } {
  const placed = new Map<string, string>();
  return {
    placed,
    place: (name, content) => {
      placed.set(name, content);
      return Promise.resolve();
    },
    relativePathTo: (name) => Promise.resolve(`.e2e_temp/private/k/${name}`),
  };
}

/** A key pair made by a test, counting how often it was asked for. */
function pairs(): {
  readonly generate: () => Promise<PemKeyPair>;
  made: number;
} {
  const counter = {
    made: 0,
    generate: (): Promise<PemKeyPair> => {
      counter.made++;
      return Promise.resolve({
        publicKey: "PUBLIC PEM",
        privateKey: "PRIVATE PEM",
      });
    },
  };
  return counter;
}

test.describe("ScenarioKeys.hexKey", () => {
  // AES-256: the length BackWPup's settings generate, and one both commands accept.
  test("draws 64 hex characters for each name", () => {
    const keys = new ScenarioKeys(folder());
    for (const name of HEX_KEY_NAMES) {
      expect(keys.hexKey(name)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("keeps a key the same for the rest of the scenario", () => {
    const keys = new ScenarioKeys(folder());
    expect(keys.hexKey("encryption key")).toBe(keys.hexKey("encryption key"));
  });

  // "The wrong key" only means something if it differs from the right one.
  test("never draws the same key for the two names", () => {
    const keys = new ScenarioKeys(folder());
    expect(keys.hexKey("encryption key")).not.toBe(
      keys.hexKey("another encryption key"),
    );
  });

  // Randomness never repeats in practice, so the guard is exercised with a draw that does.
  test("draws again when a key comes out the same as the other one", () => {
    const draws = ["a".repeat(64), "a".repeat(64), "b".repeat(64)];
    const keys = new ScenarioKeys(folder(), pairs().generate, () => {
      const next = draws.shift();
      if (next === undefined) throw new Error("drew more often than expected");
      return next;
    });
    expect(keys.hexKey("encryption key")).toBe("a".repeat(64));
    expect(keys.hexKey("another encryption key")).toBe("b".repeat(64));
    expect(draws).toEqual([]);
  });

  test("draws a fresh key for every scenario", () => {
    expect(new ScenarioKeys(folder()).hexKey("encryption key")).not.toBe(
      new ScenarioKeys(folder()).hexKey("encryption key"),
    );
  });
});

test.describe("ScenarioKeys key files", () => {
  test("places both halves of the pair the first time either is asked for, and hands out their paths", async () => {
    const stand = folder();
    const counter = pairs();
    const keys = new ScenarioKeys(stand, counter.generate);
    expect(await keys.privateKeyFile()).toBe(
      `.e2e_temp/private/k/${KEY_FILES.private}`,
    );
    expect(await keys.publicKeyFile()).toBe(
      `.e2e_temp/private/k/${KEY_FILES.public}`,
    );
    expect(stand.placed).toEqual(
      new Map([
        [KEY_FILES.public, "PUBLIC PEM"],
        [KEY_FILES.private, "PRIVATE PEM"],
      ]),
    );
    expect(counter.made).toBe(1);
  });

  test("makes and places nothing until a key file is asked for", () => {
    const stand = folder();
    const counter = pairs();
    const keys = new ScenarioKeys(stand, counter.generate);
    keys.hexKey("encryption key");
    expect(counter.made).toBe(0);
    expect(stand.placed.size).toBe(0);
  });

  test("makes the pair once, however often and however concurrently it is asked for", async () => {
    const counter = pairs();
    const keys = new ScenarioKeys(folder(), counter.generate);
    await Promise.all([
      keys.publicKeyFile(),
      keys.privateKeyFile(),
      keys.publicKeyFile(),
    ]);
    expect(counter.made).toBe(1);
  });

  test("passes on a placement that failed", async () => {
    const keys = new ScenarioKeys(
      {
        place: () => Promise.reject(new Error("could not write")),
        relativePathTo: (name) => Promise.resolve(name),
      },
      pairs().generate,
    );
    await expect(keys.publicKeyFile()).rejects.toThrow(/could not write/);
  });
});

test.describe("generatePemKeyPair", () => {
  // The forms measured to round-trip through backup-encrypt and backup-decrypt.
  test("makes an RSA-2048 pair, its public half SPKI PEM and its private half PKCS#8 PEM", async () => {
    const { publicKey, privateKey } = await generatePemKeyPair();
    expect(publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----\n/);
    expect(privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    const pub = createPublicKey(publicKey);
    expect(pub.asymmetricKeyType).toBe("rsa");
    expect(pub.asymmetricKeyDetails?.modulusLength).toBe(2048);
    // The two halves belong together.
    expect(
      createPublicKey(createPrivateKey(privateKey)).export({
        type: "spki",
        format: "pem",
      }),
    ).toBe(publicKey);
  });
});
