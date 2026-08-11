import type { HistoryConfig } from '../grafana/grafana-payload.types.js';
import type {
  AlertHistoryItem,
  QueryHistoryDay,
} from '../history/alert-history-store.js';
import {
  buildApplicationReports,
  type ApplicationReport,
} from './report-aggregator.js';
import {
  filterToWindow,
  getReportWeek,
  type ReportWeek,
} from './report-window.js';

export interface WeeklyReportTotals {
  alertCount: number;
  errorCount: number;
  patternCount: number;
  applicationCount: number;
}

export interface WeeklyReport {
  week: ReportWeek;
  reports: ApplicationReport[];
  totals: WeeklyReportTotals;
  /** Partitions actually read, for the diagnostic to show its work. */
  partitionsRead: number;
}

function totalsOf(reports: ApplicationReport[]): WeeklyReportTotals {
  return {
    alertCount: reports.reduce((sum, report) => sum + report.alertCount, 0),
    errorCount: reports.reduce((sum, report) => sum + report.errorCount, 0),
    // Patterns are per application, so this is the sum rather than a distinct
    // count across the whole table: the same signature in two applications is
    // two problems to two teams.
    patternCount: reports.reduce((sum, report) => sum + report.patternCount, 0),
    applicationCount: reports.length,
  };
}

/**
 * Reads the last complete week plus the weeks behind it, and turns them into
 * one report per application.
 *
 * The weeks overlap at their edges — the last UTC partition of one week is the
 * first of the next — so the union of partitions is read exactly once and each
 * week is then filtered to its own absolute bounds. Reading per week instead
 * would re-fetch those boundary days for every window.
 */
export async function buildWeeklyReport(input: {
  history: HistoryConfig;
  timeZone?: string;
  streakWeeks: number;
  now?: Date;
  query?: QueryHistoryDay;
}): Promise<WeeklyReport> {
  const query =
    input.query ??
    (await import('../history/dynamodb-client.js')).queryHistoryDay;

  const weeks: ReportWeek[] = [];
  for (let weeksAgo = 1; weeksAgo <= 1 + input.streakWeeks; weeksAgo += 1) {
    weeks.push(
      getReportWeek({ now: input.now, timeZone: input.timeZone, weeksAgo }),
    );
  }

  const partitionKeys = [
    ...new Set(weeks.flatMap((week) => week.partitionKeys)),
  ];

  const pages = await Promise.all(
    partitionKeys.map((partitionKey) =>
      query({
        region: input.history.region,
        tableName: input.history.tableName,
        partitionKey,
      }),
    ),
  );

  const items = pages.flat() as unknown as AlertHistoryItem[];

  const [current, ...previousWeeks] = weeks.map((week) =>
    filterToWindow(items, week),
  );

  const reports = buildApplicationReports({ current, previousWeeks });

  return {
    week: weeks[0],
    reports,
    totals: totalsOf(reports),
    partitionsRead: partitionKeys.length,
  };
}
