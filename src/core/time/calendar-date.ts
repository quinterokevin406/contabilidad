/**
 * Calendar dates for the financial domain.
 *
 * A loan has no time of day. Its disbursement, its due dates and its closure are
 * calendar facts, and modelling them as `Date` objects is how systems end up
 * with a payment recorded on the 23rd because the server happened to run in UTC
 * while the business runs in Bogota.
 *
 * So the domain speaks `CalendarDate`: an immutable "YYYY-MM-DD" string. Time
 * zones exist in exactly two places -- deciding what "today" is, and converting
 * an instant into a business date -- and nowhere else.
 */

declare const calendarDateBrand: unique symbol;

/** A validated "YYYY-MM-DD" calendar date. */
export type CalendarDate = string & { readonly [calendarDateBrand]: true };

export class CalendarDateError extends Error {}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) {
    throw new CalendarDateError(`Month out of range: ${month}`);
  }
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1]!;
}

/** Parses and validates a "YYYY-MM-DD" string. */
export function calendarDate(value: string): CalendarDate {
  const match = ISO_DATE.exec(value.trim());
  if (!match) {
    throw new CalendarDateError(
      `Expected a YYYY-MM-DD date, received "${value}".`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12) {
    throw new CalendarDateError(`Invalid month in "${value}".`);
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new CalendarDateError(`Invalid day in "${value}".`);
  }
  return value.trim() as CalendarDate;
}

export function isCalendarDate(value: unknown): value is CalendarDate {
  if (typeof value !== "string") return false;
  try {
    calendarDate(value);
    return true;
  } catch {
    return false;
  }
}

export interface CalendarParts {
  year: number;
  month: number;
  day: number;
}

export function toParts(date: CalendarDate): CalendarParts {
  const match = ISO_DATE.exec(date)!;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

export function fromParts({ year, month, day }: CalendarParts): CalendarDate {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return calendarDate(`${year}-${mm}-${dd}`);
}

// --- Arithmetic -------------------------------------------------------------
// Implemented on UTC epoch days so no local time zone can ever shift a result.

const MS_PER_DAY = 86_400_000;

function toEpochDay(date: CalendarDate): number {
  const { year, month, day } = toParts(date);
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

function fromEpochDay(epochDay: number): CalendarDate {
  const d = new Date(epochDay * MS_PER_DAY);
  return fromParts({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  });
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  if (!Number.isInteger(days)) {
    throw new CalendarDateError("addDays requires a whole number of days.");
  }
  return fromEpochDay(toEpochDay(date) + days);
}

/**
 * Adds calendar months, clamping to the end of the target month.
 *
 * 31 January + 1 month is 28 February (29 in a leap year), not 3 March. This is
 * the only reading that keeps a monthly loan anchored to its day of the month,
 * and it is the behaviour the specification's own example implies.
 */
export function addMonths(date: CalendarDate, months: number): CalendarDate {
  if (!Number.isInteger(months)) {
    throw new CalendarDateError("addMonths requires a whole number of months.");
  }
  const { year, month, day } = toParts(date);
  const zeroBased = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(zeroBased / 12);
  const targetMonth = (zeroBased % 12 + 12) % 12 + 1;
  const clampedDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return fromParts({ year: targetYear, month: targetMonth, day: clampedDay });
}

/** Whole days from `from` to `to`. Negative when `to` precedes `from`. */
export function differenceInDays(from: CalendarDate, to: CalendarDate): number {
  return toEpochDay(to) - toEpochDay(from);
}

export function compareCalendarDates(a: CalendarDate, b: CalendarDate): number {
  // Lexicographic comparison is chronological for zero-padded ISO dates.
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isBefore(a: CalendarDate, b: CalendarDate): boolean {
  return a < b;
}

export function isAfter(a: CalendarDate, b: CalendarDate): boolean {
  return a > b;
}

export function isSameOrBefore(a: CalendarDate, b: CalendarDate): boolean {
  return a <= b;
}

export function isSameOrAfter(a: CalendarDate, b: CalendarDate): boolean {
  return a >= b;
}

export function minCalendarDate(a: CalendarDate, b: CalendarDate): CalendarDate {
  return a <= b ? a : b;
}

export function maxCalendarDate(a: CalendarDate, b: CalendarDate): CalendarDate {
  return a >= b ? a : b;
}

// --- Month and week boundaries ---------------------------------------------

export function startOfMonth(date: CalendarDate): CalendarDate {
  const { year, month } = toParts(date);
  return fromParts({ year, month, day: 1 });
}

export function endOfMonth(date: CalendarDate): CalendarDate {
  const { year, month } = toParts(date);
  return fromParts({ year, month, day: daysInMonth(year, month) });
}

/** ISO weekday: 1 = Monday through 7 = Sunday. */
export function isoWeekday(date: CalendarDate): number {
  const { year, month, day } = toParts(date);
  const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

/** Monday of the week containing `date`. */
export function startOfIsoWeek(date: CalendarDate): CalendarDate {
  return addDays(date, -(isoWeekday(date) - 1));
}

/** Sunday of the week containing `date`. */
export function endOfIsoWeek(date: CalendarDate): CalendarDate {
  return addDays(startOfIsoWeek(date), 6);
}

/** ISO-8601 week number and its week-numbering year. */
export function isoWeek(date: CalendarDate): { year: number; week: number } {
  // The Thursday of the current ISO week always falls in the correct year.
  const thursday = addDays(startOfIsoWeek(date), 3);
  const { year } = toParts(thursday);
  const jan1 = fromParts({ year, month: 1, day: 1 });
  const firstThursday = addDays(startOfIsoWeek(jan1), 3);
  const week =
    Math.floor(differenceInDays(startOfIsoWeek(firstThursday), startOfIsoWeek(date)) / 7) + 1;
  return { year, week };
}

// --- Time zone boundary ----------------------------------------------------

/**
 * The business date an instant falls on, in the given IANA zone.
 *
 * This is one of only two functions in the domain that know about time zones.
 * Everything downstream receives a CalendarDate and cannot get the day wrong.
 */
export function toBusinessDate(instant: Date, timeZone: string): CalendarDate {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA renders as YYYY-MM-DD, which is exactly our wire format.
  return calendarDate(formatter.format(instant));
}

/** Today's business date in the given zone. */
export function todayIn(timeZone: string, now: Date = new Date()): CalendarDate {
  return toBusinessDate(now, timeZone);
}

// --- Prisma boundary -------------------------------------------------------

/**
 * Converts to the value Prisma stores in a `@db.Date` column.
 *
 * UTC midnight is used deliberately: Postgres `date` carries no zone, and
 * pinning the JS Date to UTC midnight means it round-trips to the same calendar
 * day regardless of where the process runs.
 */
export function toPrismaDate(date: CalendarDate): Date {
  const { year, month, day } = toParts(date);
  return new Date(Date.UTC(year, month - 1, day));
}

/** Reads a `@db.Date` column back into a CalendarDate. */
export function fromPrismaDate(value: Date): CalendarDate {
  return fromParts({
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  });
}
