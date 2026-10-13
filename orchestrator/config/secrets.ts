import type { OrchestratorConfig } from "./schema";

/**
 * Every secret value a config holds, for masking what the orchestrator logs or sends: the runs'
 * secrets, Slack's webhook — whole, and its path alone, which a tool may quote without the host —
 * and Datator's key. Many have no shape a pattern could recognise (a storage password, a legacy
 * 40-hex token, a webhook path), so they are masked by value.
 *
 * @param config - the config.
 * @returns the values, each once.
 */
export function secretValues(
  config: Pick<OrchestratorConfig, "secrets" | "notifications">,
): string[] {
  const webhook = config.notifications?.slack?.webhookUrl;
  const values = [
    ...Object.values(config.secrets ?? {}),
    ...(webhook === undefined ? [] : [webhook, new URL(webhook).pathname]),
    ...(config.notifications?.datator === undefined
      ? []
      : [config.notifications.datator.apiKey]),
  ];
  return [...new Set(values)];
}
