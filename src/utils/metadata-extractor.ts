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

function parseAlertName(alertName: string): ExtractedMetadata {
  const cleaned = alertName.replace(/\s*[-–—].*$/, '').trim();
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
    }).format(new Date(ms));
  } catch {
    return null;
  }
}

export function formatDisplayTime(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const timeOnly = value.match(/(\d{1,2}:\d{2}:\d{2}\s*[AP]M)/i);
  if (timeOnly) {
    return timeOnly[1];
  }

  return value;
}
