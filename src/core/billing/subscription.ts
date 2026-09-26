import type { CalendarDate } from "@/core/time/calendar-date";
import { addDays, addMonths, calendarDate } from "@/core/time/calendar-date";

/**
 * When a subscription is paid through, and when access should stop.
 *
 * Pure arithmetic on business dates: no database, no framework, no clock of its
 * own. Every decision the platform makes about cutting someone off comes from
 * here, so it can be reasoned about and tested without a server in front of it.
 */

export type RenewalBasis = "PREVIOUS_DUE_DATE" | "EFFECTIVE_DATE";

export interface SubscriptionTerms {
  /** Null when nothing has been paid yet. */
  paidThrough: CalendarDate | null;
  /** Day of month the bill falls due, 1-28. */
  billingDay: number;
  /** Days after paidThrough before access is cut. */
  graceDays: number;
  renewalBasis: RenewalBasis;
  /** First day the subscription existed; the anchor for a first payment. */
  startedAt: CalendarDate;
}

export type AccessState =
  /** Nothing owed yet. */
  | "TRIAL"
  /** Paid and inside the paid window. */
  | "CURRENT"
  /** Past the paid window, still inside the grace days. */
  | "IN_GRACE"
  /** Past the grace window. Access should stop. */
  | "OVERDUE";

export interface AccessAssessment {
  state: AccessState;
  /** Day access actually stops: paidThrough + graceDays. */
  cutoffOn: CalendarDate | null;
  /** Negative while still paid, positive once past due. */
  daysPastDue: number;
  /** The only field the enforcement job reads. */
  shouldSuspend: boolean;
}

/** Days between two business dates, b − a. */
function daysBetween(a: CalendarDate, b: CalendarDate): number {
  const toEpochDay = (d: CalendarDate) => {
    const [y, m, day] = d.split("-").map(Number);
    return Math.floor(Date.UTC(y!, m! - 1, day!) / 86_400_000);
  };
  return toEpochDay(b) - toEpochDay(a);
}

/**
 * Where a subscription stands on a given day.
 *
 * `paidThrough` is INCLUSIVE: paid through the 5th means the 5th is still
 * covered and the debt begins on the 6th. Getting that boundary wrong would cut
 * a paying customer off a day early, which is the kind of error that costs a
 * customer rather than a peso.
 */
export function assessAccess(
  terms: SubscriptionTerms,
  asOf: CalendarDate,
): AccessAssessment {
  if (terms.paidThrough === null) {
    // Never billed. The platform operator decides when a trial ends; nothing
    // here cuts anyone off on its own.
    return {
      state: "TRIAL",
      cutoffOn: null,
      daysPastDue: 0,
      shouldSuspend: false,
    };
  }

  const cutoffOn = addDays(terms.paidThrough, terms.graceDays);
  const daysPastDue = daysBetween(terms.paidThrough, asOf);

  if (daysPastDue <= 0) {
    return { state: "CURRENT", cutoffOn, daysPastDue, shouldSuspend: false };
  }

  // Still inside the grace window: owed, but not cut off.
  if (daysBetween(cutoffOn, asOf) <= 0) {
    return { state: "IN_GRACE", cutoffOn, daysPastDue, shouldSuspend: false };
  }

  return { state: "OVERDUE", cutoffOn, daysPastDue, shouldSuspend: true };
}

export interface CoverageInput {
  terms: SubscriptionTerms;
  /** Business date the money was received. */
  paidOn: CalendarDate;
  /** How many billing periods this payment buys. */
  periods: number;
}

export interface Coverage {
  /** First day this payment covers. */
  from: CalendarDate;
  /** Last day covered, inclusive. */
  through: CalendarDate;
}

/**
 * What a payment buys.
 *
 * THE RULE THAT MATTERS, and the reason it is a stored setting rather than a
 * constant: when a payment arrives late, the new period can be measured from
 * where the last one ended, or from the day the money arrived.
 *
 *   PREVIOUS_DUE_DATE — due the 5th, paid the 20th, now paid through the 5th of
 *   next month. Being late buys nothing, and the billing day never drifts.
 *
 *   EFFECTIVE_DATE — due the 5th, paid the 20th, now paid through the 20th of
 *   next month. The fifteen late days end up free, and every late payment
 *   pushes the cycle a little further out.
 *
 * The first one is the default because it is the same rule already chosen for
 * loan renewals in this system, and because the other one quietly gives away
 * revenue. Neither is invented here: it is a stored decision per subscription.
 */
export function computeCoverage(input: CoverageInput): Coverage {
  const { terms, paidOn, periods } = input;

  if (!Number.isInteger(periods) || periods < 1) {
    throw new Error("Un pago tiene que cubrir al menos un período completo.");
  }

  // A first payment starts where the subscription started, never earlier.
  if (terms.paidThrough === null) {
    const from = terms.startedAt;
    return { from, through: addDays(addMonths(from, periods), -1) };
  }

  const resumesOn = addDays(terms.paidThrough, 1);

  // Paid on time, or early: the next period always follows the last one.
  if (daysBetween(resumesOn, paidOn) <= 0) {
    return {
      from: resumesOn,
      through: addDays(addMonths(resumesOn, periods), -1),
    };
  }

  // Paid late: this is where the two rules part ways.
  const from = terms.renewalBasis === "EFFECTIVE_DATE" ? paidOn : resumesOn;
  return { from, through: addDays(addMonths(from, periods), -1) };
}

/**
 * The next bill's due date, for showing "next charge on ...".
 *
 * Purely informational — nothing charges anybody automatically.
 */
export function nextBillingDate(
  terms: SubscriptionTerms,
  asOf: CalendarDate,
): CalendarDate {
  if (terms.paidThrough === null) return terms.startedAt;
  const next = addDays(terms.paidThrough, 1);
  return daysBetween(next, asOf) > 0 ? calendarDate(asOf) : next;
}
