import type { AlertConfig } from '../grafana/grafana-payload.types.js';

export function getLokiHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export function logConfigurationLoaded(
  secretName: string,
  config: AlertConfig,
): void {
  console.info('Alert configuration loaded', {
    secretName,
    lokiHost: getLokiHost(config.lokiBaseUrl),
    lookbackMinutes: config.lookbackMinutes,
    errorPattern: config.errorPattern,
    slackConfigured: config.slackWebhookUrl.length > 0,
    bedrockEnabled: config.bedrock.enabled,
    bedrockModelId: config.bedrock.enabled ? config.bedrock.modelId : undefined,
    bedrockRegion: config.bedrock.enabled ? config.bedrock.region : undefined,
  });
}

export function logLokiQuery(input: {
  baseUrl: string;
  job: string;
  errorPattern: string;
  query: string;
}): void {
  console.info('Querying Loki', {
    lokiHost: getLokiHost(input.baseUrl),
    job: input.job,
    errorPattern: input.errorPattern,
    query: input.query,
  });
}

export function logSlackMessagePreview(input: {
  job: string;
  alertname: string;
  message: string;
}): void {
  console.info('Slack message preview', {
    job: input.job,
    alertname: input.alertname,
    message: input.message,
  });
}

export function formatFetchError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = error.cause;
  if (cause instanceof Error) {
    return `${error.message}: ${cause.message}`;
  }

  if (cause !== undefined) {
    return `${error.message}: ${String(cause)}`;
  }

  return error.message;
}
