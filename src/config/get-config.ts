import type {
  AlertConfig,
  BedrockConfig,
  HistoryConfig,
} from '../grafana/grafana-payload.types.js';
import { getSecretJson } from '../secrets/get-secret.js';

let cachedConfig: AlertConfig | undefined;
let cachedSecretName: string | undefined;

const BEDROCK_SECRET_KEYS_WHEN_ENABLED = [
  'BEDROCK_ENABLED',
  'BEDROCK_MODEL_ID',
  'BEDROCK_REGION',
  'BEDROCK_MAX_TOKENS',
  'BEDROCK_CONFIDENCE_THRESHOLD',
  'BEDROCK_TIMEOUT_MS',
  'BEDROCK_MAX_INPUT_CHARS',
  'LOG_DATE_FORMAT',
  'LOG_TIMEZONE',
] as const;

const HISTORY_SECRET_KEYS_WHEN_ENABLED = [
  'HISTORY_ENABLED',
  'HISTORY_TABLE_NAME',
  'HISTORY_REGION',
  'HISTORY_RETENTION_DAYS',
] as const;

function parseLookbackMinutes(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('LOOKBACK_MINUTES must be a positive integer');
  }
  return parsed;
}

function readOptionalString(
  secret: Record<string, string>,
  key: string,
): string | undefined {
  const value = secret[key];
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  return value.trim();
}

function requireSecretString(
  secret: Record<string, string>,
  key: string,
  feature = 'Bedrock',
): string {
  const value = readOptionalString(secret, key);
  if (!value) {
    throw new Error(
      `Secret is missing required key when ${feature} is enabled: ${key}`,
    );
  }
  return value;
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseConfidenceThreshold(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error('BEDROCK_CONFIDENCE_THRESHOLD must be between 0 and 1');
  }
  return parsed;
}

function parseBoolean(
  value: string | undefined,
  fallback: boolean,
  key = 'BEDROCK_ENABLED',
): boolean {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value for ${key}: ${value}`);
}

/**
 * Bedrock / log-normalization settings are loaded only from Secrets Manager.
 * No model IDs, regions, or thresholds are hardcoded in application config.
 */
export function getBedrockConfigFromSecret(
  secret: Record<string, string>,
): BedrockConfig {
  const enabled = parseBoolean(readOptionalString(secret, 'BEDROCK_ENABLED'), false);

  if (!enabled) {
    return {
      enabled: false,
      modelId: '',
      region: '',
      maxTokens: 0,
      confidenceThreshold: 0,
      timeoutMs: 0,
      maxInputChars: Number.MAX_SAFE_INTEGER,
      dateFormat: readOptionalString(secret, 'LOG_DATE_FORMAT') ?? '',
      timezone: readOptionalString(secret, 'LOG_TIMEZONE') ?? '',
    };
  }

  for (const key of BEDROCK_SECRET_KEYS_WHEN_ENABLED) {
    requireSecretString(secret, key);
  }

  return {
    enabled: true,
    modelId: requireSecretString(secret, 'BEDROCK_MODEL_ID'),
    region: requireSecretString(secret, 'BEDROCK_REGION'),
    maxTokens: parsePositiveInt(
      requireSecretString(secret, 'BEDROCK_MAX_TOKENS'),
      'BEDROCK_MAX_TOKENS',
    ),
    confidenceThreshold: parseConfidenceThreshold(
      requireSecretString(secret, 'BEDROCK_CONFIDENCE_THRESHOLD'),
    ),
    timeoutMs: parsePositiveInt(
      requireSecretString(secret, 'BEDROCK_TIMEOUT_MS'),
      'BEDROCK_TIMEOUT_MS',
    ),
    maxInputChars: parsePositiveInt(
      requireSecretString(secret, 'BEDROCK_MAX_INPUT_CHARS'),
      'BEDROCK_MAX_INPUT_CHARS',
    ),
    dateFormat: requireSecretString(secret, 'LOG_DATE_FORMAT'),
    timezone: requireSecretString(secret, 'LOG_TIMEZONE'),
  };
}

/**
 * Alert-history settings, loaded only from Secrets Manager like every other
 * setting. Disabled by default: with no HISTORY_* keys in the secret nothing is
 * persisted and the alert path behaves exactly as it did before.
 */
export function getHistoryConfigFromSecret(
  secret: Record<string, string>,
): HistoryConfig {
  const enabled = parseBoolean(
    readOptionalString(secret, 'HISTORY_ENABLED'),
    false,
    'HISTORY_ENABLED',
  );

  if (!enabled) {
    return {
      enabled: false,
      tableName: '',
      region: '',
      retentionDays: 0,
    };
  }

  for (const key of HISTORY_SECRET_KEYS_WHEN_ENABLED) {
    requireSecretString(secret, key, 'alert history');
  }

  return {
    enabled: true,
    tableName: requireSecretString(secret, 'HISTORY_TABLE_NAME', 'alert history'),
    region: requireSecretString(secret, 'HISTORY_REGION', 'alert history'),
    retentionDays: parsePositiveInt(
      requireSecretString(secret, 'HISTORY_RETENTION_DAYS', 'alert history'),
      'HISTORY_RETENTION_DAYS',
    ),
  };
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
    bedrock: getBedrockConfigFromSecret(secret),
    history: getHistoryConfigFromSecret(secret),
    grafanaBaseUrl: readOptionalString(secret, 'GRAFANA_BASE_URL'),
    lokiDatasourceUid: readOptionalString(secret, 'LOKI_DATASOURCE_UID'),
  };
  cachedSecretName = secretName;

  return cachedConfig;
}

export function resetConfigCache(): void {
  cachedConfig = undefined;
  cachedSecretName = undefined;
}
