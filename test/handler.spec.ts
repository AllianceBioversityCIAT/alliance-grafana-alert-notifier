import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import {
  firingPayload,
  resolvedPayload,
  payloadWithoutJob,
  alertConfig,
} from './fixtures/grafana-payloads.js';

const mockGetConfig = vi.fn();
const mockQueryLokiErrors = vi.fn();
const mockSendSlackMessage = vi.fn();

vi.mock('../src/config/get-config.js', () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
}));

vi.mock('../src/loki/loki-client.js', () => ({
  queryLokiErrors: (...args: unknown[]) => mockQueryLokiErrors(...args),
}));

vi.mock('../src/slack/slack-client.js', () => ({
  sendSlackMessage: (...args: unknown[]) => mockSendSlackMessage(...args),
}));

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

describe('handler', () => {
  beforeEach(() => {
    mockGetConfig.mockResolvedValue(alertConfig);
    mockQueryLokiErrors.mockResolvedValue([
      '2026-06-22T20:01:40Z ERROR something bad',
    ]);
    mockSendSlackMessage.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('queries Loki and sends Slack for firing payload', async () => {
    const response = await handler(buildEvent(firingPayload), context);

    expect(response.statusCode).toBe(200);
    expect(mockGetConfig).toHaveBeenCalledOnce();
    expect(mockQueryLokiErrors).toHaveBeenCalledOnce();
    expect(mockSendSlackMessage).toHaveBeenCalledOnce();

    const slackMessage = mockSendSlackMessage.mock.calls[0][1].text as string;
    expect(slackMessage).toContain('Example Loki Error Alert');
    expect(slackMessage).toContain('example-app');
  });

  it('returns 200 without querying Loki for resolved payload', async () => {
    const response = await handler(buildEvent(resolvedPayload), context);

    expect(response.statusCode).toBe(200);
    expect(mockGetConfig).not.toHaveBeenCalled();
    expect(mockQueryLokiErrors).not.toHaveBeenCalled();
    expect(mockSendSlackMessage).not.toHaveBeenCalled();
  });

  it('returns 400 when no job is present in firing alerts', async () => {
    const response = await handler(buildEvent(payloadWithoutJob), context);

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body ?? '{}').message).toMatch(/job/i);
    expect(mockQueryLokiErrors).not.toHaveBeenCalled();
    expect(mockSendSlackMessage).not.toHaveBeenCalled();
  });

  it('does not send Slack when Loki returns no log lines', async () => {
    mockQueryLokiErrors.mockResolvedValue([]);

    const response = await handler(buildEvent(firingPayload), context);

    expect(response.statusCode).toBe(200);
    expect(mockQueryLokiErrors).toHaveBeenCalledOnce();
    expect(mockSendSlackMessage).not.toHaveBeenCalled();
  });

  it('does not send Slack when Loki fails and still returns 200', async () => {
    mockQueryLokiErrors.mockRejectedValue(new Error('Loki unavailable'));

    const response = await handler(buildEvent(firingPayload), context);

    expect(response.statusCode).toBe(200);
    expect(mockSendSlackMessage).not.toHaveBeenCalled();
  });

  it('returns 200 and logs when Slack fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockSendSlackMessage.mockRejectedValue(new Error('Slack down'));

    const response = await handler(buildEvent(firingPayload), context);

    expect(response.statusCode).toBe(200);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('returns 400 for invalid JSON body', async () => {
    const event = buildEvent(firingPayload);
    event.body = '{not-json';

    const response = await handler(event, context);

    expect(response.statusCode).toBe(400);
  });

  it('passes config values to the Loki client', async () => {
    mockGetConfig.mockResolvedValue({
      ...alertConfig,
      lookbackMinutes: 10,
    });

    await handler(buildEvent(firingPayload), context);

    const lokiArgs = mockQueryLokiErrors.mock.calls[0][0];
    expect(lokiArgs.errorPattern).toBe('ERROR');
    expect(lokiArgs.limit).toBe(10);
    expect(lokiArgs.job).toBe('example-app');
    expect(lokiArgs.baseUrl).toBe(alertConfig.lokiBaseUrl);
  });
});
