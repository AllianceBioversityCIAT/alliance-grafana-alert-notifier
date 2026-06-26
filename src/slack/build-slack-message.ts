import type { ParsedGrafanaAlert } from '../grafana/grafana-payload.types.js';
import { sanitizeLogLines } from '../utils/sanitize-log-line.js';

export interface BuildSlackMessageInput {
  alert: ParsedGrafanaAlert;
  lookbackMinutes: number;
  lokiLines: string[];
  lokiError?: string;
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

export function buildSlackMessage(input: BuildSlackMessageInput): string {
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
