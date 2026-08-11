import { randomUUID } from 'node:crypto';
import type {
  HistoryConfig,
  ParsedGrafanaAlert,
} from '../grafana/grafana-payload.types.js';
import type {
  BedrockNormalizedEvent,
  PreprocessedLogEvent,
} from '../types/normalized-log-event.js';
import { extractApplicationMetadata } from '../utils/metadata-extractor.js';
import { buildErrorSignature } from './error-signature.js';

/**
 * The DynamoDB client is imported lazily, never at module load. With the kill
 * switch off — the default — the SDK is never pulled into the cold start, and
 * tests that inject their own `put`/`query` never load it either.
 */
export type PutHistoryItem = (input: {
  region: string;
  tableName: string;
  item: Record<string, unknown>;
}) => Promise<void>;

export type QueryHistoryDay = (input: {
  region: string;
  tableName: string;
  partitionKey: string;
}) => Promise<Record<string, unknown>[]>;

/** Keeps a single item well clear of DynamoDB's 400 KB limit. */
const MAX_REPRESENTATIVE_LOGS_CHARS = 2000;

const SECONDS_PER_DAY = 86_400;

export type AlertOutcome =
  | 'notified'
  | 'skipped_no_lines'
  | 'skipped_loki_error';

export interface AlertHistoryItem {
  pk: string;
  sk: string;
  signature: string;
  signatureText: string;
  recordedAt: string;
  alertname: string;
  job: string;
  filename: string | null;
  application: string | null;
  environment: string | null;
  modulo: string | null;
  tipoError: string | null;
  caso: string | null;
  usuario: string | null;
  occurrences: number;
  errorCount: number | null;
  firstOccurrenceNs: string | null;
  lastOccurrenceNs: string | null;
  representativeLogs: string;
  outcome: AlertOutcome;
  slackDelivered: boolean;
  usedBedrock: boolean;
  bedrockFallbackReason: string | null;
  lokiError: string | null;
  ttl: number;
}

export interface RecordAlertEventInput {
  alert: ParsedGrafanaAlert;
  config: HistoryConfig;
  outcome: AlertOutcome;
  slackDelivered: boolean;
  preprocessed?: PreprocessedLogEvent;
  analysis?: BedrockNormalizedEvent | null;
  usedBedrock?: boolean;
  bedrockFallbackReason?: string;
  lokiError?: string;
  lokiLines?: string[];
  /** Injected by tests so they never touch AWS. */
  put?: PutHistoryItem;
  /** Injected by tests; production reads the wall clock. */
  now?: Date;
}

function truncateLogs(lines: string[]): string {
  const joined = lines.join('\n');
  if (joined.length <= MAX_REPRESENTATIVE_LOGS_CHARS) {
    return joined;
  }
  return `${joined.slice(0, MAX_REPRESENTATIVE_LOGS_CHARS)}…`;
}

/**
 * The representative line the signature is computed from. Preprocessed logs are
 * preferred because `redactSecrets` already ran over them inside
 * `preprocessLogs`; raw Loki lines are the fallback for skipped alerts, which
 * never reach preprocessing.
 */
function pickRepresentativeLine(input: RecordAlertEventInput): string {
  const preprocessedLine = input.preprocessed?.representativeLogs?.[0];
  if (preprocessedLine) {
    return preprocessedLine;
  }
  return input.lokiLines?.[0] ?? '';
}

export function buildAlertHistoryItem(
  input: RecordAlertEventInput,
): AlertHistoryItem {
  const now = input.now ?? new Date();
  const recordedAt = now.toISOString();
  const analysis = input.analysis ?? null;

  const { signature, signatureText } = buildErrorSignature({
    module: analysis?.modulo ?? null,
    errorType: analysis?.tipoError ?? null,
    representativeLine: pickRepresentativeLine(input),
  });

  const logLines =
    input.preprocessed?.representativeLogs ?? input.lokiLines ?? [];

  // The skipped paths never reach `preprocessLogs`, so without this fallback
  // every skipped record stored nulls and the weekly report dropped them into an
  // "unknown application" bucket. `extractApplicationMetadata` is pure over the
  // alert name and job — the same two strings `preprocessLogs` feeds it — so the
  // semantics are identical on all three outcomes.
  const metadata = extractApplicationMetadata({
    alertName: input.alert.alertname,
    job: input.alert.job,
  });

  return {
    // Per-day partition: a weekly report is 7 Query calls, "last N days" works
    // for any N, and no partition grows without bound.
    pk: `DAY#${recordedAt.slice(0, 10)}`,
    sk: `${recordedAt}#${randomUUID().slice(0, 8)}`,
    signature,
    signatureText,
    recordedAt,
    alertname: input.alert.alertname,
    job: input.alert.job,
    filename: input.alert.filename ?? null,
    application: input.preprocessed?.application ?? metadata.application,
    environment: input.preprocessed?.environment ?? metadata.environment,
    modulo: analysis?.modulo ?? null,
    tipoError: analysis?.tipoError ?? null,
    caso: analysis?.caso ?? null,
    usuario: analysis?.usuario ?? null,
    occurrences: input.preprocessed?.occurrences ?? 0,
    errorCount: input.alert.errorCount ?? null,
    // Absolute instants, never display text: the report must not depend on the
    // configured timezone to order events.
    firstOccurrenceNs: input.preprocessed?.firstOccurrenceNs ?? null,
    lastOccurrenceNs: input.preprocessed?.lastOccurrenceNs ?? null,
    representativeLogs: truncateLogs(logLines),
    outcome: input.outcome,
    slackDelivered: input.slackDelivered,
    usedBedrock: Boolean(input.usedBedrock),
    bedrockFallbackReason: input.bedrockFallbackReason ?? null,
    lokiError: input.lokiError ?? null,
    ttl:
      Math.floor(now.getTime() / 1000) +
      input.config.retentionDays * SECONDS_PER_DAY,
  };
}

