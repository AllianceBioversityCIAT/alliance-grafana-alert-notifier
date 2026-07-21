import type { ParsedGrafanaAlert } from '../grafana/grafana-payload.types.js';
import type {
  LokiLogEntry,
  PreprocessedLogEvent,
} from '../types/normalized-log-event.js';
import { deduplicateLogLines } from './log-deduplicator.js';
import { redactSecrets } from './log-redactor.js';
import {
  extractApplicationMetadata,
  extractTimestampFromLogLine,
  formatNsTimestamp,
} from './metadata-extractor.js';
import { sanitizeLogLine } from './sanitize-log-line.js';

const STACK_TRACE_LINE = /^\s+at\s+/;
const CONTINUATION_LINE = /^\s+/;

export interface PreprocessLogsInput {
  alert: ParsedGrafanaAlert;
  entries: LokiLogEntry[];
  timezone: string;
  dateFormat: string;
  maxInputChars: number;
}

function isStackOrContinuation(line: string, previous?: string): boolean {
  if (STACK_TRACE_LINE.test(line)) {
    return true;
  }
  if (previous && CONTINUATION_LINE.test(line) && !line.includes(' ERROR ')) {
    return true;
  }
  return false;
}

/**
 * Collapse multi-line stack traces into single logical entries while preserving
 * the full stack text for the representative sample.
 */
export function groupStackTraces(lines: string[]): string[] {
  const grouped: string[] = [];
  let current: string | undefined;

  for (const line of lines) {
    if (!current) {
      current = line;
      continue;
    }

    if (isStackOrContinuation(line, current)) {
      current = `${current}\n${line}`;
      continue;
    }

    grouped.push(current);
    current = line;
  }

  if (current) {
    grouped.push(current);
  }

  return grouped;
}

function truncateRepresentativeLogs(
  logs: string[],
  maxInputChars: number,
): string[] {
  const result: string[] = [];
  let used = 0;

  for (const log of logs) {
    const extra = log.length + (result.length > 0 ? 1 : 0);
    if (used + extra > maxInputChars) {
      break;
    }
    result.push(log);
    used += extra;
  }

  if (result.length === 0 && logs[0]) {
    return [logs[0].slice(0, maxInputChars)];
  }

  return result;
}

export function preprocessLogs(
  input: PreprocessLogsInput,
): PreprocessedLogEvent {
  const cleaned = input.entries
    .map((entry) => ({
      ...entry,
      line: redactSecrets(sanitizeLogLine(entry.line)),
    }))
    .filter((entry) => entry.line.length > 0);

  const logicalLines = groupStackTraces(cleaned.map((entry) => entry.line));
  const groups = deduplicateLogLines(logicalLines);

  const totalOccurrences = groups.reduce(
    (sum, group) => sum + group.occurrences,
    0,
  );

  const sortedByIndex = [...groups].sort(
    (a, b) => a.firstIndex - b.firstIndex,
  );
  const firstGroup = sortedByIndex[0];
  const lastGroup = [...groups].sort((a, b) => a.lastIndex - b.lastIndex).at(
    -1,
  );

  const metadata = extractApplicationMetadata({
    alertName: input.alert.alertname,
    job: input.alert.job,
  });

  const firstOccurrenceFromLogs = firstGroup
    ? extractTimestampFromLogLine(firstGroup.firstLine)
    : null;
  const lastOccurrenceFromLogs = lastGroup
    ? extractTimestampFromLogLine(lastGroup.lastLine)
    : null;

  const sortedEntries = [...cleaned].sort((a, b) =>
    a.timestampNs < b.timestampNs ? -1 : a.timestampNs > b.timestampNs ? 1 : 0,
  );

  const firstEntry = sortedEntries[0];
  const lastEntry = sortedEntries.at(-1);

  const firstOccurrence =
    firstOccurrenceFromLogs ??
    (firstEntry
      ? formatNsTimestamp(firstEntry.timestampNs, input.timezone)
      : null);
  const lastOccurrence =
    lastOccurrenceFromLogs ??
    (lastEntry
      ? formatNsTimestamp(lastEntry.timestampNs, input.timezone)
      : null);

  const representativeLogs = truncateRepresentativeLogs(
    groups.map((group) => group.representativeLine),
    input.maxInputChars,
  );

  return {
    alertName: input.alert.alertname,
    status: input.alert.status,
    job: input.alert.job,
    application: metadata.application,
    environment: metadata.environment,
    filename: input.alert.filename,
    timezone: input.timezone,
    dateFormat: input.dateFormat,
    occurrences: totalOccurrences || cleaned.length,
    firstOccurrence,
    lastOccurrence,
    firstOccurrenceNs: firstEntry?.timestampNs ?? null,
    lastOccurrenceNs: lastEntry?.timestampNs ?? null,
    representativeLogs,
  };
}
