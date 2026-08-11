import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { alertConfig, firingPayload } from './fixtures/grafana-payloads.js';

const mockGetConfig = vi.fn();
const mockSendSlackMessage = vi.fn();
const mockBuildWeeklyReport = vi.fn();
const mockQueryLokiErrors = vi.fn();
const mockWriteReportNarrative = vi.fn();

vi.mock('../src/config/get-config.js', () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
}));

vi.mock('../src/slack/slack-client.js', () => ({
  sendSlackMessage: (...args: unknown[]) => mockSendSlackMessage(...args),
}));

vi.mock('../src/report/build-weekly-report.js', () => ({
  buildWeeklyReport: (...args: unknown[]) => mockBuildWeeklyReport(...args),
}));

vi.mock('../src/report/report-analyzer.js', () => ({
  writeReportNarrative: (...args: unknown[]) =>
    mockWriteReportNarrative(...args),
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

import { handler } from '../src/handler.js';

/** The API Gateway shape: payload arrives as a JSON string in `body`. */
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

/** The EventBridge Scheduler shape: the payload *is* the event. */
function buildDirectEvent(payload: unknown): Record<string, unknown> {
  return payload as Record<string, unknown>;
}

const context = {} as Context;

const reportEnabledConfig = {
  ...alertConfig,
  history: { ...alertConfig.history, enabled: true },
  report: { ...alertConfig.report, enabled: true },
};

const weeklyReport = {
  week: {
    isoYear: 2026,
    isoWeek: 32,
    label: '2026-W32',
    rangeLabel: 'Aug 3 – Aug 9',
    startIso: '2026-08-03T05:00:00.000Z',
    endIso: '2026-08-10T05:00:00.000Z',
    partitionKeys: [],
  },
  reports: [
    {
      application: 'PRMS',
      environment: 'prod',
      alertCount: 47,
      errorCount: 312,
      occurrenceCount: 120,
      patternCount: 9,
      outcomes: { notified: 47 },
      patterns: [],
      disappeared: [],
    },
  ],
  totals: {
    alertCount: 47,
    errorCount: 312,
    patternCount: 9,
    applicationCount: 1,
  },
  partitionsRead: 8,
};

describe('handler weekly report', () => {
  beforeEach(() => {
    mockGetConfig.mockResolvedValue(reportEnabledConfig);
    mockBuildWeeklyReport.mockResolvedValue(weeklyReport);
    mockSendSlackMessage.mockResolvedValue(undefined);
    mockWriteReportNarrative.mockResolvedValue({
      narrative: null,
      usedBedrock: false,
      fallbackReason: 'bedrock_disabled',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('accepts a direct invocation, where the payload is the event itself', async () => {
    const response = await handler(
      buildDirectEvent({ report: 'weekly' }),
      context,
    );

    expect(response.statusCode).toBe(200);
    expect(mockBuildWeeklyReport).toHaveBeenCalledTimes(1);
    expect(mockSendSlackMessage).toHaveBeenCalledTimes(1);
  });

  it('still accepts the API Gateway shape', async () => {
    const response = await handler(buildEvent({ report: 'weekly' }), context);

    expect(response.statusCode).toBe(200);
    expect(mockSendSlackMessage).toHaveBeenCalledTimes(1);
  });

  it('sends one message per application to the report webhook', async () => {
    mockGetConfig.mockResolvedValue({
      ...reportEnabledConfig,
      report: {
        ...reportEnabledConfig.report,
        enabled: true,
        webhookUrl: 'https://hooks.slack.com/services/AAA/BBB/CCC',
      },
    });
    mockBuildWeeklyReport.mockResolvedValue({
      ...weeklyReport,
      reports: [
        weeklyReport.reports[0],
        { ...weeklyReport.reports[0], application: 'CLARISA' },
      ],
    });

    await handler(buildDirectEvent({ report: 'weekly' }), context);

    expect(mockSendSlackMessage).toHaveBeenCalledTimes(2);
    expect(mockSendSlackMessage.mock.calls[0][0]).toBe(
      'https://hooks.slack.com/services/AAA/BBB/CCC',
    );
    // Incoming-webhook shape: the report never goes through the alert payload
    // builder, whose fields are alert-specific.
    expect(mockSendSlackMessage.mock.calls[0][1]).toHaveProperty('text');
    expect(mockSendSlackMessage.mock.calls[0][1].text).toContain('PRMS prod');
  });

  it('falls back to the main webhook when no report channel is configured', async () => {
    await handler(buildDirectEvent({ report: 'weekly' }), context);

    expect(mockSendSlackMessage.mock.calls[0][0]).toBe(
      alertConfig.slackWebhookUrl,
    );
  });

  it('keeps sending the other applications when one Slack call fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockBuildWeeklyReport.mockResolvedValue({
      ...weeklyReport,
      reports: [
        weeklyReport.reports[0],
        { ...weeklyReport.reports[0], application: 'CLARISA' },
      ],
    });
    mockSendSlackMessage
      .mockRejectedValueOnce(new Error('slack 500'))
      .mockResolvedValueOnce(undefined);

    const response = await handler(
      buildDirectEvent({ report: 'weekly' }),
      context,
    );

    expect(response.statusCode).toBe(200);
    expect(mockSendSlackMessage).toHaveBeenCalledTimes(2);
    expect(JSON.parse(response.body as string).delivered).toBe(1);
  });

  it('does nothing when the report is disabled', async () => {
    mockGetConfig.mockResolvedValue(alertConfig);

    const response = await handler(
      buildDirectEvent({ report: 'weekly' }),
      context,
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body as string).enabled).toBe(false);
    expect(mockBuildWeeklyReport).not.toHaveBeenCalled();
    expect(mockSendSlackMessage).not.toHaveBeenCalled();
  });

  it('refuses to report when history is off rather than posting a quiet week', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetConfig.mockResolvedValue({
      ...reportEnabledConfig,
      history: { ...reportEnabledConfig.history, enabled: false },
    });

    const response = await handler(
      buildDirectEvent({ report: 'weekly' }),
      context,
    );

    expect(response.statusCode).toBe(409);
    expect(mockSendSlackMessage).not.toHaveBeenCalled();
  });

  it('returns 502 when the aggregation fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockBuildWeeklyReport.mockRejectedValue(new Error('AccessDenied'));

    const response = await handler(
      buildDirectEvent({ report: 'weekly' }),
      context,
    );

    expect(response.statusCode).toBe(502);
    expect(mockSendSlackMessage).not.toHaveBeenCalled();
  });

  it('prepends the narrative above the numbers when Bedrock answers', async () => {
    mockWriteReportNarrative.mockResolvedValue({
      narrative: 'Database write failures dominated the week.',
      usedBedrock: true,
    });

    await handler(buildDirectEvent({ report: 'weekly' }), context);

    const text = mockSendSlackMessage.mock.calls[0][1].text as string;
    expect(text).toContain('Database write failures dominated the week.');
    expect(text).toContain('47 alerts · 312 errors');
    expect(text.indexOf('dominated')).toBeLessThan(text.indexOf('47 alerts'));
  });

  it('posts the deterministic report when the narrative fails', async () => {
    // The invariant: delivery must never depend on the model.
    mockWriteReportNarrative.mockResolvedValue({
      narrative: null,
      usedBedrock: false,
      fallbackReason: 'Bedrock converse timed out after 20000ms',
    });

    const response = await handler(
      buildDirectEvent({ report: 'weekly' }),
      context,
    );

    expect(response.statusCode).toBe(200);
    expect(mockSendSlackMessage).toHaveBeenCalledTimes(1);
    expect(mockSendSlackMessage.mock.calls[0][1].text).toContain(
      '47 alerts · 312 errors · 9 distinct patterns',
    );
  });

  it('still posts the other applications when one narrative throws', async () => {
    // writeReportNarrative swallows its own errors, but the handler must not
    // depend on that promise: a rejection here would abort every message.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockBuildWeeklyReport.mockResolvedValue({
      ...weeklyReport,
      reports: [
        weeklyReport.reports[0],
        { ...weeklyReport.reports[0], application: 'CLARISA' },
      ],
    });
    mockWriteReportNarrative
      .mockRejectedValueOnce(new Error('unexpected'))
      .mockResolvedValueOnce({ narrative: null, usedBedrock: false });

    const response = await handler(
      buildDirectEvent({ report: 'weekly' }),
      context,
    );

    expect(response.statusCode).toBe(200);
    expect(mockSendSlackMessage).toHaveBeenCalledTimes(2);
  });
});

