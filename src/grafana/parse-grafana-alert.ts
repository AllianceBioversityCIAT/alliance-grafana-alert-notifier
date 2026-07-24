import type {
  GrafanaAlert,
  GrafanaWebhookPayload,
  ParsedGrafanaAlert,
  ParseGrafanaResult,
} from './grafana-payload.types.js';

function readPanelUrl(alert: GrafanaAlert): string | undefined {
  return (
    alert.annotations?.panelURL ??
    alert.annotations?.panelUrl ??
    alert.labels.panelURL ??
    alert.labels.panelUrl
  );
}

function mapAlert(alert: GrafanaAlert): ParsedGrafanaAlert | null {
  const job = alert.labels.job?.trim();
  if (!job) {
    return null;
  }

  return {
    alertname:
      alert.labels.alertname ??
      alert.labels.alertName ??
      'Grafana Alert',
    job,
    status: alert.status,
    errorCount: alert.values?.B,
    filename: alert.labels.filename,
    panelURL: readPanelUrl(alert),
    generatorURL: alert.generatorURL,
  };
}

export function parseGrafanaAlert(
  payload: GrafanaWebhookPayload,
): ParseGrafanaResult {
  if (payload.status === 'resolved') {
    return { kind: 'resolved' };
  }

  if (payload.status !== 'firing') {
    return {
      kind: 'error',
      message: `Unsupported alert status: ${payload.status ?? 'unknown'}`,
    };
  }

  const alerts = (payload.alerts ?? [])
    .filter((alert) => alert.status === 'firing')
    .map(mapAlert)
    .filter((alert): alert is ParsedGrafanaAlert => alert !== null);

  if (alerts.length === 0) {
    return {
      kind: 'error',
      message: 'No firing alerts with a valid job label were found',
    };
  }

  return { kind: 'firing', alerts };
}

export function deduplicateAlerts(
  alerts: ParsedGrafanaAlert[],
): ParsedGrafanaAlert[] {
  const grouped = new Map<string, ParsedGrafanaAlert>();

  for (const alert of alerts) {
    // Dedupe by alertname+job only. Grafana often sends one series per Docker
    // container filename; Loki is queried by job alone and the Slack body does
    // not include filename, so job::filename produced identical duplicate posts.
    const key = `${alert.alertname}::${alert.job}`;
    const existing = grouped.get(key);

    if (!existing) {
      grouped.set(key, alert);
      continue;
    }

    const existingCount = existing.errorCount ?? 0;
    const nextCount = alert.errorCount ?? 0;
    if (nextCount > existingCount) {
      grouped.set(key, alert);
    }
  }

  return [...grouped.values()];
}
