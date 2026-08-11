const MS_PER_DAY = 86_400_000;

export interface ReportWeek {
  /** ISO week-numbering year — not always the calendar year at the edges. */
  isoYear: number;
  isoWeek: number;
  /** `2026-W32` */
  label: string;
  /** `Jul 28 – Aug 3`, carrying the year only when the week straddles one. */
  rangeLabel: string;
  /** Inclusive start of the week, as an absolute instant. */
  startIso: string;
  /** Exclusive end of the week, as an absolute instant. */
  endIso: string;
  /**
   * Every `DAY#` partition the window touches. Derived from the window's real
   * UTC instants, so it is exact: an item recorded inside the window always has
   * a UTC date within this set. Callers still filter by `recordedAt`, because
   * the edge partitions also hold items from the neighbouring weeks.
   */
  partitionKeys: string[];
}

export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

function resolveTimeZone(timeZone?: string): string {
  const trimmed = timeZone?.trim();
  return trimmed ? trimmed : 'UTC';
}

/**
 * Milliseconds to add to an instant to get the wall clock in `timeZone`.
 *
 * `Intl` is the only timezone database available here, and it formats rather
 * than computes — so the offset is recovered by formatting the instant and
 * reading the difference back.
 */
function getOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    // h23 matters: en-US with hour12:false emits hour "24" for midnight, which
    // Date.UTC would silently roll into the next day.
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const read = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  );

  return asUtc - date.getTime();
}

/** The absolute instant of a wall-clock midnight in `timeZone`. */
function zonedMidnightToInstant(local: LocalDate, timeZone: string): Date {
  const asUtc = Date.UTC(local.year, local.month - 1, local.day);

  // Two passes: the first offset is read at the wrong instant, the second at one
  // close enough that only a DST transition landing inside the gap could move
  // it — and midnight is not a transition hour in any zone this runs in.
  const firstPass = asUtc - getOffsetMs(new Date(asUtc), timeZone);
  const secondPass = asUtc - getOffsetMs(new Date(firstPass), timeZone);

  return new Date(secondPass);
}

function toLocalDate(date: Date, timeZone: string): LocalDate {
  const shifted = new Date(date.getTime() + getOffsetMs(date, timeZone));

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function addDays(local: LocalDate, days: number): LocalDate {
  const shifted = new Date(
    Date.UTC(local.year, local.month - 1, local.day) + days * MS_PER_DAY,
  );

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** Monday = 0 … Sunday = 6. */
function isoDayIndex(local: LocalDate): number {
  const weekday = new Date(
    Date.UTC(local.year, local.month - 1, local.day),
  ).getUTCDay();

  return (weekday + 6) % 7;
}

/**
 * ISO 8601 week number and week-numbering year.
 *
 * The week-year is not the calendar year at the edges: 2026-01-01 can belong to
 * week 53 of 2025, and late December can belong to week 1 of the next year.
 * Reporting the calendar year there would label two different weeks identically.
 */
export function getIsoWeek(local: LocalDate): {
  isoYear: number;
  isoWeek: number;
} {
  // Shift to the Thursday of this week: the ISO year is whichever year that
  // Thursday falls in, by definition.
  const thursday = addDays(local, 3 - isoDayIndex(local));
  const isoYear = thursday.year;

  const firstThursday = Date.UTC(isoYear, 0, 4);
  const firstThursdayLocal = {
    year: isoYear,
    month: 1,
    day: 4,
  };
  const firstMonday =
    firstThursday - isoDayIndex(firstThursdayLocal) * MS_PER_DAY;

  const thursdayMs = Date.UTC(thursday.year, thursday.month - 1, thursday.day);
  const isoWeek = Math.round((thursdayMs - firstMonday) / MS_PER_DAY / 7) + 1;

  return { isoYear, isoWeek };
}

function formatShortDate(
  date: Date,
  timeZone: string,
  withYear: boolean,
): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  }).format(date);
}

function toPartitionKeys(startIso: string, endIso: string): string[] {
  const startDay = Date.parse(`${startIso.slice(0, 10)}T00:00:00.000Z`);
  // endIso is exclusive: step back a millisecond so a window ending exactly at
  // midnight UTC does not pull in an empty extra partition.
  const lastDay = Date.parse(
    `${new Date(Date.parse(endIso) - 1).toISOString().slice(0, 10)}T00:00:00.000Z`,
  );

  const keys: string[] = [];
  for (let day = startDay; day <= lastDay; day += MS_PER_DAY) {
    keys.push(`DAY#${new Date(day).toISOString().slice(0, 10)}`);
  }

  return keys;
}

/**
 * The complete week ending before `now`, expressed in `timeZone`.
 *
 * `weeksAgo` walks further back — 1 is the most recent complete week, 2 the one
 * before it — which is how the report builds the streak of consecutive weeks.
 *
 * Weeks are Monday-based and labelled in the reader's zone, while the stored
 * partitions are keyed by UTC date. Both facts are reconciled here: the window
 * is a pair of absolute instants, and `partitionKeys` covers exactly the UTC
 * days those instants span.
 */
export function getReportWeek(input: {
  now?: Date;
  timeZone?: string;
  weeksAgo?: number;
}): ReportWeek {
  const timeZone = resolveTimeZone(input.timeZone);
  const now = input.now ?? new Date();
  const weeksAgo = input.weeksAgo ?? 1;

  const today = toLocalDate(now, timeZone);
  const startOfThisWeek = addDays(today, -isoDayIndex(today));
  const startLocal = addDays(startOfThisWeek, -7 * weeksAgo);
  const endLocal = addDays(startLocal, 7);

  const start = zonedMidnightToInstant(startLocal, timeZone);
  const end = zonedMidnightToInstant(endLocal, timeZone);
  const lastDayOfWeek = new Date(end.getTime() - 1);

  const { isoYear, isoWeek } = getIsoWeek(startLocal);
  const endDisplayLocal = addDays(startLocal, 6);
  const straddlesYear = startLocal.year !== endDisplayLocal.year;

  const startIso = start.toISOString();
  const endIso = end.toISOString();

  return {
    isoYear,
    isoWeek,
    label: `${isoYear}-W${String(isoWeek).padStart(2, '0')}`,
    rangeLabel: `${formatShortDate(start, timeZone, straddlesYear)} – ${formatShortDate(
      lastDayOfWeek,
      timeZone,
      straddlesYear,
    )}`,
    startIso,
    endIso,
    partitionKeys: toPartitionKeys(startIso, endIso),
  };
}

/** Keeps only the items actually inside the window's absolute bounds. */
export function filterToWindow<T extends { recordedAt: string }>(
  items: T[],
  week: Pick<ReportWeek, 'startIso' | 'endIso'>,
): T[] {
  return items.filter(
    (item) => item.recordedAt >= week.startIso && item.recordedAt < week.endIso,
  );
}
