import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { alertConfig, firingPayload } from './fixtures/grafana-payloads.js';

const mockGetConfig = vi.fn();
const mockQueryLokiErrors = vi.fn();
const mockSendSlackMessage = vi.fn();
const mockRecordAlertEvent = vi.fn();
const mockQueryAlertHistory = vi.fn();

vi.mock('../src/config/get-config.js', () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
}));

vi.mock('../src/loki/loki-client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/loki/loki-client.js')>(
    '../src/loki/loki-client.js',
  );
  return {
    ...actual,
    queryLokiErrors: (...args: unknown[]) => mockQueryLokiErrors(...args),
  };
});

vi.mock('../src/slack/slack-client.js', () => ({
  sendSlackMessage: (...args: unknown[]) => mockSendSlackMessage(...args),
}));

vi.mock('../src/history/alert-history-store.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/history/alert-history-store.js')
  >('../src/history/alert-history-store.js');
  return {
    ...actual,
    recordAlertEvent: (...args: unknown[]) => mockRecordAlertEvent(...args),
    queryAlertHistory: (...args: unknown[]) => mockQueryAlertHistory(...args),
  };
});

import { handler } from '../src/handler.js';

function buildEvent(body: unknown): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /webhook',
    rawPath: '/webhook',
    rawQueryString: '',
    headers: { 'content-type': 'application/json' },
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      domainName: 'example.execute-api.us-east-1.amazonaws.com',
      domainPrefix: 'example',
      http: {
        method: 'POST',
        path: '/webhook',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'request-id',
      routeKey: 'POST /webhook',
      stage: '$default',
      time: '24/Jun/2026:00:00:00 +0000',
      timeEpoch: 1719187200000,
    },
    isBase64Encoded: false,
    body: JSON.stringify(body),
  };
}

const context = {} as Context;
const historyEnabledConfig = {
  ...alertConfig,
  history: { ...alertConfig.history, enabled: true },
};

describe('handler alert history', () => {
  beforeEach(() => {
    mockGetConfig.mockResolvedValue(historyEnabledConfig);
    mockQueryLokiErrors.mockResolvedValue([
      {
        timestampNs: '1719086500000000000',
        line: '[Nest] 24 - 07/09/2026, 9:00:46 PM ERROR [ClarisaTaskService] [15] Error saving item with id/code: 39',
      },
    ]);
    mockSendSlackMessage.mockResolvedValue(undefined);
    mockRecordAlertEvent.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('records a notified alert after Slack was sent', async () => {
    const response = await handler(buildEvent(firingPayload), context);

    expect(response.statusCode).toBe(200);
    expect(mockSendSlackMessage).toHaveBeenCalledTimes(1);
    expect(mockRecordAlertEvent).toHaveBeenCalledTimes(1);

    const recorded = mockRecordAlertEvent.mock.calls[0][0];
    expect(recorded.outcome).toBe('notified');
    expect(recorded.slackDelivered).toBe(true);
    expect(recorded.preprocessed).toBeDefined();
  });

  it('does not let a failed write block Slack or change the 200', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRecordAlertEvent.mockRejectedValue(new Error('ResourceNotFoundException'));

    const response = await handler(buildEvent(firingPayload), context);

    expect(response.statusCode).toBe(200);
    expect(mockSendSlackMessage).toHaveBeenCalledTimes(1);
  });

  it('records the outcome when Slack delivery failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockSendSlackMessage.mockRejectedValue(new Error('slack 500'));

    const response = await handler(buildEvent(firingPayload), context);

    expect(response.statusCode).toBe(200);
    expect(mockRecordAlertEvent.mock.calls[0][0].slackDelivered).toBe(false);
  });

  it('records skipped_no_lines when Loki returns nothing', async () => {
    mockQueryLokiErrors.mockResolvedValue([]);

    const response = await handler(buildEvent(firingPayload), context);

    expect(response.statusCode).toBe(200);
    expect(mockSendSlackMessage).not.toHaveBeenCalled();
    expect(mockRecordAlertEvent.mock.calls[0][0].outcome).toBe('skipped_no_lines');
  });

  it('records skipped_loki_error with the error when Loki fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockQueryLokiErrors.mockRejectedValue(new Error('ECONNREFUSED'));

    const response = await handler(buildEvent(firingPayload), context);

    expect(response.statusCode).toBe(200);
    expect(mockSendSlackMessage).not.toHaveBeenCalled();

    const recorded = mockRecordAlertEvent.mock.calls[0][0];
    expect(recorded.outcome).toBe('skipped_loki_error');
    expect(recorded.lokiError).toContain('ECONNREFUSED');
  });

  it('passes the kill switch through so a disabled store writes nothing', async () => {
    mockGetConfig.mockResolvedValue(alertConfig);

    await handler(buildEvent(firingPayload), context);

    // recordAlertEvent is still called, but with the disabled config: it is the
    // store that short-circuits, so DynamoDB is never touched.
    expect(mockRecordAlertEvent.mock.calls[0][0].config.enabled).toBe(false);
    expect(mockSendSlackMessage).toHaveBeenCalledTimes(1);
  });
});

describe('handler history diagnostic', () => {
  beforeEach(() => {
    mockGetConfig.mockResolvedValue(historyEnabledConfig);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('returns items grouped by signature', async () => {
    mockQueryAlertHistory.mockResolvedValue({
      items: [{ signature: 'aaa', recordedAt: '2026-08-11T09:00:00.000Z' }],
      signatures: [{ signature: 'aaa', signatureText: 'text', count: 1 }],
    });

    const response = await handler(
      buildEvent({ diagnostic: 'history', days: 3 }),
      context,
    );

    expect(response.statusCode).toBe(200);
    expect(mockQueryAlertHistory.mock.calls[0][0].days).toBe(3);

    const body = JSON.parse(response.body as string);
    expect(body.itemCount).toBe(1);
    expect(body.signatures[0].signature).toBe('aaa');
  });

  it('defaults to seven days', async () => {
    mockQueryAlertHistory.mockResolvedValue({ items: [], signatures: [] });

    await handler(buildEvent({ diagnostic: 'history' }), context);

    expect(mockQueryAlertHistory.mock.calls[0][0].days).toBe(7);
  });

  it('reports that history is disabled without querying', async () => {
    mockGetConfig.mockResolvedValue(alertConfig);

    const response = await handler(buildEvent({ diagnostic: 'history' }), context);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body as string).enabled).toBe(false);
    expect(mockQueryAlertHistory).not.toHaveBeenCalled();
  });

  it('returns 502 when the query fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockQueryAlertHistory.mockRejectedValue(new Error('AccessDenied'));

    const response = await handler(buildEvent({ diagnostic: 'history' }), context);

    expect(response.statusCode).toBe(502);
  });
});
