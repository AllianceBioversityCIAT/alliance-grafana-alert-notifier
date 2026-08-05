import type { ParsedGrafanaAlert } from '../grafana/grafana-payload.types.js';

export interface SlackPreviewDiagnosticPayload {
  diagnostic: 'slack-preview';
  job?: string;
  alertname?: string;
  errorCount?: number;
  filename?: string;
  panelURL?: string;
  generatorURL?: string;
}

export function isSlackPreviewPayload(
  body: unknown,
): body is SlackPreviewDiagnosticPayload {
  return (
    typeof body === 'object' &&
    body !== null &&
    'diagnostic' in body &&
    (body as { diagnostic?: string }).diagnostic === 'slack-preview'
  );
}

export function buildPreviewAlert(
  payload: SlackPreviewDiagnosticPayload,
): ParsedGrafanaAlert {
  return {
    alertname: payload.alertname ?? 'Example Loki Error Alert',
    job: payload.job ?? 'example-app',
    status: 'firing',
    errorCount: payload.errorCount ?? 8,
    filename: payload.filename,
    panelURL: payload.panelURL,
    generatorURL: payload.generatorURL,
  };
}
