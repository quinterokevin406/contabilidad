import {
  addDays,
  addMonths,
  differenceInDays,
  type CalendarDate,
} from "./calendar-date";

/** Mirrors the Periodicity enum in the Prisma schema. */
export type Periodicity = "DAILY" | "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "CUSTOM";

/** Mirrors the PeriodAnchor enum in the Prisma schema. */
export type PeriodAnchor = "CALENDAR" | "FIXED_DAYS";

export class PeriodError extends Error {}

/**
 * The schedule rules of one loan, frozen at creation.
 *
 * Every field here is stored on the loan row rather than read from settings, so
 * an organization changing its defaults tomorrow cannot move an existing loan's
 * due dates.
 */
export interface PeriodRule {
  periodicity: Periodicity;
  anchor: PeriodAnchor;
  /** Required when periodicity is CUSTOM. */
  customPeriodDays?: number | null;
}

/**
 * Fixed day counts per periodicity.
 *
 * DAILY, WEEKLY and BIWEEKLY are day-count periods by definition, so the anchor
 * does not affect them. "Quincenal" is read as every 15 days, which is the
 * standard meaning in Colombian lending; a business that means "the 1st and the
 * 15th" should model that as CUSTOM.
 */
const FIXED_DAYS: Partial<Record<Periodicity, number>> = {
  DAILY: 1,
  WEEKLY: 7,
  BIWEEKLY: 15,
  // Only used when a monthly loan is explicitly anchored to FIXED_DAYS.
  MONTHLY: 30,
};

export function resolvePeriodDays(rule: PeriodRule): number {
  if (rule.periodicity === "CUSTOM") {
    const days = rule.customPeriodDays;
    if (!days || !Number.isInteger(days) || days <= 0) {
      throw new PeriodError(
        "A CUSTOM periodicity requires a positive whole customPeriodDays.",
      );
    }
    return days;
  }
  const days = FIXED_DAYS[rule.periodicity];
  if (days === undefined) {
    throw new PeriodError(`Unsupported periodicity: ${rule.periodicity}`);
  }
  return days;
}

/**
 * Advances a date by `count` periods.
 *
 * A MONTHLY loan anchored to CALENDAR walks calendar months, so 24/09 becomes
 * 24/10 and 31/01 becomes 28/02 (clamped, never spilling into March). Every
 * other combination walks a fixed number of days.
 */
export function advanceByPeriod(
  date: CalendarDate,
  rule: PeriodRule,
  count = 1,
): CalendarDate {
  if (!Number.isInteger(count)) {
    throw new PeriodError("advanceByPeriod requires a whole period count.");
  }
  if (rule.periodicity === "MONTHLY" && rule.anchor === "CALENDAR") {
    return addMonths(date, count);
  }
  return addDays(date, resolvePeriodDays(rule) * count);
}

/**
 * Builds the due dates for `count` consecutive periods starting at `firstDueOn`.
 *
 * Each date is derived from the ORIGINAL anchor rather than from its predecessor,
 * so a clamped month (28/02) does not drag the whole schedule backwards: after
 * 31/01 -> 28/02, the next date returns to 31/03.
 */
export function buildDueDates(
  firstDueOn: CalendarDate,
  rule: PeriodRule,
  count: number,
): CalendarDate[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new PeriodError("buildDueDates requires a non-negative whole count.");
  }
  const dates: CalendarDate[] = [];
  for (let i = 0; i < count; i += 1) {
    dates.push(advanceByPeriod(firstDueOn, rule, i));
  }
  return dates;
}

/**
 * How many whole periods have elapsed between two dates.
 *
 * Used by the accrual job to decide how many periods a loan owes when nobody has
 * touched it for a while. Never used to invent interest: the accrual service
 * materializes one LoanPeriod row per elapsed period, each with its own frozen
 * principal basis and rate.
 */
export function elapsedPeriods(
  from: CalendarDate,
  to: CalendarDate,
  rule: PeriodRule,
): number {
  if (to <= from) return 0;

  if (rule.periodicity === "MONTHLY" && rule.anchor === "CALENDAR") {
    let count = 0;
    // Walking is correct here rather than dividing by an average month length,
    // which would drift across February.
    while (advanceByPeriod(from, rule, count + 1) <= to) count += 1;
    return count;
  }

  return Math.floor(differenceInDays(from, to) / resolvePeriodDays(rule));
}

const PERIOD_NOUN: Record<Periodicity, string> = {
  DAILY: "Diario",
  WEEKLY: "Semanal",
  BIWEEKLY: "Quincenal",
  MONTHLY: "Mensual",
  CUSTOM: "Personalizado",
};

export function periodicityLabel(rule: PeriodRule): string {
  if (rule.periodicity === "CUSTOM") {
    return `Cada ${resolvePeriodDays(rule)} días`;
  }
  return PERIOD_NOUN[rule.periodicity];
}
