import type Decimal from "decimal.js";

import { Money } from "@/core/money/money";
import {
  advanceByPeriod,
  type PeriodRule,
} from "@/core/time/period";
import {
  isSameOrAfter,
  type CalendarDate,
} from "@/core/time/calendar-date";

import {
  computePeriodInterest,
  type InterestMethod,
  type MoneyRule,
  type PrincipalState,
} from "./interest";

export class AccrualError extends Error {}

/**
 * Everything the accrual engine needs to know about a loan.
 *
 * All of it lives on the loan row, frozen at creation. Nothing is read from
 * organization settings here, which is what makes point 3 enforceable.
 */
export interface AccrualLoan {
  /**
   * Where the schedule is measured from: the period at `anchorIndex + 1` falls
   * due on this date.
   *
   * On a new loan this is simply the first due date with `anchorIndex` 0. A
   * renewal that restarts the clock moves the anchor forward without disturbing
   * the period numbering, which must stay unique and monotonic for the life of
   * the loan.
   */
  anchorDueOn: CalendarDate;
  /** Period index immediately BEFORE `anchorDueOn`. 0 on a brand-new loan. */
  anchorIndex: number;
  /** Highest period index already materialized. 0 on a brand-new loan. */
  lastPeriodIndex: number;
  schedule: PeriodRule;
  interestMethod: InterestMethod;
  ratePercent: Decimal | string;
  money: MoneyRule;
  principal: PrincipalState;
}

/** A period that has become a real obligation and must be persisted. */
export interface AccruedPeriod {
  periodIndex: number;
  startsOn: CalendarDate;
  dueOn: CalendarDate;
  /** Frozen: the principal this period's interest was computed on. */
  principalBasis: Money;
  /** Frozen: the rate applied to this period. */
  rateApplied: Decimal;
  interestAccrued: Money;
}

export interface AccrualPlan {
  /** Periods to insert, in ascending index order. Empty when nothing is due. */
  newPeriods: readonly AccruedPeriod[];
  /** Highest period index after applying the plan. */
  lastPeriodIndex: number;
  /** Due date of the next period that has NOT yet accrued. */
  nextDueOn: CalendarDate;
}

/**
 * Materializes every period that has become due on or before `asOf`.
 *
 * ## Why future periods are never persisted
 *
 * A period row freezes its `principalBasis`, which is what makes history
 * immutable. But under SIMPLE_ON_OUTSTANDING_PRINCIPAL the correct basis for a
 * period depends on how much capital had been paid down by the time it started.
 * Writing a row for a period that has not happened yet would freeze a basis that
 * a later principal payment invalidates -- and the loan would then charge
 * interest on capital the client had already returned.
 *
 * So a period becomes a row exactly when `asOf >= dueOn`, and never before.
 * Anything further out is a projection, recomputed on demand (see
 * `projectPeriod`). Today's collections still work, because a period due today
 * satisfies `asOf >= dueOn` today.
 *
 * ## Required call order
 *
 * Accrual MUST run before any payment is posted. Catching up several periods at
 * once uses the loan's current principal state for each of them, which is only
 * correct if no payment slipped in between. The payment service therefore accrues
 * first, inside the same transaction, and the invariant is asserted there.
 */
export function planAccrual(loan: AccrualLoan, asOf: CalendarDate): AccrualPlan {
  if (!Number.isInteger(loan.lastPeriodIndex) || loan.lastPeriodIndex < 0) {
    throw new AccrualError(
      "lastPeriodIndex must be a non-negative whole number.",
    );
  }

  const newPeriods: AccruedPeriod[] = [];
  let index = loan.lastPeriodIndex;

  // Walk forward one period at a time. The loop is bounded by the due dates
  // themselves: it stops as soon as the next one lies in the future.
  for (;;) {
    const nextIndex = index + 1;
    const dueOn = dueDateFor(loan, nextIndex);

    if (!isSameOrAfter(asOf, dueOn)) break;

    const { basis, rateApplied, interest } = computePeriodInterest({
      method: loan.interestMethod,
      principal: loan.principal,
      ratePercent: loan.ratePercent,
      money: loan.money,
    });

    newPeriods.push({
      periodIndex: nextIndex,
      startsOn: startDateFor(loan, nextIndex),
      dueOn,
      principalBasis: basis,
      rateApplied,
      interestAccrued: interest,
    });

    index = nextIndex;
  }

  return {
    newPeriods,
    lastPeriodIndex: index,
    nextDueOn: dueDateFor(loan, index + 1),
  };
}

