import { buildLokiQuery } from './build-loki-query.js';
import type { TimeWindow } from '../grafana/grafana-payload.types.js';
import type { LokiLogEntry } from '../types/normalized-log-event.js';
import { formatFetchError, logLokiQuery } from '../utils/diagnostic-log.js';

const HTTP_TIMEOUT_MS = 10_000;
const DEFAULT_LIMIT = 10;

interface LokiQueryRangeResponse {
  status: string;
  data?: {
    resultType?: string;
    result?: Array<{
      stream?: Record<string, string>;
      values?: Array<[string, string]>;
    }>;
  };
}

export interface QueryLokiErrorsInput {
  baseUrl: string;
  job: string;
  errorPattern: string;
  window: TimeWindow;
  limit?: number;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function parseLokiEntries(
  payload: LokiQueryRangeResponse,
  limit: number,
): LokiLogEntry[] {
  const entries: LokiLogEntry[] = [];

  for (const stream of payload.data?.result ?? []) {
    for (const [timestamp, line] of stream.values ?? []) {
      entries.push({
        timestampNs: timestamp,
        line,
        labels: stream.stream,
      });
    }
  }

  return entries
    .sort((a, b) =>
      a.timestampNs > b.timestampNs ? -1 : a.timestampNs < b.timestampNs ? 1 : 0,
    )
    .slice(0, limit);
}

export async function queryLokiErrors(
  input: QueryLokiErrorsInput,
): Promise<LokiLogEntry[]> {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const query = buildLokiQuery(input.job, input.errorPattern);
  const url = new URL(
    `${normalizeBaseUrl(input.baseUrl)}/loki/api/v1/query_range`,
  );

  url.searchParams.set('query', query);
  url.searchParams.set('start', input.window.startNs);
  url.searchParams.set('end', input.window.endNs);
  url.searchParams.set('direction', 'BACKWARD');
  url.searchParams.set('limit', String(limit));

  logLokiQuery({
    baseUrl: input.baseUrl,
    job: input.job,
    errorPattern: input.errorPattern,
    query,
  });

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(formatFetchError(error));
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Loki query failed with status ${response.status}: ${body.slice(0, 200)}`,
    );
  }

  const payload = (await response.json()) as LokiQueryRangeResponse;
  return parseLokiEntries(payload, limit);
}

export function toLokiLines(entries: LokiLogEntry[]): string[] {
  return entries.map((entry) => entry.line);
}
