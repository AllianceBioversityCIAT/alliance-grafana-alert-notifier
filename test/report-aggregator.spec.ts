import { describe, it, expect } from 'vitest';
import type { AlertHistoryItem } from '../src/history/alert-history-store.js';
import { buildApplicationReports } from '../src/report/report-aggregator.js';

function item(overrides: Partial<AlertHistoryItem>): AlertHistoryItem {
  return {
    pk: 'DAY#2026-08-03',
    sk: '2026-08-03T10:00:00.000Z#abcd1234',
    signature: 'sig-a',
    signatureText: 'ClarisaTaskService · QueryFailedError',
    recordedAt: '2026-08-03T10:00:00.000Z',
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

describe('buildApplicationReports', () => {
  it('groups by application and environment', () => {
    const reports = buildApplicationReports({
      current: [
        item({}),
        item({ application: 'CLARISA', signature: 'sig-b' }),
        item({ application: 'PRMS', environment: 'test', signature: 'sig-c' }),
      ],
    });

    expect(reports).toHaveLength(3);
    expect(
      reports.map((r) => `${r.application}/${r.environment}`).sort(),
    ).toEqual(['CLARISA/prod', 'PRMS/prod', 'PRMS/test']);
  });

  it('sums the real error count treating nulls as zero', () => {
    const reports = buildApplicationReports({
      current: [
        item({ errorCount: 10 }),
        item({ errorCount: null }),
        item({ errorCount: 302 }),
      ],
    });

    expect(reports[0].errorCount).toBe(312);
    expect(reports[0].alertCount).toBe(3);
  });

  it('sums occurrences, which skipped alerts contribute zero to', () => {
    const reports = buildApplicationReports({
      current: [
        item({ occurrences: 4 }),
        item({ occurrences: 0, outcome: 'skipped_no_lines', errorCount: null }),
      ],
    });

    expect(reports[0].occurrenceCount).toBe(4);
    expect(reports[0].outcomes).toEqual({ notified: 1, skipped_no_lines: 1 });
  });

  it('counts distinct signatures as patterns and orders them by frequency', () => {
    const reports = buildApplicationReports({
      current: [
        item({ signature: 'sig-a' }),
        item({ signature: 'sig-b' }),
        item({ signature: 'sig-a' }),
        item({ signature: 'sig-a' }),
      ],
    });

    expect(reports[0].patternCount).toBe(2);
    expect(reports[0].patterns[0].signature).toBe('sig-a');
    expect(reports[0].patterns[0].alertCount).toBe(3);
    expect(reports[0].patterns[1].alertCount).toBe(1);
  });

  it('marks a pattern new when the previous week did not carry it', () => {
    const reports = buildApplicationReports({
      current: [item({ signature: 'sig-new' })],
      previousWeeks: [[item({ signature: 'sig-old' })]],
    });

    expect(reports[0].patterns[0].isNew).toBe(true);
    expect(reports[0].patterns[0].consecutiveWeeks).toBe(1);
  });

  it('counts the streak of consecutive weeks', () => {
    const reports = buildApplicationReports({
      current: [item({ signature: 'sig-a' })],
      previousWeeks: [
        [item({ signature: 'sig-a' })],
        [item({ signature: 'sig-a' })],
        [item({ signature: 'sig-a' })],
      ],
    });

    expect(reports[0].patterns[0].consecutiveWeeks).toBe(4);
    expect(reports[0].patterns[0].isNew).toBe(false);
  });

  it('breaks the streak at the first gap', () => {
    // Present now and two weeks ago, but absent last week: that is a new
    // streak, not a four-week one.
    const reports = buildApplicationReports({
      current: [item({ signature: 'sig-a' })],
      previousWeeks: [
        [item({ signature: 'sig-other' })],
        [item({ signature: 'sig-a' })],
      ],
    });

    expect(reports[0].patterns[0].consecutiveWeeks).toBe(1);
    expect(reports[0].patterns[0].isNew).toBe(true);
  });

  it('counts the streak per application, not globally', () => {
    const reports = buildApplicationReports({
      current: [item({ signature: 'sig-a', application: 'PRMS' })],
      previousWeeks: [[item({ signature: 'sig-a', application: 'CLARISA' })]],
    });

    const prms = reports.find((r) => r.application === 'PRMS');
    expect(prms?.patterns[0].consecutiveWeeks).toBe(1);
  });

  it('reports patterns that stopped occurring', () => {
    const reports = buildApplicationReports({
      current: [item({ signature: 'sig-a' })],
      previousWeeks: [
        [
          item({ signature: 'sig-a' }),
          item({ signature: 'sig-gone', tipoError: 'AxiosError' }),
          item({ signature: 'sig-gone', tipoError: 'AxiosError' }),
        ],
      ],
    });

    expect(reports[0].disappeared).toHaveLength(1);
    expect(reports[0].disappeared[0].signature).toBe('sig-gone');
    expect(reports[0].disappeared[0].previousAlertCount).toBe(2);
  });

  it('still reports an application whose every pattern stopped', () => {
    const reports = buildApplicationReports({
      current: [],
      previousWeeks: [[item({ signature: 'sig-gone' })]],
    });

    expect(reports).toHaveLength(1);
    expect(reports[0].application).toBe('PRMS');
    expect(reports[0].alertCount).toBe(0);
    expect(reports[0].patterns).toEqual([]);
    expect(reports[0].disappeared).toHaveLength(1);
  });

  it('recovers module and error type from a later item when the first lacks them', () => {
    // Bedrock does not run on every alert, so the first record of a group can
    // carry nulls while a later one has the analysis.
    const reports = buildApplicationReports({
      current: [
        item({ signature: 'sig-a', modulo: null, tipoError: null }),
        item({ signature: 'sig-a', modulo: 'ClarisaTaskService', tipoError: 'QueryFailedError' }),
      ],
    });

    expect(reports[0].patterns[0].modulo).toBe('ClarisaTaskService');
    expect(reports[0].patterns[0].tipoError).toBe('QueryFailedError');
  });

  it('keeps records whose metadata could not be derived under a null application', () => {
    const reports = buildApplicationReports({
      current: [item({ application: null, environment: null })],
    });

    expect(reports[0].application).toBeNull();
    expect(reports[0].environment).toBeNull();
    expect(reports[0].alertCount).toBe(1);
  });

  it('orders applications by how noisy they were', () => {
    const reports = buildApplicationReports({
      current: [
        item({ application: 'QUIET' }),
        item({ application: 'NOISY' }),
        item({ application: 'NOISY' }),
        item({ application: 'NOISY' }),
      ],
    });

    expect(reports.map((r) => r.application)).toEqual(['NOISY', 'QUIET']);
  });
});