/** The schedule fields the date helpers need. */
export type ScheduleAnchor = Pick<
  AccrualLoan,
  "anchorDueOn" | "anchorIndex" | "schedule"
>;

/**
 * Due date of period `periodIndex` (1-based).
 *
 * Derived from the anchor rather than from the previous period's date, so a
 * February clamped to the 28th does not drag every later date backwards.
 */
export function dueDateFor(
  loan: ScheduleAnchor,
  periodIndex: number,
): CalendarDate {
  if (!Number.isInteger(periodIndex) || periodIndex < 1) {
    throw new AccrualError("periodIndex is 1-based and must be a whole number.");
  }
  if (periodIndex <= loan.anchorIndex) {
    throw new AccrualError(
      `Period ${periodIndex} precedes the current schedule anchor ` +
        `(${loan.anchorIndex}); its due date is stored on the period row and ` +
        "cannot be recomputed.",
    );
  }
  return advanceByPeriod(
    loan.anchorDueOn,
    loan.schedule,
    periodIndex - loan.anchorIndex - 1,
  );
}

/** Start date of period `periodIndex`: the previous period's due date. */
export function startDateFor(
  loan: ScheduleAnchor,
  periodIndex: number,
): CalendarDate {
  if (periodIndex === loan.anchorIndex + 1) {
    // The first period after the anchor runs from one period before its own due
    // date, which for a new loan is the disbursement day.
    return advanceByPeriod(loan.anchorDueOn, loan.schedule, -1);
  }
  return dueDateFor(loan, periodIndex - 1);
}

/**
 * Projects a period that has not accrued yet.
 *
 * Used by the loan creation preview (point 9), by "what do I collect tomorrow"
 * and by the upcoming-period card on the loan page. Explicitly a projection: it
 * reflects the principal state as it stands right now, and it is never written to
 * the database.
 */
export interface PeriodProjection {
  periodIndex: number;
  startsOn: CalendarDate;
  dueOn: CalendarDate;
  basis: Money;
  interest: Money;
  /** basis + interest, for the "total at first due date" line of the preview. */
  totalAtDueDate: Money;
  isProjection: true;
}

export function projectPeriod(
  loan: AccrualLoan,
  periodIndex: number,
): PeriodProjection {
  const { basis, interest } = computePeriodInterest({
    method: loan.interestMethod,
    principal: loan.principal,
    ratePercent: loan.ratePercent,
    money: loan.money,
  });

  return {
    periodIndex,
    startsOn: startDateFor(loan, periodIndex),
    dueOn: dueDateFor(loan, periodIndex),
    basis,
    interest,
    totalAtDueDate: Money.of(loan.principal.outstandingPrincipal).plus(interest),
    isProjection: true,
  };
}

/**
 * Total interest that would accrue from `asOf` through `horizon`, without
 * persisting anything.
 *
 * Feeds the collections calendar and the "this week" figures. Assumes no payments
 * in between, which is exactly what a forecast means.
 */
export function projectInterestThrough(
  loan: AccrualLoan,
  asOf: CalendarDate,
  horizon: CalendarDate,
): { periods: readonly PeriodProjection[]; total: Money } {
  if (horizon < asOf) {
    throw new AccrualError("The horizon cannot precede the as-of date.");
  }

  const periods: PeriodProjection[] = [];
  let index = loan.lastPeriodIndex;

  for (;;) {
    const nextIndex = index + 1;
    const dueOn = dueDateFor(loan, nextIndex);
    if (dueOn > horizon) break;
    periods.push(projectPeriod(loan, nextIndex));
    index = nextIndex;
  }

  return {
    periods,
    total: Money.sum(periods.map((p) => p.interest)),
  };
}
