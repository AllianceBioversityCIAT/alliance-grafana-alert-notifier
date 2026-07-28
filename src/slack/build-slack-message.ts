import type { ParsedGrafanaAlert } from '../grafana/grafana-payload.types.js';
import type {
  BedrockNormalizedEvent,
  PreprocessedLogEvent,
} from '../types/normalized-log-event.js';
import { formatDisplayTime } from '../utils/metadata-extractor.js';
import { sanitizeLogLines } from '../utils/sanitize-log-line.js';

export interface BuildSlackMessageInput {
  alert: ParsedGrafanaAlert;
  lookbackMinutes: number;
  lokiLines: string[];
  lokiError?: string;
  preprocessed?: PreprocessedLogEvent;
  analysis?: BedrockNormalizedEvent | null;
  enriched?: boolean;
}

export interface SlackWorkflowPayload {
  alertname: string;
  status: string;
  job: string;
  errorCount: string;
  filename: string;
  window: string;
  latestErrors: string;
  message: string;
  alertUrl: string;
}

function displayOrUnknown(value: string | null | undefined): string {
  if (value === null || value === undefined || value.trim() === '') {
    return 'Unidentified';
  }
  return value;
}

function titleCase(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function statusLabel(status: string): string {
  return status.toLowerCase() === 'resolved' ? 'Resolved' : 'Active';
}

/**
 * Title uses application/environment extracted from alert name or job
 * (e.g. "PRMS Test - Loki Error Alert" / "docker_prms_test"), not a fixed project label.
 */
function buildEnrichedTitle(
  application: string | null,
  environment: string | null,
): string {
  const parts: string[] = [];
  if (application?.trim()) {
    parts.push(application.trim());
  }
  const envLabel = titleCase(environment);
  if (envLabel) {
    parts.push(envLabel);
  }

  if (parts.length > 0) {
    return `🚨 ${parts.join(' ')} – Error detected`;
  }

  return '🚨 Error detected';
}

export function buildEnrichedSlackMessage(input: {
  alert: ParsedGrafanaAlert;
  preprocessed: PreprocessedLogEvent;
  analysis: BedrockNormalizedEvent;
}): string {
  const { alert, preprocessed, analysis } = input;
  const lines: string[] = [
    buildEnrichedTitle(preprocessed.application, preprocessed.environment),
    '',
    `Status: ${statusLabel(alert.status)}`,
  ];

  if (preprocessed.application) {
    lines.push(`Application: ${preprocessed.application}`);
  }
  if (preprocessed.environment) {
    lines.push(`Environment: ${titleCase(preprocessed.environment)}`);
  }

  lines.push(`Job: ${alert.job}`);
  lines.push('');
  lines.push(`Module: ${displayOrUnknown(analysis.modulo)}`);
  lines.push(`User: ${displayOrUnknown(analysis.usuario)}`);
  lines.push(`Error type: ${displayOrUnknown(analysis.tipoError)}`);
  lines.push('');
  lines.push('Summary:');
  lines.push(displayOrUnknown(analysis.caso));
  lines.push('');
  lines.push(`Occurrences: ${preprocessed.occurrences}`);

  const first = formatDisplayTime(preprocessed.firstOccurrence);
  const last = formatDisplayTime(preprocessed.lastOccurrence);
  if (first) {
    lines.push(`First occurrence: ${first}`);
  }
  if (last) {
    lines.push(`Last occurrence: ${last}`);
  }

  if (alert.panelURL) {
    lines.push('');
    lines.push(`Panel: ${alert.panelURL}`);
  }
  if (alert.generatorURL) {
    lines.push(`Alert: ${alert.generatorURL}`);
  }

  return lines.join('\n');
}

export function buildSlackMessage(input: BuildSlackMessageInput): string {
  if (input.enriched && input.preprocessed && input.analysis) {
    return buildEnrichedSlackMessage({
      alert: input.alert,
      preprocessed: input.preprocessed,
      analysis: input.analysis,
    });
  }

  const sanitizedLines = sanitizeLogLines(input.lokiLines);

  const lines: string[] = [
    `:rotating_light: ${input.alert.alertname}`,
    `Status: ${input.alert.status}`,
    `Job: ${input.alert.job}`,
  ];

  if (input.alert.errorCount !== undefined) {
    lines.push(`Error count: ${input.alert.errorCount}`);
  }

  lines.push(`Window: last ${input.lookbackMinutes} minutes`);

  if (input.alert.filename) {
    lines.push(`Filename: ${input.alert.filename}`);
  }

  if (input.lokiError) {
    lines.push('');
    lines.push('Could not retrieve Loki error details.');
    lines.push(`Reason: ${input.lokiError}`);
  } else if (sanitizedLines.length > 0) {
    lines.push('');
    lines.push('Latest Loki errors:');
    lines.push(...sanitizedLines);
  }

  if (input.alert.panelURL) {
    lines.push('');
    lines.push(`Panel: ${input.alert.panelURL}`);
  }

  if (input.alert.generatorURL) {
    lines.push(`Alert: ${input.alert.generatorURL}`);
  }

  return lines.join('\n');
}

export function buildSlackWorkflowPayload(
  input: BuildSlackMessageInput,
): SlackWorkflowPayload {
  const sanitizedLines = sanitizeLogLines(input.lokiLines);
  const message = buildSlackMessage(input);

  return {
    alertname: input.alert.alertname,
    status: input.alert.status,
    job: input.alert.job,
    errorCount:
      input.alert.errorCount !== undefined
        ? String(input.alert.errorCount)
        : '',
    filename: input.alert.filename ?? '',
    window: `last ${input.lookbackMinutes} minutes`,
    latestErrors: sanitizedLines.join('\n'),
    message,
    alertUrl: input.alert.generatorURL ?? '',
  };
}
