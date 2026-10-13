import type { OrchestratorConfig } from "./schema";

/**
 * Every secret value a config holds, for masking what the orchestrator logs or sends: the runs'
 * secrets, Slack's webhook ({@link webhookSecrets}) and Datator's key. Many have no shape a pattern could recognise (a storage password, a legacy
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
    ...(webhook === undefined ? [] : webhookSecrets(webhook)),
    ...(config.notifications?.datator === undefined
      ? []
      : [config.notifications.datator.apiKey]),
  ];
  return [...new Set(values)];
}

/**
 * A Slack webhook's secret parts: the URL whole, its path (a tool may quote it without the host) and
 * its last segment — the token itself, the one part not written anywhere else.
 *
 * @param webhookUrl - the webhook.
 * @returns the values; just the URL when it does not parse.
 */
export function webhookSecrets(webhookUrl: string): string[] {
  if (!URL.canParse(webhookUrl)) return [webhookUrl];
  const { pathname } = new URL(webhookUrl);
  const token = pathname
    .split("/")
    .filter((part) => part !== "")
    .at(-1);
  return [
    ...new Set([webhookUrl, pathname, ...(token === undefined ? [] : [token])]),
  ];
}
