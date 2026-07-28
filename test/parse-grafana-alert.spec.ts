import { describe, it, expect } from 'vitest';
import {
  parseGrafanaAlert,
  deduplicateAlerts,
} from '../src/grafana/parse-grafana-alert.js';
import {
  firingPayload,
  resolvedPayload,
  payloadWithoutJob,
  multiAlertPayload,
} from './fixtures/grafana-payloads.js';

describe('parseGrafanaAlert', () => {
  it('returns resolved when payload status is resolved', () => {
    const result = parseGrafanaAlert(resolvedPayload);

    expect(result.kind).toBe('resolved');
  });

  it('returns error when firing payload has no job in any alert', () => {
    const result = parseGrafanaAlert(payloadWithoutJob);

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toMatch(/job/i);
    }
  });

  it('returns firing alerts with extracted metadata', () => {
    const result = parseGrafanaAlert(firingPayload);

    expect(result.kind).toBe('firing');
    if (result.kind === 'firing') {
      expect(result.alerts).toHaveLength(1);
      expect(result.alerts[0]).toMatchObject({
        alertname: 'Example Loki Error Alert',
        job: 'example-app',
        status: 'firing',
        errorCount: 8,
        filename:
          '/var/lib/docker/containers/abc123/container-cached.log',
        generatorURL:
          'https://grafana.example.com/alerting/grafana/test/uid/view',
      });
    }
  });

  it('skips alerts without job and errors when none remain', () => {
    const result = parseGrafanaAlert({
      ...firingPayload,
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'No job alert' },
        },
        {
          status: 'firing',
          labels: { alertname: 'Also no job' },
        },
      ],
    });

    expect(result.kind).toBe('error');
  });

  it('filters out resolved individual alerts when group is firing', () => {
    const result = parseGrafanaAlert({
      ...firingPayload,
      alerts: [
        firingPayload.alerts[0],
        {
          status: 'resolved',
          labels: {
            alertname: 'Old alert',
            job: 'other_job',
          },
        },
      ],
    });

    expect(result.kind).toBe('firing');
    if (result.kind === 'firing') {
      expect(result.alerts).toHaveLength(1);
      expect(result.alerts[0].job).toBe('example-app');
    }
  });
});

describe('deduplicateAlerts', () => {
  it('groups alerts by alertname and job keeping the highest error count', () => {
    const parsed = parseGrafanaAlert(multiAlertPayload);
    expect(parsed.kind).toBe('firing');
    if (parsed.kind !== 'firing') return;

    const deduped = deduplicateAlerts(parsed.alerts);

    // Same alertname+job with different Docker filenames must collapse to one
    // Slack post (Loki query and enriched message are job-scoped).
    expect(deduped).toHaveLength(1);
    expect(deduped[0].job).toBe('example-app');
    expect(deduped[0].errorCount).toBe(8);
  });
});
