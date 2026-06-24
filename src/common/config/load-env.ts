/**
 * Side-effect module: load `.env` into `process.env` before any configuration
 * reads it. Imported first by every Playwright config entry. ESM modules are
 * singletons, so the load runs exactly once per process regardless of importers.
 *
 * Real environment variables (e.g. CI secrets) are NOT overwritten by `.env`:
 * `process.loadEnvFile()` only sets keys that are not already present.
 */
try {
  process.loadEnvFile();
} catch {
  // No `.env` present (e.g. CI, where secrets come from the real environment).
}
