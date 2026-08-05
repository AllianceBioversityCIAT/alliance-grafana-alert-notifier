import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from 'aws-lambda';
import { getConfig } from './config/get-config.js';
import {
  deduplicateAlerts,
  parseGrafanaAlert,
} from './grafana/parse-grafana-alert.js';
import type { GrafanaWebhookPayload } from './grafana/grafana-payload.types.js';
import { testLokiConnection } from './loki/test-loki-connection.js';
import { previewSlackMessage } from './slack/preview-slack-message.js';
import {
  buildPreviewAlert,
  isSlackPreviewPayload,
  type SlackPreviewDiagnosticPayload,
} from './slack/slack-preview-diagnostic.js';
import { sendSlackMessage } from './slack/slack-client.js';
import { buildSlackWebhookPayload } from './slack/slack-webhook.js';
import {
  logConfigurationLoaded,
  logSlackMessagePreview,
} from './utils/diagnostic-log.js';

function jsonResponse(
  statusCode: number,
  body: Record<string, unknown>,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function parseJsonBody(body: string | undefined): unknown {
  if (!body) {
    throw new Error('Request body is required');
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error('Invalid JSON payload');
  }
}

function parseGrafanaPayload(body: unknown): GrafanaWebhookPayload {
  return body as GrafanaWebhookPayload;
}

function isLokiDiagnosticPayload(body: unknown): body is { diagnostic: 'loki'; job?: string } {
  return (
    typeof body === 'object' &&
    body !== null &&
    'diagnostic' in body &&
    (body as { diagnostic?: string }).diagnostic === 'loki'
  );
}

async function handleLokiDiagnostic(job: string): Promise<APIGatewayProxyStructuredResultV2> {
  let config: Awaited<ReturnType<typeof getConfig>>;
  try {
    config = await getConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Failed to load alerting configuration', { error: message });
    return jsonResponse(500, { message: 'Configuration error', error: message });
  }

  logConfigurationLoaded(process.env.ALERTING_SECRET_NAME ?? '', config);

  const result = await testLokiConnection({ config, job });
  console.info('Loki diagnostic result', result);

  return jsonResponse(result.success ? 200 : 502, {
    message: result.success
      ? 'Loki connection successful'
      : 'Loki connection failed',
    ...result,
  });
}

function parseRequestBody(body: string | undefined): GrafanaWebhookPayload {
  return parseGrafanaPayload(parseJsonBody(body));
}

async function handleSlackPreview(
  body: SlackPreviewDiagnosticPayload,
): Promise<APIGatewayProxyStructuredResultV2> {
  let config: Awaited<ReturnType<typeof getConfig>>;
  try {
    config = await getConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Failed to load alerting configuration', { error: message });
    return jsonResponse(500, { message: 'Configuration error', error: message });
  }

  const alert = buildPreviewAlert(body);
  logConfigurationLoaded(process.env.ALERTING_SECRET_NAME ?? '', config);

  const preview = await previewSlackMessage({ alert, config });

  logSlackMessagePreview({
    job: alert.job,
    alertname: alert.alertname,
    message: preview.slackMessage,
  });

  console.info('Slack preview generated', {
    job: alert.job,
    alertname: alert.alertname,
    lokiLineCount: preview.lokiLines.length,
  });

  return jsonResponse(200, {
    message: 'Slack preview generated',
    slackMessage: preview.slackMessage,
    lokiLineCount: preview.lokiLines.length,
    lokiLines: preview.lokiLines,
    lokiError: preview.lokiError,
  });
}

async function processAlert(
  alert: ReturnType<typeof deduplicateAlerts>[number],
  config: Awaited<ReturnType<typeof getConfig>>,
): Promise<void> {
  const preview = await previewSlackMessage({ alert, config });

  if (preview.lokiError) {
    console.error('Failed to query Loki', {
      job: alert.job,
      alertname: alert.alertname,
      error: preview.lokiError,
    });
    console.info('Skipping Slack notification: no Loki log lines available', {
      job: alert.job,
      alertname: alert.alertname,
    });
    return;
  }

  if (preview.lokiLines.length === 0) {
    console.info('Skipping Slack notification: no Loki log lines found', {
      job: alert.job,
      alertname: alert.alertname,
      lookbackMinutes: config.lookbackMinutes,
    });
    return;
  }

  logSlackMessagePreview({
    job: alert.job,
    alertname: alert.alertname,
    message: preview.slackMessage,
  });

  if (preview.bedrockFallbackReason && preview.bedrockFallbackReason !== 'bedrock_disabled') {
    console.info('Using legacy Slack message after Bedrock fallback', {
      job: alert.job,
      alertname: alert.alertname,
      reason: preview.bedrockFallbackReason,
    });
  }

  const slackPayload = buildSlackWebhookPayload(
    {
      alert,
      lookbackMinutes: config.lookbackMinutes,
      lokiLines: preview.lokiLines,
      preprocessed: preview.preprocessed,
      analysis: preview.analysis,
      enriched: Boolean(preview.usedBedrock && preview.analysis && preview.preprocessed),
      exploreUrl: preview.exploreUrl,
    },
    config.slackWebhookUrl,
  );

  try {
    await sendSlackMessage(config.slackWebhookUrl, slackPayload);
  } catch (error) {
    const slackError = error instanceof Error ? error.message : String(error);
    console.error('Failed to send Slack notification', {
      job: alert.job,
      alertname: alert.alertname,
      error: slackError,
    });
  }
}

export async function handler(
  event: APIGatewayProxyEventV2,
  _context: Context,
): Promise<APIGatewayProxyStructuredResultV2> {
  let body: unknown;

  try {
    body = parseJsonBody(event.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Invalid webhook payload', { error: message });
    return jsonResponse(400, { message });
  }

  if (isLokiDiagnosticPayload(body)) {
    return handleLokiDiagnostic(body.job ?? 'example-app');
  }

  if (isSlackPreviewPayload(body)) {
    return handleSlackPreview(body);
  }

  let payload: GrafanaWebhookPayload;
  payload = parseGrafanaPayload(body);

  const parsed = parseGrafanaAlert(payload);

  if (parsed.kind === 'resolved') {
    console.info('Ignoring resolved Grafana alert');
    return jsonResponse(200, { message: 'Resolved alert ignored' });
  }

  if (parsed.kind === 'error') {
    console.error('Invalid Grafana alert payload', { error: parsed.message });
    return jsonResponse(400, { message: parsed.message });
  }

  let config: Awaited<ReturnType<typeof getConfig>>;
  try {
    config = await getConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Failed to load alerting configuration', { error: message });
    return jsonResponse(500, { message: 'Configuration error' });
  }

  const alerts = deduplicateAlerts(parsed.alerts);

  console.info('Processing Grafana alerts', {
    totalReceived: parsed.alerts.length,
    afterDeduplication: alerts.length,
  });

  logConfigurationLoaded(process.env.ALERTING_SECRET_NAME ?? '', config);

  for (const alert of alerts) {
    await processAlert(alert, config);
  }

  return jsonResponse(200, {
    message: 'Alert processed',
    alertsProcessed: alerts.length,
  });
}