/**
 * Persists one processed alert. Returns whether the write happened; it never
 * throws, because a DynamoDB failure must never affect Slack delivery.
 */
export async function recordAlertEvent(
  input: RecordAlertEventInput,
): Promise<boolean> {
  if (!input.config?.enabled) {
    return false;
  }

  const item = buildAlertHistoryItem(input);

  try {
    const put =
      input.put ?? (await import('./dynamodb-client.js')).putHistoryItem;

    await put({
      region: input.config.region,
      tableName: input.config.tableName,
      item: item as unknown as Record<string, unknown>,
    });

    console.info('Alert history recorded', {
      alertname: item.alertname,
      job: item.job,
      signature: item.signature,
      outcome: item.outcome,
    });

    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Failed to record alert history', {
      alertname: item.alertname,
      job: item.job,
      table: input.config.tableName,
      error: message,
    });
    return false;
  }
}

export interface SignatureSummary {
  signature: string;
  signatureText: string;
  count: number;
  alertnames: string[];
  outcomes: Record<string, number>;
  firstSeen: string;
  lastSeen: string;
}

function toPartitionKeys(days: number, now: Date): string[] {
  const keys: string[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const day = new Date(now.getTime() - offset * SECONDS_PER_DAY * 1000);
    keys.push(`DAY#${day.toISOString().slice(0, 10)}`);
  }
  return keys;
}

/** Groups stored items by signature, most frequent first. */
export function summarizeBySignature(
  items: AlertHistoryItem[],
): SignatureSummary[] {
  const bySignature = new Map<string, SignatureSummary>();

  for (const item of items) {
    const existing = bySignature.get(item.signature);

    if (!existing) {
      bySignature.set(item.signature, {
        signature: item.signature,
        signatureText: item.signatureText,
        count: 1,
        alertnames: [item.alertname],
        outcomes: { [item.outcome]: 1 },
        firstSeen: item.recordedAt,
        lastSeen: item.recordedAt,
      });
      continue;
    }

    existing.count += 1;
    existing.outcomes[item.outcome] = (existing.outcomes[item.outcome] ?? 0) + 1;
    if (!existing.alertnames.includes(item.alertname)) {
      existing.alertnames.push(item.alertname);
    }
    if (item.recordedAt < existing.firstSeen) {
      existing.firstSeen = item.recordedAt;
    }
    if (item.recordedAt > existing.lastSeen) {
      existing.lastSeen = item.recordedAt;
    }
  }

  return [...bySignature.values()].sort((a, b) => b.count - a.count);
}

/**
 * Reads the last N days. This is the instrument for deciding, with real data,
 * whether the normalization groups correctly before any report is built on it.
 */
export async function queryAlertHistory(input: {
  config: HistoryConfig;
  days: number;
  query?: QueryHistoryDay;
  now?: Date;
}): Promise<{ items: AlertHistoryItem[]; signatures: SignatureSummary[] }> {
  const query =
    input.query ?? (await import('./dynamodb-client.js')).queryHistoryDay;
  const partitionKeys = toPartitionKeys(input.days, input.now ?? new Date());

  const perDay = await Promise.all(
    partitionKeys.map((partitionKey) =>
      query({
        region: input.config.region,
        tableName: input.config.tableName,
        partitionKey,
      }),
    ),
  );

  const items = perDay.flat() as unknown as AlertHistoryItem[];
  items.sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1));

  return { items, signatures: summarizeBySignature(items) };
}
