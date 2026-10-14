import { MIN_MASKED_LENGTH } from "../../src/common/text";
import type { CheckedTask } from "./check";
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

/** A site of a checked cell. */
type Site = CheckedTask["cell"]["sites"][number];

/**
 * Every credential the tasks' sites hold — each site's WordPress password, its FTP password and its
 * S3 keys — for masking what the orchestrator logs or sends: a run's failure, a site's answer or a
 * malformed `baseURL` can quote one, and {@link secretValues} holds only the config's. Every task's,
 * selected or not: a site may serve several cells.
 *
 * @param tasks - the checked tasks.
 * @returns the values, each once, none empty.
 */
export function siteSecretValues(
  tasks: readonly Pick<CheckedTask, "cell">[],
): string[] {
  const values = tasks
    .flatMap(({ cell }) => cell.sites)
    .flatMap(siteCredentials)
    .filter((value) => value !== "");
  return [...new Set(values)];
}

/**
 * Every secret value the orchestrator holds: the config's ({@link secretValues}), its sites'
 * ({@link siteSecretValues}), then the lowercased SSH hosts that hold one ({@link hostSecretForms}).
 *
 * @param config - the config.
 * @param tasks - the checked tasks.
 * @returns the values, each once.
 */
export function allSecretValues(
  config: Pick<OrchestratorConfig, "secrets" | "notifications">,
  tasks: readonly Pick<CheckedTask, "cell">[],
): string[] {
  const values = [...secretValues(config), ...siteSecretValues(tasks)];
  return [...new Set([...values, ...hostSecretForms(tasks, values)])];
}

/**
 * The SSH hosts holding a secret, lowercased as the server's load is shown (`serverOf`): a value
 * masks only as written, and a host is the one place it is shown case-folded. Only those hosts, never
 * every secret lowercased — that would mask ordinary words (a password `BackWPup1` masking
 * `backwpup1…` in any line).
 *
 * @param tasks - the checked tasks.
 * @param secrets - the values to look for; one under the masking floor is ignored, as masking does.
 * @returns each such host lowercased, once; none written lowercase already.
 */
export function hostSecretForms(
  tasks: readonly Pick<CheckedTask, "cell">[],
  secrets: readonly string[],
): string[] {
  const values = secrets
    .map((secret) => secret.trim())
    .filter((secret) => secret.length >= MIN_MASKED_LENGTH);
  const hosts = tasks
    .flatMap(({ cell }) => cell.sites)
    .flatMap(({ transport }) =>
      transport.mode === "ssh" ? [transport.host] : [],
    )
    .filter(
      (host) =>
        host !== host.toLowerCase() &&
        values.some((secret) => host.includes(secret)),
    );
  return [...new Set(hosts.map((host) => host.toLowerCase()))];
}

/**
 * A site's credentials, those it sets.
 *
 * @param site - the site.
 * @returns its WordPress password, then its overrides' FTP password and S3 keys.
 */
function siteCredentials(site: Site): string[] {
  const { ftp, s3 } = site.overrides?.storage ?? {};
  return [
    site.password,
    ftp?.password,
    s3?.accessKeyId,
    s3?.secretAccessKey,
  ].filter((value): value is string => value !== undefined);
}
