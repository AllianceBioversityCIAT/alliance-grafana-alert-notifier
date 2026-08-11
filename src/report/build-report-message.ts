import type {
  ApplicationReport,
  DisappearedPattern,
  PatternReport,
} from './report-aggregator.js';
import type { ReportWeek } from './report-window.js';

/**
 * How many patterns the message names. Same spirit as `LOKI_LINE_LIMIT` in
 * `preview-slack-message.ts`: a display cap, not a tunable threshold. A weekly
 * report that lists everything is a report nobody reads.
 */
const TOP_PATTERNS = 3;

/** A streak worth flagging rather than merely reporting. */
const STREAK_WARNING_WEEKS = 3;

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function describeScope(report: ApplicationReport): string {
  const application = report.application ?? 'Unidentified application';
  return report.environment
    ? `${application} ${report.environment}`
    : application;
}

function describePattern(pattern: PatternReport): string {
  const name =
    [pattern.modulo, pattern.tipoError].filter(Boolean).join(' · ') ||
    // No Bedrock analysis for this pattern: the normalized text is what names
    // it, and it is already redacted and identifier-stripped.
    pattern.signatureText;

  const alerts = plural(pattern.alertCount, 'alert');

  if (pattern.isNew) {
    return `${name}\n   ${alerts} · new this week 🆕`;
  }

  if (pattern.consecutiveWeeks >= STREAK_WARNING_WEEKS) {
    return `${name}\n   ${alerts} · ${pattern.consecutiveWeeks} consecutive weeks ⚠️`;
  }

  return `${name}\n   ${alerts} · steady`;
}

function describeDisappeared(pattern: DisappearedPattern): string {
  const name =
    [pattern.modulo, pattern.tipoError].filter(Boolean).join(' · ') ||
    pattern.signatureText;

  return `· ${name} ✅`;
}

function countSkipped(report: ApplicationReport): number {
  return (
    (report.outcomes.skipped_no_lines ?? 0) +
    (report.outcomes.skipped_loki_error ?? 0)
  );
}

/**
 * The deterministic report for one application. Bedrock's narrative, when it
 * runs, is prepended to this — never a replacement for it, because delivery
 * must not depend on the model.
 */
export function buildReportMessage(input: {
  report: ApplicationReport;
  week: ReportWeek;
  narrative?: string | null;
  grafanaBaseUrl?: string;
}): string {
  const { report, week } = input;
  const lines: string[] = [];

  lines.push(`📊 Weekly report · ${describeScope(report)}`);
  lines.push(`Week ${week.label} (${week.rangeLabel})`);

  if (input.narrative?.trim()) {
    lines.push('', input.narrative.trim());
  }

  lines.push('', '*Summary*');

  if (report.alertCount === 0) {
    lines.push('No alerts this week.');
  } else {
    lines.push(
      [
        plural(report.alertCount, 'alert'),
        plural(report.errorCount, 'error'),
        `${plural(report.patternCount, 'distinct pattern')}`,
      ].join(' · '),
    );
  }

  const skipped = countSkipped(report);
  if (skipped > 0) {
    // Real signal about pipeline health, not noise: these alerts fired and had
    // nothing to show, which is why they are stored in the first place.
    lines.push(`${plural(skipped, 'alert')} arrived with no log lines`);
  }

  if (report.patterns.length > 0) {
    const shown = report.patterns.slice(0, TOP_PATTERNS);
    const heading =
      report.patterns.length > shown.length
        ? `*Top ${shown.length} of ${report.patterns.length} patterns*`
        : '*Patterns*';

    lines.push('', heading);
    shown.forEach((pattern, index) => {
      lines.push(`${index + 1}. ${describePattern(pattern)}`);
    });
  }

  if (report.disappeared.length > 0) {
    lines.push('', '*Stopped occurring*');
    for (const pattern of report.disappeared) {
      lines.push(describeDisappeared(pattern));
    }
  }

  if (input.grafanaBaseUrl) {
    lines.push('', `<${input.grafanaBaseUrl}|View in Grafana>`);
  }

  return lines.join('\n');
}
