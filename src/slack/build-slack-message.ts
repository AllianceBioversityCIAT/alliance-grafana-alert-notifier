import type { ParsedGrafanaAlert } from '../grafana/grafana-payload.types.js';

export interface BuildSlackMessageInput {
  alert: ParsedGrafanaAlert;
  lookbackMinutes: number;
  lokiLines: string[];
  lokiError?: string;
}

export function buildSlackMessage(input: BuildSlackMessageInput): string {
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
  } else if (input.lokiLines.length > 0) {
    lines.push('');
    lines.push('Latest Loki errors:');
    lines.push(...input.lokiLines);
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
