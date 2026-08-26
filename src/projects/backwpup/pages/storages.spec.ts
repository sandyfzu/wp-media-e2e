import { test, expect } from "@playwright/test";

import {
  LOCAL_STORAGE,
  PRO_ONLY_STORAGES,
  STORAGE_LABELS,
  isProOnlyStorage,
  storageForLabel,
} from "./storages";
import type { StorageSlug } from "./storages";

/**
 * The destination vocabulary — the one table that translates between what a scenario writes and
 * what the plugin stores.
 *
 * Worth its own spec because both directions are used in anger: a feature file names a destination
 * the way the UI labels it, and every locator and job assertion works in slugs. A silent mismatch
 * would not fail loudly — it would address a *different* destination.
 */

test.describe("storageForLabel", () => {
  test("resolves every label the picker offers back to its slug", () => {
    for (const [slug, label] of Object.entries(STORAGE_LABELS)) {
      expect(storageForLabel(label), label).toBe(slug);
    }
  });

  // Scenarios are prose: they write "website server", not "Website Server".
  test("matches the way a reader would, not the way a string compares", () => {
    expect(storageForLabel("website server")).toBe(LOCAL_STORAGE);
    expect(storageForLabel("  WEBSITE SERVER  ")).toBe(LOCAL_STORAGE);
  });

  // Returning undefined rather than a fallback is what lets the caller name the bad label in its
  // error instead of quietly asserting against whichever destination came first.
  test("an unknown label resolves to nothing at all", () => {
    expect(storageForLabel("dropbox on tuesdays")).toBeUndefined();
    expect(storageForLabel("")).toBeUndefined();
  });

  // Every label must be distinct, or the reverse lookup silently prefers one of two destinations.
  test("no two destinations share a label", () => {
    const labels = Object.values(STORAGE_LABELS).map((l) => l.toLowerCase());
    expect(new Set(labels).size, "distinct storage labels").toBe(labels.length);
  });
});

test.describe("isProOnlyStorage", () => {
  test("agrees with the declared list, and the local folder is never Pro-only", () => {
    for (const slug of PRO_ONLY_STORAGES) {
      expect(isProOnlyStorage(slug), slug).toBe(true);
    }
    expect(isProOnlyStorage(LOCAL_STORAGE)).toBe(false);
  });

  test("every Pro-only slug is a destination the picker knows", () => {
    for (const slug of PRO_ONLY_STORAGES) {
      expect(Object.keys(STORAGE_LABELS)).toContain(slug satisfies StorageSlug);
    }
  });
});
