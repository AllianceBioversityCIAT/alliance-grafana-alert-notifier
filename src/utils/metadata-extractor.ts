export interface ExtractedMetadata {
  application: string | null;
  environment: string | null;
}

const ENV_TOKENS = new Set([
  'test',
  'dev',
  'development',
  'qa',
  'stg',
  'stage',
  'staging',
  'prod',
  'production',
  'uat',
  'demo',
]);

function normalizeEnv(token: string): string {
  const lower = token.toLowerCase();
  if (lower === 'development' || lower === 'dev') {
    return 'dev';
  }
  if (lower === 'staging' || lower === 'stage' || lower === 'stg') {
    return 'staging';
  }
  if (lower === 'production' || lower === 'prod') {
    return 'prod';
  }
  return lower;
}

/**
 * Best-effort extraction from alert name / job labels.
 * Examples:
 * - "PRMS Test - Loki Error Alert" → application=PRMS, environment=test
 * - job "docker_prms_test" → application=PRMS, environment=test
 */
export function extractApplicationMetadata(input: {
  alertName: string;
  job: string;
}): ExtractedMetadata {
  const fromAlert = parseAlertName(input.alertName);
  const fromJob = parseJobName(input.job);

  return {
    application: fromAlert.application ?? fromJob.application,
    environment: fromAlert.environment ?? fromJob.environment,
  };
}

/**
 * Strip common alert suffixes so app/env tokens remain, e.g.:
 * - "PRMS Test - Loki Error Alert" → "PRMS Test"
 * - "Billing Prod - Error Alert" → "Billing Prod"
 * - "Example Loki Error Alert" → "Example"
 * - "Loki Error Alert" → ""
 */
function stripAlertSuffix(alertName: string): string {
  const trimmed = alertName.trim();
  if (/^(?:Loki\s+)?(?:Error\s+)?Alert$/i.test(trimmed)) {
    return '';
  }

  return trimmed
    .replace(/\s*[-–—]\s*(?:Loki\s+)?(?:Error\s+)?Alert\b.*$/i, '')
    .replace(/\s+Loki\s+Error\s+Alert\b.*$/i, '')
    .replace(/\s+Error\s+Alert\b.*$/i, '')
    .replace(/\s*[-–—].*$/, '')
    .trim();
}

function looksLikeStructuredAlertName(alertName: string): boolean {
  if (/(?:[-–—]\s*)?(?:Loki\s+)?(?:Error\s+)?Alert\b/i.test(alertName)) {
    return true;
  }

  const parts = alertName.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    return false;
  }

  return ENV_TOKENS.has(parts[parts.length - 1].toLowerCase());
}

function parseAlertName(alertName: string): ExtractedMetadata {
  // Free-form titles ("High error rate") are ignored so the job label can win.
  if (!looksLikeStructuredAlertName(alertName)) {
    return { application: null, environment: null };
  }

  const cleaned = stripAlertSuffix(alertName);
  const parts = cleaned.split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return { application: null, environment: null };
  }

  let environment: string | null = null;
  let applicationParts = [...parts];

  const last = parts[parts.length - 1];
  if (ENV_TOKENS.has(last.toLowerCase())) {
    environment = normalizeEnv(last);
    applicationParts = parts.slice(0, -1);
  }

  const application =
    applicationParts.length > 0 ? applicationParts.join(' ') : null;

  return { application, environment };
}

function parseJobName(job: string): ExtractedMetadata {
  const tokens = job
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((token) => token !== 'docker' && token !== 'container');

  let environment: string | null = null;
  const appTokens: string[] = [];

  for (const token of tokens) {
    if (ENV_TOKENS.has(token)) {
      environment = normalizeEnv(token);
      continue;
    }
    appTokens.push(token);
  }

  const application =
    appTokens.length > 0
      ? appTokens.map((t) => t.toUpperCase()).join(' ')
      : null;

  return { application, environment };
}

const NEST_TIMESTAMP =
  /(\d{2}\/\d{2}\/\d{4},\s+\d{1,2}:\d{2}:\d{2}(?:\s*[AP]M)?)/i;

export function extractTimestampFromLogLine(line: string): string | null {
  const match = line.match(NEST_TIMESTAMP);
  return match?.[1] ?? null;
}

export function formatNsTimestamp(
  timestampNs: string,
  timeZone: string,
): string | null {
  if (!timeZone.trim()) {
    return null;
  }

  try {
    const ms = Number(BigInt(timestampNs) / 1_000_000n);
    if (!Number.isFinite(ms)) {
      return null;
    }

    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      // Without the offset a bare "2:01:33 PM" is unreadable across zones: the
      // reader cannot tell whether it is their own clock or the container's.
      timeZoneName: 'short',
    }).format(new Date(ms));
  } catch {
    return null;
  }
}

/**
 * Trim the date away for display, keeping the clock and any zone label:
 * "08/05/2026, 2:01:33 PM GMT-5" → "2:01:33 PM GMT-5".
 *
 * Splitting on the date separator rather than matching the clock alone is what
 * preserves the trailing offset; the alert already states the day elsewhere.
 */
export function formatDisplayTime(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const separator = value.indexOf(', ');
  if (separator >= 0) {
    const afterDate = value.slice(separator + 2).trim();
    if (/\d{1,2}:\d{2}:\d{2}/.test(afterDate)) {
      return afterDate;
    }
  }

  const timeOnly = value.match(/(\d{1,2}:\d{2}:\d{2}\s*[AP]M)/i);
  if (timeOnly) {
    return timeOnly[1];
  }

  return value;
}