describe('handler report diagnostic', () => {
  beforeEach(() => {
    mockGetConfig.mockResolvedValue(reportEnabledConfig);
    mockBuildWeeklyReport.mockResolvedValue(weeklyReport);
    mockSendSlackMessage.mockResolvedValue(undefined);
    mockWriteReportNarrative.mockResolvedValue({
      narrative: null,
      usedBedrock: false,
      fallbackReason: 'bedrock_disabled',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('returns the built messages without sending anything', async () => {
    const response = await handler(
      buildEvent({ diagnostic: 'report', dryRun: true }),
      context,
    );

    expect(response.statusCode).toBe(200);
    expect(mockSendSlackMessage).not.toHaveBeenCalled();

    const body = JSON.parse(response.body as string);
    expect(body.dryRun).toBe(true);
    expect(body.week.label).toBe('2026-W32');
    expect(body.totals.alertCount).toBe(47);
    expect(body.messages[0].message).toContain('📊 Weekly report · PRMS prod');
  });

  it('defaults to a dry run so the diagnostic cannot post by accident', async () => {
    await handler(buildEvent({ diagnostic: 'report' }), context);

    expect(mockSendSlackMessage).not.toHaveBeenCalled();
  });

  it('sends for real only when dryRun is explicitly false', async () => {
    const response = await handler(
      buildEvent({ diagnostic: 'report', dryRun: false }),
      context,
    );

    expect(response.statusCode).toBe(200);
    expect(mockSendSlackMessage).toHaveBeenCalledTimes(1);
  });
});

describe('handler payload normalization', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('still rejects an API Gateway request with no body', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const event = buildEvent({});
    delete (event as { body?: string }).body;

    const response = await handler(event, context);

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body as string).message).toBe(
      'Request body is required',
    );
  });

  it('still routes a Grafana webhook through the alert path', async () => {
    mockGetConfig.mockResolvedValue(alertConfig);
    mockQueryLokiErrors.mockResolvedValue([]);

    const response = await handler(buildEvent(firingPayload), context);

    expect(response.statusCode).toBe(200);
    expect(mockBuildWeeklyReport).not.toHaveBeenCalled();
  });
});
