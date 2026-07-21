import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { queryLokiErrors } from '../src/loki/loki-client.js';
import { lokiQueryRangeResponse } from './fixtures/grafana-payloads.js';

describe('queryLokiErrors', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('calls Loki query_range with nanosecond timestamps and BACKWARD direction', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify(lokiQueryRangeResponse), { status: 200 }),
    );

    const window = {
      startNs: '1719086200000000000',
      endNs: '1719086500000000000',
    };

    await queryLokiErrors({
      baseUrl: 'http://loki:3100',
      job: 'example-app',
      errorPattern: 'ERROR',
      window,
      limit: 10,
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    const parsedUrl = new URL(url as string);

    expect(parsedUrl.pathname).toBe('/loki/api/v1/query_range');
    expect(parsedUrl.searchParams.get('query')).toBe(
      '{job="example-app"} |= "ERROR"',
    );
    expect(parsedUrl.searchParams.get('start')).toBe(window.startNs);
    expect(parsedUrl.searchParams.get('end')).toBe(window.endNs);
    expect(parsedUrl.searchParams.get('direction')).toBe('BACKWARD');
    expect(parsedUrl.searchParams.get('limit')).toBe('10');
    expect(options?.signal).toBeDefined();
  });

  it('returns parsed log entries from Loki response', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(lokiQueryRangeResponse), { status: 200 }),
    );

    const entries = await queryLokiErrors({
      baseUrl: 'http://loki:3100',
      job: 'example-app',
      errorPattern: 'ERROR',
      window: { startNs: '1', endNs: '2' },
      limit: 10,
    });

    expect(entries).toEqual([
      {
        timestampNs: '1719086500000000000',
        line: '2026-06-22T20:01:40Z ERROR something bad',
        labels: { job: 'example-app' },
      },
      {
        timestampNs: '1719086498000000000',
        line: '2026-06-22T20:01:38Z ERROR another issue',
        labels: { job: 'example-app' },
      },
    ]);
  });

  it('throws when Loki responds with non-2xx status', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('bad gateway', { status: 502 }),
    );

    await expect(
      queryLokiErrors({
        baseUrl: 'http://loki:3100',
        job: 'example-app',
        errorPattern: 'ERROR',
        window: { startNs: '1', endNs: '2' },
        limit: 10,
      }),
    ).rejects.toThrow(/502/);
  });

  it('limits combined results to the requested limit across streams', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'success',
          data: {
            resultType: 'streams',
            result: [
              {
                stream: { job: 'a' },
                values: [
                  ['3', 'line-3'],
                  ['2', 'line-2'],
                ],
              },
              {
                stream: { job: 'b' },
                values: [
                  ['5', 'line-5'],
                  ['4', 'line-4'],
                  ['1', 'line-1'],
                ],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );

    const entries = await queryLokiErrors({
      baseUrl: 'http://loki:3100',
      job: 'example-app',
      errorPattern: 'ERROR',
      window: { startNs: '1', endNs: '2' },
      limit: 3,
    });

    expect(entries.map((entry) => entry.line)).toEqual([
      'line-5',
      'line-4',
      'line-3',
    ]);
  });
});
