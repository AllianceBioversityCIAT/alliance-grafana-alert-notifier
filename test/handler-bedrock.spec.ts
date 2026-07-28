import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import {
  alertConfig,
  firingPayload,
  resolvedPayload,
} from './fixtures/grafana-payloads.js';

const mockGetConfig = vi.fn();
const mockQueryLokiErrors = vi.fn();
const mockSendSlackMessage = vi.fn();
const mockAnalyzeLogsWithBedrock = vi.fn();

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

vi.mock('../src/bedrock/bedrock-log-analyzer.js', () => ({
  analyzeLogsWithBedrock: (...args: unknown[]) =>
    mockAnalyzeLogsWithBedrock(...args),
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

describe('handler bedrock enrichment', () => {
  beforeEach(() => {
    mockGetConfig.mockResolvedValue({
      ...alertConfig,
      bedrock: { ...alertConfig.bedrock, enabled: true },
    });
    mockQueryLokiErrors.mockResolvedValue([
      {
        timestampNs: '1719086500000000000',
        line: '[Nest] 24 - 07/09/2026, 9:00:46 PM ERROR [System] HttpException: Authorization token is required',
      },
    ]);
    mockSendSlackMessage.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sends enriched Slack message when Bedrock succeeds for firing alerts', async () => {
    mockAnalyzeLogsWithBedrock.mockResolvedValue({
      usedBedrock: true,
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
          tipoError: 1,
        },
        evidencia: {
          usuario: null,
          modulo: '[System]',
          momento: '07/09/2026, 9:00:46 PM',
          caso: 'HttpException: Authorization token is required',
          tipoError: 'HttpException',
        },
      },
    });

    const response = await handler(buildEvent(firingPayload), context);
    expect(response.statusCode).toBe(200);
    expect(mockSendSlackMessage).toHaveBeenCalledOnce();

    const [, payload] = mockSendSlackMessage.mock.calls[0];
    expect(payload.text).toContain('Error detectado');
    expect(payload.text).toContain('Módulo: System');
    expect(payload.text).toContain('Usuario: No identificado');
    expect(payload.text).toContain('Estado: Activo');
  });

  it('falls back to legacy Slack message when Bedrock fails', async () => {
    mockAnalyzeLogsWithBedrock.mockResolvedValue({
      usedBedrock: false,
      analysis: null,
      fallbackReason: 'Bedrock converse timed out after 8000ms',
    });

    const response = await handler(buildEvent(firingPayload), context);
    expect(response.statusCode).toBe(200);
    expect(mockSendSlackMessage).toHaveBeenCalledOnce();

    const [, payload] = mockSendSlackMessage.mock.calls[0];
    expect(payload.text).toContain(':rotating_light:');
    expect(payload.text).toContain('Latest Loki errors:');
    expect(payload.text).not.toContain('Error detectado');
  });

  it('uses legacy flow when Bedrock is disabled', async () => {
    mockGetConfig.mockResolvedValue(alertConfig);
    mockAnalyzeLogsWithBedrock.mockResolvedValue({
      usedBedrock: false,
      analysis: null,
      fallbackReason: 'bedrock_disabled',
    });

    await handler(buildEvent(firingPayload), context);

    const [, payload] = mockSendSlackMessage.mock.calls[0];
    expect(payload.text).toContain('Latest Loki errors:');
  });

  it('still ignores resolved alerts', async () => {
    const response = await handler(buildEvent(resolvedPayload), context);
    expect(response.statusCode).toBe(200);
    expect(mockQueryLokiErrors).not.toHaveBeenCalled();
    expect(mockAnalyzeLogsWithBedrock).not.toHaveBeenCalled();
    expect(mockSendSlackMessage).not.toHaveBeenCalled();
  });
});
