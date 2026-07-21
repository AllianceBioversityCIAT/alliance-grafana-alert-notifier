import type { AlertConfig } from '../grafana/grafana-payload.types.js';
import { getSecretJson } from '../secrets/get-secret.js';

let cachedConfig: AlertConfig | undefined;
let cachedSecretName: string | undefined;

function parseLookbackMinutes(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('LOOKBACK_MINUTES must be a positive integer');
  }
  return parsed;
}

export async function getConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AlertConfig> {
  const secretName = env.ALERTING_SECRET_NAME?.trim();
  if (!secretName) {
    throw new Error('ALERTING_SECRET_NAME environment variable is required');
  }

  if (cachedConfig && cachedSecretName === secretName) {
    return cachedConfig;
  }

  const secret = await getSecretJson<Record<string, string>>(secretName);

  cachedConfig = {
    lokiBaseUrl: secret.LOKI_BASE_URL.trim(),
    slackWebhookUrl: secret.SLACK_WEBHOOK_URL.trim(),
    lookbackMinutes: parseLookbackMinutes(secret.LOOKBACK_MINUTES),
    errorPattern: secret.DEFAULT_ERROR_PATTERN.trim(),
  };
  cachedSecretName = secretName;

  return cachedConfig;
}

export function resetConfigCache(): void {
  cachedConfig = undefined;
  cachedSecretName = undefined;
}
