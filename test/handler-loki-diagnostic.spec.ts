import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';

const mockGetConfig = vi.fn();
const mockTestLokiConnection = vi.fn();

vi.mock('../src/config/get-config.js', () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
}));

vi.mock('../src/loki/test-loki-connection.js', () => ({
  testLokiConnection: (...args: unknown[]) => mockTestLokiConnection(...args),
}));

import { handler } from '../src/handler.js';
import { alertConfig } from './fixtures/grafana-payloads.js';

function buildDiagnosticEvent(job = 'example-app'): APIGatewayProxyEventV2 {
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
    body: JSON.stringify({ diagnostic: 'loki', job }),
  };
}

describe('handler Loki diagnostic mode', () => {
  beforeEach(() => {
    mockGetConfig.mockResolvedValue(alertConfig);
    mockTestLokiConnection.mockResolvedValue({
      success: true,
      lokiHost: 'loki.example.com',
      job: 'example-app',
      errorPattern: 'ERROR',
      query: '{job="example-app"} |= "ERROR"',
      lookbackMinutes: 5,
      lineCount: 2,
      sampleLines: ['ERROR line 1'],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns Loki diagnostic result without processing Grafana alerts', async () => {
    const response = await handler(buildDiagnosticEvent(), {} as Context);

    expect(response.statusCode).toBe(200);
    expect(mockTestLokiConnection).toHaveBeenCalledOnce();
    expect(mockTestLokiConnection.mock.calls[0][0]).toMatchObject({
      config: alertConfig,
      job: 'example-app',
    });

    const body = JSON.parse(response.body ?? '{}');
    expect(body.success).toBe(true);
    expect(body.sampleLines).toEqual(['ERROR line 1']);
  });

  it('returns 502 when Loki diagnostic fails', async () => {
    mockTestLokiConnection.mockResolvedValue({
      success: false,
      lokiHost: 'loki.example.com',
      job: 'example-app',
      errorPattern: 'ERROR',
      query: '{job="example-app"} |= "ERROR"',
      lookbackMinutes: 5,
      lineCount: 0,
      sampleLines: [],
      error: 'fetch failed',
    });

    const response = await handler(buildDiagnosticEvent(), {} as Context);

    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body ?? '{}').error).toBe('fetch failed');
  });
});
