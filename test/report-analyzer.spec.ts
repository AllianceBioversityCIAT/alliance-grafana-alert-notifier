import { describe, it, expect, vi } from 'vitest';
import type {
  BedrockConfig,
  ReportConfig,
} from '../src/grafana/grafana-payload.types.js';
import { writeReportNarrative } from '../src/report/report-analyzer.js';
import {
  buildReportUserPrompt,
  REPORT_SYSTEM_PROMPT,
} from '../src/report/report-prompts.js';
import type { ApplicationReport } from '../src/report/report-aggregator.js';
import { getReportWeek } from '../src/report/report-window.js';

const week = getReportWeek({
  now: new Date('2026-08-11T19:15:00.000Z'),
  timeZone: 'America/Bogota',
});

const bedrock: BedrockConfig = {
  enabled: true,
  modelId: 'amazon.nova-micro-v1:0',
  region: 'us-east-1',
  maxTokens: 500,
  confidenceThreshold: 0.6,
  timeoutMs: 8000,
  maxInputChars: 6000,
  dateFormat: 'MM/DD/YYYY',
  timezone: 'America/Bogota',
};

const reportConfig: ReportConfig = {
  enabled: true,
  streakWeeks: 4,
  bedrockMaxTokens: 1200,
  bedrockTimeoutMs: 20000,
};

function report(overrides: Partial<ApplicationReport> = {}): ApplicationReport {
  return {
    application: 'PRMS',
    environment: 'prod',
    alertCount: 47,
    errorCount: 312,
    occurrenceCount: 120,
    patternCount: 2,
    outcomes: { notified: 47 },
    patterns: [
      {
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
      },
    ],
    disappeared: [],
    ...overrides,
  } as ApplicationReport;
}

describe('writeReportNarrative', () => {
  it('returns the paragraph and reports Bedrock was used', async () => {
    const converse = vi.fn().mockResolvedValue({
      text: '  Database write failures dominated the week.  ',
    });

    const result = await writeReportNarrative({
      report: report(),
      week,
      bedrock,
      reportConfig,
      converse,
    });

    expect(result.usedBedrock).toBe(true);
    expect(result.narrative).toBe('Database write failures dominated the week.');
  });

  it('spends the report budget, not the per-alert one', async () => {
    const converse = vi.fn().mockResolvedValue({ text: 'A quiet week.' });

    await writeReportNarrative({
      report: report(),
      week,
      bedrock,
      reportConfig,
      converse,
    });

    expect(converse.mock.calls[0][0]).toMatchObject({
      maxTokens: 1200,
      timeoutMs: 20000,
      modelId: 'amazon.nova-micro-v1:0',
      region: 'us-east-1',
      systemPrompt: REPORT_SYSTEM_PROMPT,
    });
  });

  it('falls back without throwing when Bedrock fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const converse = vi
      .fn()
      .mockRejectedValue(new Error('Bedrock converse timed out after 20000ms'));

    const result = await writeReportNarrative({
      report: report(),
      week,
      bedrock,
      reportConfig,
      converse,
    });

    expect(result.narrative).toBeNull();
    expect(result.usedBedrock).toBe(false);
    expect(result.fallbackReason).toContain('timed out');
    consoleError.mockRestore();
  });

  it('skips Bedrock entirely when it is disabled', async () => {
    const converse = vi.fn();

    const result = await writeReportNarrative({
      report: report(),
      week,
      bedrock: { ...bedrock, enabled: false },
      reportConfig,
      converse,
    });

    expect(converse).not.toHaveBeenCalled();
    expect(result.fallbackReason).toBe('bedrock_disabled');
  });

  it('does not ask a model to narrate a week in which nothing happened', async () => {
    const converse = vi.fn();

    const result = await writeReportNarrative({
      report: report({ alertCount: 0, patterns: [], patternCount: 0 }),
      week,
      bedrock,
      reportConfig,
      converse,
    });

    expect(converse).not.toHaveBeenCalled();
    expect(result.fallbackReason).toBe('empty_week');
  });

  it('treats an empty answer as no narrative', async () => {
    const converse = vi.fn().mockResolvedValue({ text: '   ' });

    const result = await writeReportNarrative({
      report: report(),
      week,
      bedrock,
      reportConfig,
      converse,
    });

    expect(result.narrative).toBeNull();
    expect(result.fallbackReason).toBe('empty_narrative');
  });

  it('caps a runaway answer', async () => {
    const converse = vi.fn().mockResolvedValue({ text: 'x'.repeat(5000) });

    const result = await writeReportNarrative({
      report: report(),
      week,
      bedrock,
      reportConfig,
      converse,
    });

    expect(result.narrative).toHaveLength(1200);
  });
});

describe('buildReportUserPrompt', () => {
  it('sends aggregates only, never a log line', () => {
    const prompt = buildReportUserPrompt({ report: report(), week });

    expect(prompt).toContain('Week: 2026-W32 (Aug 3 – Aug 9)');
    expect(prompt).toContain('Application: PRMS');
    expect(prompt).toContain('Alerts: 47');
    expect(prompt).toContain('Errors: 312');
    expect(prompt).toContain(
      '- ClarisaTaskService · QueryFailedError: 18 alerts, 5 consecutive weeks',
    );
    // representativeLogs is never threaded into the report path at all.
    expect(prompt).not.toContain('representativeLogs');
  });

  it('marks a new pattern as new rather than as a one-week streak', () => {
    const prompt = buildReportUserPrompt({
      report: report({
        patterns: [
          {
            ...report().patterns[0],
            consecutiveWeeks: 1,
            isNew: true,
          },
        ],
      }),
      week,
    });

    expect(prompt).toContain('new this week');
    expect(prompt).not.toContain('1 consecutive weeks');
  });

  it('states the skipped alerts and the patterns that stopped', () => {
    const prompt = buildReportUserPrompt({
      report: report({
        outcomes: { notified: 40, skipped_no_lines: 5, skipped_loki_error: 2 },
        disappeared: [
          {
            signature: 'sig-gone',
            signatureText: 'normalized',
            modulo: 'ClarisaApiConnection',
            tipoError: 'AxiosError',
            previousAlertCount: 3,
          },
        ],
      }),
      week,
    });

    expect(prompt).toContain('Alerts that arrived with no log lines: 7');
    expect(prompt).toContain('3 alerts last week, none this week');
  });

  it('says plainly when there is nothing to describe', () => {
    const prompt = buildReportUserPrompt({
      report: report({ patterns: [], patternCount: 0, alertCount: 0 }),
      week,
    });

    expect(prompt).toContain('No patterns were recorded this week.');
  });
});
