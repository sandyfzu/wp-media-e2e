import { test, expect } from "@playwright/test";

import {
  normaliseOptionFragment,
  normaliseResidueCapability,
  normaliseResidueRole,
} from "../../../common/wp/db-residue";
import {
  BACKWPUP_ADMIN_CAPABILITIES,
  BACKWPUP_ROLES,
  BACKWPUP_SITE_DB_RESIDUE,
} from "./db-residue";

/**
 * BackWPup's database-footprint declaration, held to the sweep's own rules: a declaration the sweep
 * refuses would fail every `@plugin` scenario's Before hook, so it is caught here instead.
 */

test.describe("BACKWPUP_SITE_DB_RESIDUE", () => {
  const fragments = (BACKWPUP_SITE_DB_RESIDUE.optionsContaining ?? []).map(
    normaliseOptionFragment,
  );

  test("declares roles and capabilities the sweep accepts as the plugin's own", () => {
    for (const role of BACKWPUP_SITE_DB_RESIDUE.roles ?? []) {
      expect(normaliseResidueRole(role, fragments)).toBe(role);
    }
    for (const capability of BACKWPUP_SITE_DB_RESIDUE.capabilities ?? []) {
      expect(normaliseResidueCapability(capability, fragments)).toBe(
        capability,
      );
    }
  });

  // The names `inc/class-install.php` registers and `uninstall.php` removes: three roles, and eleven
  // capabilities granted to the administrator.
  test("declares the plugin's three roles and its eleven administrator capabilities", () => {
    expect(BACKWPUP_SITE_DB_RESIDUE.roles).toEqual(BACKWPUP_ROLES);
    expect(BACKWPUP_ROLES).toEqual([
      "backwpup_admin",
      "backwpup_check",
      "backwpup_helper",
    ]);
    expect(BACKWPUP_SITE_DB_RESIDUE.capabilities).toEqual(
      BACKWPUP_ADMIN_CAPABILITIES,
    );
    expect(new Set(BACKWPUP_ADMIN_CAPABILITIES).size).toBe(11);
  });
});
