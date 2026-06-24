import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { boolEnv, env, intEnv } from "../../../common/config/env";
import { loadSites } from "../../../common/config/sites";
import type {
  ProductConfig,
  ServiceConfig,
} from "../../../common/config/types";

const configDir = dirname(fileURLToPath(import.meta.url));

/**
 * Global BackWPup storage credentials, read from the environment (tolerant: blank
 * when unset). Presence is asserted at the point of use by the service layer (a
 * later phase). A site may override any of these via its `overrides` block in
 * sites.json (plan §4.3). This config is product-private — WP Rocket never sees it.
 */
const services: ServiceConfig = {
  storage: {
    ftp: {
      host: env("BWP_FTP_HOST"),
      username: env("BWP_FTP_USERNAME"),
      password: env("BWP_FTP_PASSWORD"),
      port: intEnv("BWP_FTP_PORT", 21),
      secure: boolEnv("BWP_FTP_SECURE", true),
    },
    s3: {
      accessKeyId: env("BWP_S3_ACCESS_KEY_ID"),
      secretAccessKey: env("BWP_S3_SECRET_ACCESS_KEY"),
      bucket: env("BWP_S3_BUCKET"),
      region: env("BWP_S3_REGION", "us-east-1"),
    },
  },
};

export const backwpup: ProductConfig = {
  name: "backwpup",
  features: "src/projects/backwpup/features/**/*.feature",
  steps: [
    "src/common/fixtures.ts",
    "src/common/steps/**/*.ts",
    "src/projects/backwpup/steps/**/*.ts",
  ],
  sites: loadSites(configDir),
  services,
};
