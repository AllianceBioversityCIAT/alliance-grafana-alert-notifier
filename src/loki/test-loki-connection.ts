import type { AlertConfig } from '../grafana/grafana-payload.types.js';
import { getLokiHost, logLokiQuery } from '../utils/diagnostic-log.js';
import { buildLokiQuery } from './build-loki-query.js';
import { queryLokiErrors, toLokiLines } from './loki-client.js';
import { getLookbackWindow } from '../utils/time-window.js';

export interface LokiConnectionTestInput {
  config: AlertConfig;
  job: string;
  limit?: number;
}

export interface LokiConnectionTestResult {
  success: boolean;
  lokiHost: string;
  job: string;
  errorPattern: string;
  query: string;
  lookbackMinutes: number;
  lineCount: number;
  sampleLines: string[];
  error?: string;
}

export async function testLokiConnection(
  input: LokiConnectionTestInput,
): Promise<LokiConnectionTestResult> {
  const query = buildLokiQuery(input.job, input.config.errorPattern);
  const window = getLookbackWindow(input.config.lookbackMinutes);

  logLokiQuery({
    baseUrl: input.config.lokiBaseUrl,
    job: input.job,
    errorPattern: input.config.errorPattern,
    query,
  });

  try {
    const entries = await queryLokiErrors({
      baseUrl: input.config.lokiBaseUrl,
      job: input.job,
      errorPattern: input.config.errorPattern,
      window,
      limit: input.limit ?? 5,
    });
    const lines = toLokiLines(entries);

    return {
      success: true,
      lokiHost: getLokiHost(input.config.lokiBaseUrl),
      job: input.job,
      errorPattern: input.config.errorPattern,
      query,
      lookbackMinutes: input.config.lookbackMinutes,
      lineCount: lines.length,
      sampleLines: lines.slice(0, 5),
    };
  } catch (error) {
    return {
      success: false,
      lokiHost: getLokiHost(input.config.lokiBaseUrl),
      job: input.job,
      errorPattern: input.config.errorPattern,
      query,
      lookbackMinutes: input.config.lookbackMinutes,
      lineCount: 0,
      sampleLines: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
