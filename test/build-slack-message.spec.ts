import { describe, it, expect } from 'vitest';
import { buildSlackMessage } from '../src/slack/build-slack-message.js';
import type { ParsedGrafanaAlert } from '../src/grafana/grafana-payload.types.js';

const baseAlert: ParsedGrafanaAlert = {
  alertname: 'Example Loki Error Alert',
  job: 'example-app',
  status: 'firing',
  errorCount: 8,
  filename: '/var/lib/docker/containers/abc123/container-cached.log',
  generatorURL:
    'https://grafana.example.com/alerting/grafana/test/uid/view',
  panelURL: 'https://grafana.example.com/d/panel/1',
};

describe('buildSlackMessage', () => {
  it('builds a formatted Slack message with Loki lines', () => {
    const message = buildSlackMessage({
      alert: baseAlert,
      lookbackMinutes: 5,
      lokiLines: [
        '2026-06-22T20:01:40Z ERROR something bad',
        '2026-06-22T20:01:38Z ERROR another issue',
      ],
    });

    expect(message).toContain(':rotating_light: Example Loki Error Alert');
    expect(message).toContain('Status: firing');
    expect(message).toContain('Job: example-app');
    expect(message).toContain('Error count: 8');
    expect(message).toContain('Window: last 5 minutes');
    expect(message).toContain('Filename: /var/lib/docker/containers/abc123/container-cached.log');
    expect(message).toContain('Latest Loki errors:');
    expect(message).toContain('2026-06-22T20:01:40Z ERROR something bad');
    expect(message).toContain('Panel: https://grafana.example.com/d/panel/1');
    expect(message).toContain(
      'Alert: https://grafana.example.com/alerting/grafana/test/uid/view',
    );
  });

  it('includes a Loki failure note when lines are unavailable', () => {
    const message = buildSlackMessage({
      alert: baseAlert,
      lookbackMinutes: 5,
      lokiLines: [],
      lokiError: 'Connection refused',
    });

    expect(message).toContain('Could not retrieve Loki error details');
    expect(message).toContain('Connection refused');
    expect(message).toContain('Job: example-app');
    expect(message).not.toContain('Latest Loki errors:');
  });

  it('omits optional fields when not present', () => {
    const message = buildSlackMessage({
      alert: {
        ...baseAlert,
        errorCount: undefined,
        filename: undefined,
        panelURL: undefined,
        generatorURL: undefined,
      },
      lookbackMinutes: 5,
      lokiLines: ['ERROR only line'],
    });

    expect(message).not.toContain('Error count:');
    expect(message).not.toContain('Filename:');
    expect(message).not.toContain('Panel:');
    expect(message).not.toContain('Alert:');
  });
});
