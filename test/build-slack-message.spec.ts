import { describe, it, expect } from 'vitest';
import {
  buildSlackMessage,
  buildSlackWorkflowPayload,
} from '../src/slack/build-slack-message.js';
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

  it('strips ANSI and binary noise from Loki lines', () => {
    const noisyLine =
      '\x06stdout\x10\x1B[31m[Nest] 25 - \x1B[39m06/25/2026, 8:25:02 PM \x1B[31m ERROR\x1B[39m HttpException: Authorization token is required\r\x00\x00\x00';

    const message = buildSlackMessage({
      alert: baseAlert,
      lookbackMinutes: 5,
      lokiLines: [noisyLine],
    });

    expect(message).toContain(
      '[Nest] 25 - 06/25/2026, 8:25:02 PM ERROR HttpException: Authorization token is required',
    );
    expect(message).not.toContain('\x1B[31m');
    expect(message).not.toContain('stdout');
  });

  it('strips docker stdout framing before NestJS log lines', () => {
    const noisyLine =
      '\x06stdout\x10\xc9\xbf\xc9\xbf\xc9\xbf\xc9\xbf[Nest] 1  - 06/25/2026, 9:56:13 PM   ERROR [ExampleCronJob] Example job failed: connect ENETUNREACH 203.0.113.10:443\xc2\xc2';

    const message = buildSlackMessage({
      alert: baseAlert,
      lookbackMinutes: 5,
      lokiLines: [noisyLine],
    });

    expect(message).toContain(
      '[Nest] 1 - 06/25/2026, 9:56:13 PM ERROR [ExampleCronJob] Example job failed: connect ENETUNREACH 203.0.113.10:443',
    );
    expect(message).not.toContain('stdout');
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

  it('builds an enriched Slack message for firing alerts', () => {
    const message = buildSlackMessage({
      alert: {
        ...baseAlert,
        alertname: 'PRMS Test - Loki Error Alert',
        job: 'docker_prms_test',
      },
      lookbackMinutes: 5,
      lokiLines: [],
      enriched: true,
      preprocessed: {
        alertName: 'PRMS Test - Loki Error Alert',
        status: 'firing',
        job: 'docker_prms_test',
        application: 'PRMS',
        environment: 'test',
        timezone: 'America/Bogota',
        dateFormat: 'MM/DD/YYYY',
        occurrences: 10,
        firstOccurrence: '07/09/2026, 9:00:31 PM',
        lastOccurrence: '07/09/2026, 9:00:46 PM',
        firstOccurrenceNs: null,
        lastOccurrenceNs: null,
        representativeLogs: ['ERROR sample'],
      },
      analysis: {
        usuario: null,
        modulo: 'System',
        momento: '2026-07-09T21:00:46-05:00',
        caso: 'Authorization token is required',
        tipoError: 'HttpException',
        confianza: {
          usuario: 0,
          modulo: 1,
          momento: 1,
          caso: 0.98,
        },
        evidencia: {
          usuario: null,
          modulo: '[System]',
          momento: '07/09/2026, 9:00:46 PM',
          caso: 'HttpException: Authorization token is required',
        },
      },
    });

    expect(message).toContain('🚨 PRMS Test – Error detected');
    expect(message).toContain('Status: Active');
    expect(message).toContain('Application: PRMS');
    expect(message).toContain('Environment: Test');
    expect(message).toContain('Module: System');
    expect(message).toContain('User: Unidentified');
    expect(message).toContain('Error type: HttpException');
    expect(message).toContain('Occurrences: 10');
    expect(message).toContain('First occurrence: 9:00:31 PM');
    expect(message).toContain('Last occurrence: 9:00:46 PM');
  });

  it('builds enriched title from application and environment metadata', () => {
    const message = buildSlackMessage({
      alert: {
        ...baseAlert,
        alertname: 'Billing Prod - Loki Error Alert',
        job: 'docker_billing_prod',
      },
      lookbackMinutes: 5,
      lokiLines: [],
      enriched: true,
      preprocessed: {
        alertName: 'Billing Prod - Loki Error Alert',
        status: 'firing',
        job: 'docker_billing_prod',
        application: 'Billing',
        environment: 'prod',
        timezone: 'America/Bogota',
        dateFormat: 'MM/DD/YYYY',
        occurrences: 3,
        firstOccurrence: null,
        lastOccurrence: null,
        firstOccurrenceNs: null,
        lastOccurrenceNs: null,
        representativeLogs: ['ERROR sample'],
      },
      analysis: {
        usuario: null,
        modulo: 'Payments',
        momento: null,
        caso: 'Payment gateway timeout',
        tipoError: 'TimeoutError',
        confianza: {
          usuario: 0,
          modulo: 1,
          momento: 0,
          caso: 0.9,
        },
        evidencia: {
          usuario: null,
          modulo: '[Payments]',
          momento: null,
          caso: 'TimeoutError: gateway',
        },
      },
    });

    expect(message).toContain('🚨 Billing Prod – Error detected');
    expect(message).toContain('Application: Billing');
    expect(message).toContain('Environment: Prod');
    expect(message).not.toContain('PRMS');
  });

  it('falls back to a generic enriched title when metadata is missing', () => {
    const message = buildSlackMessage({
      alert: {
        ...baseAlert,
        alertname: 'Generic Error Alert',
        job: 'unknown',
      },
      lookbackMinutes: 5,
      lokiLines: [],
      enriched: true,
      preprocessed: {
        alertName: 'Generic Error Alert',
        status: 'firing',
        job: 'unknown',
        application: null,
        environment: null,
        timezone: 'America/Bogota',
        dateFormat: 'MM/DD/YYYY',
        occurrences: 1,
        firstOccurrence: null,
        lastOccurrence: null,
        firstOccurrenceNs: null,
        lastOccurrenceNs: null,
        representativeLogs: ['ERROR sample'],
      },
      analysis: {
        usuario: null,
        modulo: null,
        momento: null,
        caso: 'Something failed',
        tipoError: null,
        confianza: {
          usuario: 0,
          modulo: 0,
          momento: 0,
          caso: 0.5,
        },
        evidencia: {
          usuario: null,
          modulo: null,
          momento: null,
          caso: null,
        },
      },
    });

    expect(message).toContain('🚨 Error detected');
    expect(message).not.toContain('Application:');
    expect(message).not.toContain('Environment:');
  });
});

describe('buildSlackWorkflowPayload', () => {
  it('builds structured fields for Slack Workflow webhooks', () => {
    const payload = buildSlackWorkflowPayload({
      alert: baseAlert,
      lookbackMinutes: 5,
      lokiLines: ['2026-06-22T20:01:40Z ERROR something bad'],
    });

    expect(payload).toEqual({
      alertname: 'Example Loki Error Alert',
      status: 'firing',
      job: 'example-app',
      errorCount: '8',
      filename: '/var/lib/docker/containers/abc123/container-cached.log',
      window: 'last 5 minutes',
      latestErrors: '2026-06-22T20:01:40Z ERROR something bad',
      message: expect.stringContaining('Example Loki Error Alert'),
      alertUrl: 'https://grafana.example.com/alerting/grafana/test/uid/view',
    });
  });
});
