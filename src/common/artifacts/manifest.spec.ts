import { test, expect } from "@playwright/test";

import {
  defaultRefFor,
  hasPreviousRole,
  resolveIdentity,
  resolveVariant,
  rolesOf,
} from "./manifest";
import type { ProductArtifacts } from "./types";

/**
 * Unit tests for the pure manifest accessors. They pin the two edition-dependent decisions
 * (which roles exist; which variants/identity apply) and the programming-error guards, using
 * small manifests that mirror the real WP Rocket (editionless) and BackWPup (edition-ful) shapes.
 */

/** Editionless, embedded-version, `previous`-supporting manifest (mirrors WP Rocket). */
const EDITIONLESS: ProductArtifacts = {
  project: "wp-rocket",
  defaultRef: { plugin: "develop", previous: "tag:latest-stable" },
  version: { kind: "embedded" },
  edition: {
    kind: "editionless",
    identity: {
      slug: "wp-rocket",
      mainFile: "wp-rocket.php",
      pluginName: "WP Rocket",
    },
  },
};

/** Edition-ful, required-version, no-`previous` manifest (mirrors BackWPup today). */
const EDITIONFUL: ProductArtifacts = {
  project: "backwpup",
  defaultRef: { plugin: "develop" },
  version: { kind: "required", defaultVersion: { plugin: "9.99.99" } },
  edition: {
    kind: "editionful",
    byEdition: {
      free: {
        variant: "free",
        identity: {
          slug: "backwpup",
          mainFile: "backwpup.php",
          pluginName: "BackWPup",
        },
      },
      pro: {
        variant: "pro-en",
        identity: {
          slug: "backwpup-pro",
          mainFile: "backwpup.php",
          pluginName: "BackWPup Pro",
        },
      },
    },
  },
};

test.describe("role support", () => {
  test("previous role tracks the presence of a previous default ref", () => {
    expect(hasPreviousRole(EDITIONLESS)).toBe(true);
    expect(hasPreviousRole(EDITIONFUL)).toBe(false);
  });

  test("rolesOf lists plugin first, and previous only when supported", () => {
    expect(rolesOf(EDITIONLESS)).toEqual(["plugin", "previous"]);
    expect(rolesOf(EDITIONFUL)).toEqual(["plugin"]);
  });
});

test.describe("defaultRefFor", () => {
  test("returns the per-role default ref", () => {
    expect(defaultRefFor(EDITIONLESS, "plugin")).toBe("develop");
    expect(defaultRefFor(EDITIONLESS, "previous")).toBe("tag:latest-stable");
    expect(defaultRefFor(EDITIONFUL, "plugin")).toBe("develop");
  });

  test("throws for previous when the manifest declares none", () => {
    expect(() => defaultRefFor(EDITIONFUL, "previous")).toThrow(
      /"previous" default ref .* declares none/,
    );
  });
});

test.describe("resolveVariant", () => {
  test("is undefined for an editionless product (edition ignored)", () => {
    expect(resolveVariant(EDITIONLESS, undefined)).toBeUndefined();
    expect(resolveVariant(EDITIONLESS, "pro")).toBeUndefined();
  });

  test("maps the edition to its APVM variant (pro → pro-en, not identity)", () => {
    expect(resolveVariant(EDITIONFUL, "free")).toBe("free");
    expect(resolveVariant(EDITIONFUL, "pro")).toBe("pro-en");
  });

  test("throws when an edition-ful product is given no edition", () => {
    expect(() => resolveVariant(EDITIONFUL, undefined)).toThrow(
      /edition-ful, but no edition was supplied/,
    );
  });
});

test.describe("resolveIdentity", () => {
  test("returns the single identity for an editionless product", () => {
    expect(resolveIdentity(EDITIONLESS, undefined)).toEqual({
      slug: "wp-rocket",
      mainFile: "wp-rocket.php",
      pluginName: "WP Rocket",
    });
  });

  test("returns the edition's identity for an edition-ful product", () => {
    expect(resolveIdentity(EDITIONFUL, "free").pluginName).toBe("BackWPup");
    expect(resolveIdentity(EDITIONFUL, "free").slug).toBe("backwpup");
    expect(resolveIdentity(EDITIONFUL, "pro").pluginName).toBe("BackWPup Pro");
    expect(resolveIdentity(EDITIONFUL, "pro").slug).toBe("backwpup-pro");
  });

  test("throws when an edition-ful product is given no edition", () => {
    expect(() => resolveIdentity(EDITIONFUL, undefined)).toThrow(
      /edition-ful, but no edition was supplied/,
    );
  });
});
