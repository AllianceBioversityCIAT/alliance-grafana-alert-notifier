import type { AlertConfig, ParsedGrafanaAlert } from '../grafana/grafana-payload.types.js';
import { queryLokiErrors } from '../loki/loki-client.js';
import { buildSlackMessage } from './build-slack-message.js';
import { formatFetchError } from '../utils/diagnostic-log.js';
import { getLookbackWindow } from '../utils/time-window.js';

const LOKI_LINE_LIMIT = 10;

export interface SlackMessagePreviewResult {
  slackMessage: string;
  lokiLines: string[];
  lokiError?: string;
}

export async function previewSlackMessage(input: {
  alert: ParsedGrafanaAlert;
  config: AlertConfig;
}): Promise<SlackMessagePreviewResult> {
  const window = getLookbackWindow(input.config.lookbackMinutes);
  let lokiLines: string[] = [];
  let lokiError: string | undefined;

  try {
    lokiLines = await queryLokiErrors({
      baseUrl: input.config.lokiBaseUrl,
      job: input.alert.job,
      errorPattern: input.config.errorPattern,
      window,
      limit: LOKI_LINE_LIMIT,
    });
  } catch (error) {
    lokiError = formatFetchError(error);
  }

  const slackMessage = buildSlackMessage({
    alert: input.alert,
    lookbackMinutes: input.config.lookbackMinutes,
    lokiLines,
    lokiError,
  });

  return { slackMessage, lokiLines, lokiError };
}
