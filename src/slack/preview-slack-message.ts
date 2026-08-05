import { analyzeLogsWithBedrock } from '../bedrock/bedrock-log-analyzer.js';
import { buildLokiExploreUrl } from '../grafana/build-explore-url.js';
import type { AlertConfig, ParsedGrafanaAlert } from '../grafana/grafana-payload.types.js';
import { buildLokiQuery } from '../loki/build-loki-query.js';
import { queryLokiErrors, toLokiLines } from '../loki/loki-client.js';
import type {
  BedrockNormalizedEvent,
  PreprocessedLogEvent,
} from '../types/normalized-log-event.js';
import { formatFetchError } from '../utils/diagnostic-log.js';
import { preprocessLogs } from '../utils/log-preprocessor.js';
import { getLookbackWindow } from '../utils/time-window.js';
import { buildSlackMessage } from './build-slack-message.js';

const LOKI_LINE_LIMIT = 10;

export interface SlackMessagePreviewResult {
  slackMessage: string;
  lokiLines: string[];
  lokiError?: string;
  preprocessed?: PreprocessedLogEvent;
  analysis?: BedrockNormalizedEvent | null;
  usedBedrock?: boolean;
  bedrockFallbackReason?: string;
  exploreUrl?: string | null;
}

export async function previewSlackMessage(input: {
  alert: ParsedGrafanaAlert;
  config: AlertConfig;
}): Promise<SlackMessagePreviewResult> {
  const window = getLookbackWindow(input.config.lookbackMinutes);
  let lokiLines: string[] = [];
  let lokiError: string | undefined;
  let preprocessed: PreprocessedLogEvent | undefined;
  let analysis: BedrockNormalizedEvent | null | undefined;
  let usedBedrock = false;
  let bedrockFallbackReason: string | undefined;

  try {
    const entries = await queryLokiErrors({
      baseUrl: input.config.lokiBaseUrl,
      job: input.alert.job,
      errorPattern: input.config.errorPattern,
      window,
      limit: LOKI_LINE_LIMIT,
    });
    lokiLines = toLokiLines(entries);

    if (entries.length > 0) {
      preprocessed = preprocessLogs({
        alert: input.alert,
        entries,
        timezone: input.config.bedrock.timezone,
        dateFormat: input.config.bedrock.dateFormat,
        maxInputChars: input.config.bedrock.maxInputChars,
      });

      const bedrockResult = await analyzeLogsWithBedrock({
        preprocessed,
        config: input.config.bedrock,
      });
      analysis = bedrockResult.analysis;
      usedBedrock = bedrockResult.usedBedrock;
      bedrockFallbackReason = bedrockResult.fallbackReason;
    }
  } catch (error) {
    lokiError = formatFetchError(error);
  }

  const enriched = Boolean(usedBedrock && analysis && preprocessed);

  const exploreUrl = buildLokiExploreUrl({
    grafanaBaseUrl: input.config.grafanaBaseUrl,
    lokiDatasourceUid: input.config.lokiDatasourceUid,
    generatorURL: input.alert.generatorURL,
    query: buildLokiQuery(input.alert.job, input.config.errorPattern),
    window,
  });

  const slackMessage = buildSlackMessage({
    alert: input.alert,
    lookbackMinutes: input.config.lookbackMinutes,
    lokiLines,
    lokiError,
    preprocessed,
    analysis,
    enriched,
    exploreUrl,
  });

  return {
    slackMessage,
    lokiLines,
    lokiError,
    preprocessed,
    analysis,
    usedBedrock,
    bedrockFallbackReason,
    exploreUrl,
  };
}
