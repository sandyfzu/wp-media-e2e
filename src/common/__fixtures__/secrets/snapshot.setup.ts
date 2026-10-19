import { test as setup } from "@playwright/test";

import { keepSecretsOutOfFailureSnapshots } from "../../auth/authenticate";

/**
 * A setup that passes, with the auth setup's failure-snapshot hooks registered: `secrets.run.spec.ts`
 * checks that its dependent project (`snapshot.check.ts`) still gets failure snapshots — that the
 * setup worker hands the scenarios no changed environment.
 */

keepSecretsOutOfFailureSnapshots(setup);

setup("a setup that passes", () => {
  // Nothing to do: the hooks around it are what is under test.
});
