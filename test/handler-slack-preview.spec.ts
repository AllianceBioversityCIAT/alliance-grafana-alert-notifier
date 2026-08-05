import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';

const mockGetConfig = vi.fn();
const mockPreviewSlackMessage = vi.fn();

vi.mock('../src/config/get-config.js', () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
}));

vi.mock('../src/slack/preview-slack-message.js', () => ({
  previewSlackMessage: (...args: unknown[]) => mockPreviewSlackMessage(...args),
}));

import { handler } from '../src/handler.js';
import { alertConfig } from './fixtures/grafana-payloads.js';

function buildEvent(): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /grafana/webhook',
    rawPath: '/grafana/webhook',
    rawQueryString: '',
    headers: { 'content-type': 'application/json' },
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      domainName: 'example.execute-api.us-east-1.amazonaws.com',
      domainPrefix: 'example',
      http: {
        method: 'POST',
        path: '/grafana/webhook',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'request-id',
      routeKey: 'POST /grafana/webhook',
      stage: '$default',
      time: '24/Jun/2026:00:00:00 +0000',
      timeEpoch: 1719187200000,
    },
    isBase64Encoded: false,
    body: JSON.stringify({
      diagnostic: 'slack-preview',
      job: 'example-app',
    }),
  };
}

describe('handler slack preview diagnostic', () => {
  beforeEach(() => {
    mockGetConfig.mockResolvedValue(alertConfig);
    mockPreviewSlackMessage.mockResolvedValue({
      slackMessage: ':rotating_light: Preview message',
      lokiLines: ['ERROR line'],
      lokiError: undefined,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the Slack message preview without sending Slack', async () => {
    const response = await handler(buildEvent(), {} as Context);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body ?? '{}');
    expect(body.slackMessage).toBe(':rotating_light: Preview message');
    expect(body.lokiLines).toEqual(['ERROR line']);
    expect(mockPreviewSlackMessage).toHaveBeenCalledOnce();
  });
});
