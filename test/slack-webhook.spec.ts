import { describe, it, expect } from 'vitest';
import {
  buildSlackWebhookPayload,
  isSlackWorkflowWebhook,
} from '../src/slack/slack-webhook.js';
import type { ParsedGrafanaAlert } from '../src/grafana/grafana-payload.types.js';

const baseAlert: ParsedGrafanaAlert = {
  alertname: 'Example Loki Error Alert',
  job: 'example-app',
  status: 'firing',
  errorCount: 8,
  generatorURL: 'https://grafana.example.com/alerting/grafana/test/uid/view',
};

const buildInput = {
  alert: baseAlert,
  lookbackMinutes: 5,
  lokiLines: ['ERROR line 1'],
};

describe('isSlackWorkflowWebhook', () => {
  it('detects Slack Workflow trigger URLs', () => {
    expect(
      isSlackWorkflowWebhook(
        'https://hooks.slack.com/triggers/T000/0000000000/00000000000000000000000000000000',
      ),
    ).toBe(true);
  });

  it('treats classic incoming webhook URLs as non-workflow', () => {
    expect(
      isSlackWorkflowWebhook(
        'https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX',
      ),
    ).toBe(false);
  });
});

describe('buildSlackWebhookPayload', () => {
  it('returns structured payload for workflow webhooks', () => {
    const payload = buildSlackWebhookPayload(
      buildInput,
      'https://hooks.slack.com/triggers/T000/0000000000/00000000000000000000000000000000',
    );

    expect(payload).toMatchObject({
      alertname: 'Example Loki Error Alert',
      status: 'firing',
      job: 'example-app',
      latestErrors: 'ERROR line 1',
    });
    expect('text' in payload).toBe(false);
  });

  it('returns text payload for incoming webhooks', () => {
    const payload = buildSlackWebhookPayload(
      buildInput,
      'https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX',
    );

    expect(payload).toEqual({
      text: expect.stringContaining('Example Loki Error Alert'),
    });
  });
});
