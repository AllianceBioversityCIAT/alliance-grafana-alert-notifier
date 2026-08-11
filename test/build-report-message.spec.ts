import { describe, it, expect } from 'vitest';
import {
  buildEmptyReportMessage,
  buildReportMessage,
} from '../src/report/build-report-message.js';
import type { ApplicationReport } from '../src/report/report-aggregator.js';
import { getReportWeek } from '../src/report/report-window.js';

const week = getReportWeek({
  now: new Date('2026-08-11T19:15:00.000Z'),
  timeZone: 'America/Bogota',
});

function pattern(overrides: Record<string, unknown> = {}) {
  return {
    signature: 'sig-a',
    signatureText: 'normalized text',
    modulo: 'ClarisaTaskService',
    tipoError: 'QueryFailedError',
    alertCount: 18,
    errorCount: 200,
    occurrenceCount: 40,
    alertnames: ['PRMS Prod - Loki Error Alert'],
    consecutiveWeeks: 5,
    isNew: false,
    ...overrides,
  };
}

function report(overrides: Partial<ApplicationReport> = {}): ApplicationReport {
  return {
    application: 'PRMS',
    environment: 'prod',
    alertCount: 47,
    errorCount: 312,
    occurrenceCount: 120,
    patternCount: 9,
    outcomes: { notified: 47 },
    patterns: [pattern()],
    disappeared: [],
    ...overrides,
  } as ApplicationReport;
}

describe('buildReportMessage', () => {
  it('leads with the application, environment and ISO week', () => {
    const message = buildReportMessage({ report: report(), week });

    expect(message.startsWith('📊 Weekly report · PRMS prod\n')).toBe(true);
    expect(message).toContain('Week 2026-W32 (Aug 3 – Aug 9)');
  });

  it('summarises alerts, errors and patterns', () => {
    const message = buildReportMessage({ report: report(), week });

    expect(message).toContain('47 alerts · 312 errors · 9 distinct patterns');
  });

  it('flags a long streak, names a new pattern, and calls two weeks steady', () => {
    const message = buildReportMessage({
      report: report({
        patterns: [
          pattern({ consecutiveWeeks: 5 }),
          pattern({
            modulo: 'BilateralAiTextMiningService',
            tipoError: 'ETIMEDOUT',
            alertCount: 11,
            consecutiveWeeks: 1,
            isNew: true,
          }),
          pattern({
            modulo: 'System',
            tipoError: 'HttpException',
            alertCount: 8,
            consecutiveWeeks: 2,
          }),
        ],
      }),
      week,
    });

    expect(message).toContain('ClarisaTaskService · QueryFailedError');
    expect(message).toContain('18 alerts · 5 consecutive weeks ⚠️');
    expect(message).toContain('11 alerts · new this week 🆕');
    expect(message).toContain('8 alerts · steady');
  });

  it('caps the pattern list and says how many were held back', () => {
    const message = buildReportMessage({
      report: report({
        patterns: [
          pattern({ signature: 'a' }),
          pattern({ signature: 'b' }),
          pattern({ signature: 'c' }),
          pattern({ signature: 'd', modulo: 'NotShown' }),
        ],
      }),
      week,
    });

    expect(message).toContain('*Top 3 of 4 patterns*');
    expect(message).not.toContain('NotShown');
  });

  it('reports patterns that stopped occurring', () => {
    const message = buildReportMessage({
      report: report({
        disappeared: [
          {
            signature: 'sig-gone',
            signatureText: 'normalized',
            modulo: 'ClarisaApiConnection',
            tipoError: 'AxiosError 500',
            previousAlertCount: 3,
          },
        ],
      }),
      week,
    });

    expect(message).toContain('*Stopped occurring*');
    expect(message).toContain('· ClarisaApiConnection · AxiosError 500 ✅');
  });

  it('surfaces alerts that arrived with nothing to show', () => {
    const message = buildReportMessage({
      report: report({
        outcomes: { notified: 40, skipped_no_lines: 5, skipped_loki_error: 2 },
      }),
      week,
    });

    expect(message).toContain('7 alerts arrived with no log lines');
  });

  it('falls back to the normalized text when Bedrock never named the pattern', () => {
    const message = buildReportMessage({
      report: report({
        patterns: [
          pattern({
            modulo: null,
            tipoError: null,
            signatureText: 'ERROR [System] HttpException: token is required',
          }),
        ],
      }),
      week,
    });

    expect(message).toContain('ERROR [System] HttpException: token is required');
  });

  it('says so plainly when nothing happened', () => {
    const message = buildReportMessage({
      report: report({
        alertCount: 0,
        errorCount: 0,
        patternCount: 0,
        outcomes: {},
        patterns: [],
      }),
      week,
    });

    expect(message).toContain('No alerts this week.');
    expect(message).not.toContain('distinct pattern');
  });

  it('places the narrative above the numbers without replacing them', () => {
    const message = buildReportMessage({
      report: report(),
      week,
      narrative: 'Database write failures dominated the week.',
    });

    expect(message).toContain('Database write failures dominated the week.');
    expect(message).toContain('47 alerts · 312 errors · 9 distinct patterns');
    expect(message.indexOf('dominated')).toBeLessThan(
      message.indexOf('47 alerts'),
    );
  });

  it('adds the Grafana link only when a base URL is configured', () => {
    expect(buildReportMessage({ report: report(), week })).not.toContain(
      'View in Grafana',
    );

    expect(
      buildReportMessage({
        report: report(),
        week,
        grafanaBaseUrl: 'https://grafana.example.com',
      }),
    ).toContain('<https://grafana.example.com|View in Grafana>');
  });

  it('names an application it could not identify rather than hiding it', () => {
    const message = buildReportMessage({
      report: report({ application: null, environment: null }),
      week,
    });

    expect(message).toContain('📊 Weekly report · Unidentified application');
  });

  it('names the week even when nothing was recorded anywhere', () => {
    const message = buildEmptyReportMessage({ week });

    expect(message).toContain('📊 Weekly report');
    expect(message).toContain('Week 2026-W32 (Aug 3 – Aug 9)');
    expect(message).toContain('No alerts were recorded this week.');
  });

  it('uses singular wording for a single alert', () => {
    const message = buildReportMessage({
      report: report({
        alertCount: 1,
        errorCount: 1,
        patternCount: 1,
        patterns: [pattern({ alertCount: 1 })],
      }),
      week,
    });

    expect(message).toContain('1 alert · 1 error · 1 distinct pattern');
  });
});
