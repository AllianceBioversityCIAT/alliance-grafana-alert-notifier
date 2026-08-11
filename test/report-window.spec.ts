import { describe, it, expect } from 'vitest';
import {
  filterToWindow,
  getIsoWeek,
  getReportWeek,
} from '../src/report/report-window.js';

const BOGOTA = 'America/Bogota';
// Tuesday 2026-08-11, 14:15 in Bogota.
const now = new Date('2026-08-11T19:15:00.000Z');

describe('getIsoWeek', () => {
  it('numbers a mid-year week', () => {
    expect(getIsoWeek({ year: 2026, month: 8, day: 3 })).toEqual({
      isoYear: 2026,
      isoWeek: 32,
    });
  });

  it('assigns late-December days to the next ISO year', () => {
    // 2026-01-01 is a Thursday, so ISO week 1 of 2026 starts 2025-12-29.
    expect(getIsoWeek({ year: 2025, month: 12, day: 29 })).toEqual({
      isoYear: 2026,
      isoWeek: 1,
    });
  });

  it('assigns early-January days to the previous ISO year', () => {
    expect(getIsoWeek({ year: 2027, month: 1, day: 1 })).toEqual({
      isoYear: 2026,
      isoWeek: 53,
    });
  });

  it('handles a 53-week year', () => {
    // 2026 starts on a Thursday, so it has 53 ISO weeks.
    expect(getIsoWeek({ year: 2026, month: 12, day: 28 })).toEqual({
      isoYear: 2026,
      isoWeek: 53,
    });
  });
});

describe('getReportWeek', () => {
  it('returns the last complete Monday-to-Sunday week in the reader timezone', () => {
    const week = getReportWeek({ now, timeZone: BOGOTA });

    // Midnight in Bogota is 05:00 UTC.
    expect(week.startIso).toBe('2026-08-03T05:00:00.000Z');
    expect(week.endIso).toBe('2026-08-10T05:00:00.000Z');
    expect(week.label).toBe('2026-W32');
    expect(week.rangeLabel).toBe('Aug 3 – Aug 9');
  });

  it('covers exactly the UTC partitions the local week spans', () => {
    const week = getReportWeek({ now, timeZone: BOGOTA });

    // A local week offset from UTC touches eight UTC dates, not seven.
    expect(week.partitionKeys).toEqual([
      'DAY#2026-08-03',
      'DAY#2026-08-04',
      'DAY#2026-08-05',
      'DAY#2026-08-06',
      'DAY#2026-08-07',
      'DAY#2026-08-08',
      'DAY#2026-08-09',
      'DAY#2026-08-10',
    ]);
  });

  it('walks further back with weeksAgo, which is how streaks are counted', () => {
    const previous = getReportWeek({ now, timeZone: BOGOTA, weeksAgo: 2 });

    expect(previous.startIso).toBe('2026-07-27T05:00:00.000Z');
    expect(previous.endIso).toBe('2026-08-03T05:00:00.000Z');
    expect(previous.label).toBe('2026-W31');
  });

  it('falls back to UTC when no timezone is configured', () => {
    // LOG_TIMEZONE is empty whenever Bedrock is disabled.
    const week = getReportWeek({ now, timeZone: '' });

    expect(week.startIso).toBe('2026-08-03T00:00:00.000Z');
    expect(week.endIso).toBe('2026-08-10T00:00:00.000Z');
    expect(week.partitionKeys).toHaveLength(7);
    expect(week.partitionKeys[6]).toBe('DAY#2026-08-09');
  });

  it('labels a week that straddles the year with its ISO week-year and the year in the range', () => {
    const week = getReportWeek({
      now: new Date('2026-01-06T12:00:00.000Z'),
      timeZone: BOGOTA,
    });

    // The week of 2025-12-29 belongs to ISO year 2026, not 2025.
    expect(week.label).toBe('2026-W01');
    expect(week.rangeLabel).toBe('Dec 29, 2025 – Jan 4, 2026');
  });

  it('produces a seven-day window whatever the DST state of the zone', () => {
    // America/Bogota has no DST, so use a zone that does: the window must stay
    // exactly seven local days even when the offset shifts inside it.
    const week = getReportWeek({
      now: new Date('2026-11-05T12:00:00.000Z'),
      timeZone: 'America/New_York',
      weeksAgo: 1,
    });

    const spanMs = Date.parse(week.endIso) - Date.parse(week.startIso);
    // 7 days plus the hour gained when the clocks went back on Nov 1.
    expect(spanMs).toBe(7 * 86_400_000 + 3_600_000);
    expect(week.rangeLabel).toBe('Oct 26 – Nov 1');
  });
});

describe('filterToWindow', () => {
  it('drops the neighbouring-week items the edge partitions also hold', () => {
    const week = getReportWeek({ now, timeZone: BOGOTA });

    const items = [
      { recordedAt: '2026-08-03T04:59:59.999Z' }, // still the previous week
      { recordedAt: '2026-08-03T05:00:00.000Z' }, // first instant in window
      { recordedAt: '2026-08-06T12:00:00.000Z' },
      { recordedAt: '2026-08-10T04:59:59.999Z' }, // last instant in window
      { recordedAt: '2026-08-10T05:00:00.000Z' }, // already the next week
    ];

    expect(filterToWindow(items, week).map((item) => item.recordedAt)).toEqual([
      '2026-08-03T05:00:00.000Z',
      '2026-08-06T12:00:00.000Z',
      '2026-08-10T04:59:59.999Z',
    ]);
  });
});
