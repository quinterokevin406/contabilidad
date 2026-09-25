import { differenceInDays, toParts, type CalendarDate } from "./calendar-date";

/**
 * Date presentation (point 2): Colombian format, dd/MM/yyyy.
 *
 * Formatting is done by hand from the calendar parts rather than through
 * `Intl.DateTimeFormat` on a `Date`, because handing a Date to Intl reintroduces
 * exactly the time-zone shift that CalendarDate exists to eliminate.
 */

const MONTHS_SHORT = [
  "ENE",
  "FEB",
  "MAR",
  "ABR",
  "MAY",
  "JUN",
  "JUL",
  "AGO",
  "SEP",
  "OCT",
  "NOV",
  "DIC",
] as const;

const MONTHS_LONG = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const;

export class DateFormatError extends Error {}

/**
 * Guarded month-name lookup.
 *
 * With `noUncheckedIndexedAccess` on, indexing these tables yields a possibly
 * undefined value. Rather than silencing that with a non-null assertion, the
 * range is checked here so an out-of-range month fails with a clear message
 * instead of rendering "undefined 2026" on a receipt.
 */
function monthName(table: readonly string[], month: number): string {
  const name = table[month - 1];
  if (name === undefined) {
    throw new DateFormatError(`Month out of range: ${month}`);
  }
  return name;
}

/** 24/09/2026 */
export function formatDate(date: CalendarDate): string {
  const { year, month, day } = toParts(date);
  return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;
}

/** 24 SEP — for timelines and compact rows. */
export function formatDateShort(date: CalendarDate): string {
  const { month, day } = toParts(date);
  return `${String(day).padStart(2, "0")} ${monthName(MONTHS_SHORT, month)}`;
}

/** 24 de septiembre de 2026 — for receipts and printed documents. */
export function formatDateLong(date: CalendarDate): string {
  const { year, month, day } = toParts(date);
  return `${day} de ${monthName(MONTHS_LONG, month)} de ${year}`;
}

/** SEP 2026 — for monthly closure headers. */
export function formatMonthShort(year: number, month: number): string {
  return `${monthName(MONTHS_SHORT, month)} ${year}`;
}

/** septiembre de 2026 */
export function formatMonthLong(year: number, month: number): string {
  return `${monthName(MONTHS_LONG, month)} de ${year}`;
}

/** SEPTIEMBRE 2026 — executive summary headings. */
export function formatMonthUpper(year: number, month: number): string {
  return `${monthName(MONTHS_LONG, month).toUpperCase()} ${year}`;
}

/** 24/09/2026 10:05 a. m. — for audit rows, which are real instants. */
export function formatInstant(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("es-CO", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(instant);
}

/** 10:05 a. m. */
export function formatTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("es-CO", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(instant);
}

/**
 * Human phrasing of how a due date relates to today.
 *
 * Point 56 requires that colour is never the only signal, so every status in the
 * UI is accompanied by text produced here.
 */
export interface DueDistance {
  /** Negative when overdue, 0 today, positive when still upcoming. */
  days: number;
  label: string;
  tone: "overdue" | "today" | "soon" | "future";
}

export function describeDueDistance(
  dueOn: CalendarDate,
  today: CalendarDate,
  options: { dueSoonLeadDays?: number } = {},
): DueDistance {
  const { dueSoonLeadDays = 3 } = options;
  const days = differenceInDays(today, dueOn);

  if (days < 0) {
    const late = Math.abs(days);
    return {
      days,
      label: late === 1 ? "1 día vencido" : `${late} días vencidos`,
      tone: "overdue",
    };
  }
  if (days === 0) {
    return { days, label: "Vence hoy", tone: "today" };
  }
  if (days === 1) {
    return { days, label: "Vence mañana", tone: "soon" };
  }
  if (days <= dueSoonLeadDays) {
    return { days, label: `Vence en ${days} días`, tone: "soon" };
  }
  return { days, label: `Vence en ${days} días`, tone: "future" };
}
