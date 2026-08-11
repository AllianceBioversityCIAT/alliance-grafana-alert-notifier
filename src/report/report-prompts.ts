import type { ApplicationReport } from './report-aggregator.js';
import type { ReportWeek } from './report-window.js';

export const REPORT_SYSTEM_PROMPT = `You are writing the opening paragraph of a weekly error report for an engineering team.

Rules:
- Return ONLY the paragraph. No markdown headings, no bullet lists, no preamble, no sign-off.
- Two or three sentences. Shorter is better.
- Every number you state must appear in the input. Never compute, estimate, or round a figure that is not given.
- Never invent a root cause, a responsible person, a fix, or a severity that the input does not state.
- The counts and the pattern list are printed directly below your paragraph. Do not restate them item by item; say what they add up to.
- Lead with what changed from the previous week: a pattern that is new, one whose streak is growing, or one that stopped.
- If nothing stands out, say the week was unremarkable rather than manufacturing a finding.
- Write in English, plainly, for a reader who already knows the system.`;

function describePattern(pattern: {
  modulo: string | null;
  tipoError: string | null;
  signatureText: string;
  alertCount: number;
  consecutiveWeeks: number;
  isNew: boolean;
}): string {
  const name =
    [pattern.modulo, pattern.tipoError].filter(Boolean).join(' · ') ||
    pattern.signatureText;

  const streak = pattern.isNew
    ? 'new this week'
    : `${pattern.consecutiveWeeks} consecutive weeks`;

  return `- ${name}: ${pattern.alertCount} alerts, ${streak}`;
}

/**
 * The narrative prompt sees aggregates only — never a raw log line.
 *
 * The per-alert path already sends log text to Bedrock, redacted; there is no
 * reason for the report to do it a second time, and keeping the input to counts
 * and pattern names is what makes the "never invent a number" rule checkable.
 */
export function buildReportUserPrompt(input: {
  report: ApplicationReport;
  week: ReportWeek;
}): string {
  const { report, week } = input;

  const skipped =
    (report.outcomes.skipped_no_lines ?? 0) +
    (report.outcomes.skipped_loki_error ?? 0);

  const lines = [
    'Write the opening paragraph for this weekly report.',
    `Week: ${week.label} (${week.rangeLabel})`,
    `Application: ${report.application ?? 'unidentified'}`,
    `Environment: ${report.environment ?? 'unidentified'}`,
    `Alerts: ${report.alertCount}`,
    `Errors: ${report.errorCount}`,
    `Distinct patterns: ${report.patternCount}`,
  ];

  if (skipped > 0) {
    lines.push(`Alerts that arrived with no log lines: ${skipped}`);
  }

  if (report.patterns.length > 0) {
    lines.push('Patterns, most frequent first:');
    lines.push(...report.patterns.map(describePattern));
  } else {
    lines.push('No patterns were recorded this week.');
  }

  if (report.disappeared.length > 0) {
    lines.push('Patterns that stopped occurring since last week:');
    lines.push(
      ...report.disappeared.map(
        (pattern) =>
          `- ${
            [pattern.modulo, pattern.tipoError].filter(Boolean).join(' · ') ||
            pattern.signatureText
          }: ${pattern.previousAlertCount} alerts last week, none this week`,
      ),
    );
  }

  return lines.join('\n');
}
