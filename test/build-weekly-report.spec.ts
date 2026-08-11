import { describe, it, expect, vi } from 'vitest';
import type { HistoryConfig } from '../src/grafana/grafana-payload.types.js';
import type { AlertHistoryItem } from '../src/history/alert-history-store.js';
import { buildWeeklyReport } from '../src/report/build-weekly-report.js';

const history: HistoryConfig = {
  enabled: true,
  tableName: 'grafana-alert-history-test',
  region: 'us-east-1',
  retentionDays: 90,
};

// Tuesday 2026-08-11, 14:15 in Bogota. Last complete week: Aug 3 – Aug 9.
const now = new Date('2026-08-11T19:15:00.000Z');
const BOGOTA = 'America/Bogota';

function item(
  recordedAt: string,
  overrides: Partial<AlertHistoryItem> = {},
): AlertHistoryItem {
  return {
    pk: `DAY#${recordedAt.slice(0, 10)}`,
    sk: `${recordedAt}#abcd1234`,
    signature: 'sig-a',
    signatureText: 'ClarisaTaskService · QueryFailedError',
    recordedAt,
    alertname: 'PRMS Prod - Loki Error Alert',
    job: 'prmslogs_47',
    filename: null,
    application: 'PRMS',
    environment: 'prod',
    modulo: 'ClarisaTaskService',
    tipoError: 'QueryFailedError',
    caso: null,
    usuario: null,
    occurrences: 4,
    errorCount: 10,
    firstOccurrenceNs: null,
    lastOccurrenceNs: null,
    representativeLogs: '',
    outcome: 'notified',
    slackDelivered: true,
    usedBedrock: true,
    bedrockFallbackReason: null,
    lokiError: null,
    ttl: 0,
    ...overrides,
  };
}

function queryReturning(items: AlertHistoryItem[]) {
  return vi.fn().mockImplementation(({ partitionKey }: { partitionKey: string }) =>
    Promise.resolve(items.filter((entry) => entry.pk === partitionKey)),
  );
}

describe('buildWeeklyReport', () => {
  it('reports the last complete week', async () => {
    const query = queryReturning([item('2026-08-05T12:00:00.000Z')]);

    const result = await buildWeeklyReport({
      history,
      timeZone: BOGOTA,
      streakWeeks: 0,
      now,
      query,
    });

    expect(result.week.label).toBe('2026-W32');
    expect(result.totals.alertCount).toBe(1);
    expect(result.reports[0].application).toBe('PRMS');
  });

  it('reads each overlapping partition only once', async () => {
    const query = queryReturning([]);

    const result = await buildWeeklyReport({
      history,
      timeZone: BOGOTA,
      streakWeeks: 2,
      now,
      query,
    });

    const requested = query.mock.calls.map((call) => call[0].partitionKey);
    // Adjacent weeks share their boundary UTC day; without deduplication those
    // days would be fetched twice.
    expect(new Set(requested).size).toBe(requested.length);
    expect(query).toHaveBeenCalledTimes(result.partitionsRead);
    expect(result.partitionsRead).toBeLessThan(3 * 8);
  });

  it('assigns items to the right week and counts the streak', async () => {
    const query = queryReturning([
      item('2026-08-05T12:00:00.000Z'), // reported week
      item('2026-07-29T12:00:00.000Z'), // one week earlier
      item('2026-07-22T12:00:00.000Z'), // two weeks earlier
    ]);

    const result = await buildWeeklyReport({
      history,
      timeZone: BOGOTA,
      streakWeeks: 2,
      now,
      query,
    });

    expect(result.totals.alertCount).toBe(1);
    expect(result.reports[0].patterns[0].consecutiveWeeks).toBe(3);
    expect(result.reports[0].patterns[0].isNew).toBe(false);
  });

  it('excludes items that fall outside the window despite sharing a partition', async () => {
    const query = queryReturning([
      // 2026-08-10T04:00Z is Aug 9 23:00 in Bogota — still the reported week.
      item('2026-08-10T04:00:00.000Z'),
      // 2026-08-10T06:00Z is Aug 10 01:00 in Bogota — already the next week.
      item('2026-08-10T06:00:00.000Z', { signature: 'sig-next' }),
    ]);

    const result = await buildWeeklyReport({
      history,
      timeZone: BOGOTA,
      streakWeeks: 0,
      now,
      query,
    });

    expect(result.totals.alertCount).toBe(1);
    expect(result.reports[0].patterns[0].signature).toBe('sig-a');
  });

  it('totals across applications and reports an empty week as empty', async () => {
    const query = queryReturning([
      item('2026-08-05T12:00:00.000Z', { errorCount: 10 }),
      item('2026-08-06T12:00:00.000Z', {
        application: 'CLARISA',
        signature: 'sig-b',
        errorCount: 302,
      }),
    ]);

    const result = await buildWeeklyReport({
      history,
      timeZone: BOGOTA,
      streakWeeks: 0,
      now,
      query,
    });

    expect(result.totals.applicationCount).toBe(2);
    expect(result.totals.errorCount).toBe(312);
    expect(result.totals.patternCount).toBe(2);

    const empty = await buildWeeklyReport({
      history,
      timeZone: BOGOTA,
      streakWeeks: 0,
      now,
      query: queryReturning([]),
    });

    expect(empty.reports).toEqual([]);
    expect(empty.totals.alertCount).toBe(0);
  });
});
