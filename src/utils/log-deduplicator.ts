/** NestJS-style and ISO-like timestamps embedded in log lines. */
const TIMESTAMP_PATTERNS: RegExp[] = [
  /\d{2}\/\d{2}\/\d{4},\s+\d{1,2}:\d{2}:\d{2}(?:\s*[AP]M)?/gi,
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
  /\d{2}\/\d{2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2}(?:\s*[AP]M)?/gi,
];

const NEST_PREFIX = /^\[Nest\]\s+\d+\s+-\s+/i;

export function normalizeMessageKey(line: string): string {
  let key = line.trim();
  key = key.replace(NEST_PREFIX, '[Nest] PID - ');
  for (const pattern of TIMESTAMP_PATTERNS) {
    key = key.replace(pattern, '<TIMESTAMP>');
  }
  return key.replace(/\s+/g, ' ').trim();
}

export interface DeduplicatedGroup {
  messageKey: string;
  occurrences: number;
  firstLine: string;
  lastLine: string;
  firstIndex: number;
  lastIndex: number;
  representativeLine: string;
}

export function deduplicateLogLines(lines: string[]): DeduplicatedGroup[] {
  const groups = new Map<string, DeduplicatedGroup>();
  const order: string[] = [];

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    const messageKey = normalizeMessageKey(trimmed);
    const existing = groups.get(messageKey);

    if (!existing) {
      groups.set(messageKey, {
        messageKey,
        occurrences: 1,
        firstLine: trimmed,
        lastLine: trimmed,
        firstIndex: index,
        lastIndex: index,
        representativeLine: trimmed,
      });
      order.push(messageKey);
      return;
    }

    existing.occurrences += 1;
    existing.lastLine = trimmed;
    existing.lastIndex = index;
    existing.representativeLine = trimmed;
  });

  return order.map((key) => groups.get(key)!);
}

export function removeExactDuplicates(lines: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}
