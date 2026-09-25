import { Money, type MoneyInput } from "@/core/money/money";
import type { CalendarDate } from "@/core/time/calendar-date";
import { advanceByPeriod, type PeriodRule } from "@/core/time/period";

export class RenewalError extends Error {}

/**
 * Which date the renewed period is measured from.
 *
 * These produce genuinely different due dates and therefore different amounts of
 * interest over time, so the engine does NOT pick one. The caller must state it,
 * and the organization stores its own default.
 *
 * - PREVIOUS_DUE_DATE: the contract keeps its original rhythm. A monthly loan due
 *   the 24th stays due the 24th even if the client paid on the 27th.
 * - EFFECTIVE_DATE: the clock restarts the day the client actually paid, so the
 *   next due date is one full period after the payment.
 */
export type RenewalDueBasis = "PREVIOUS_DUE_DATE" | "EFFECTIVE_DATE";

/** How the capital changes as part of the renewal. */
export type CapitalChange =
  /** Point 13: the client pays interest and carries the same capital forward. */
  | { kind: "UNCHANGED" }
  /** Point 14: the client takes additional cash on top of the existing capital. */
  | { kind: "INCREASE"; additionalDisbursed: MoneyInput }
  /** The client returns part of the capital while renewing the rest. */
  | { kind: "DECREASE"; principalCollected: MoneyInput };

/** The period being closed by this renewal. */
export interface ClosingPeriod {
  periodId: string;
  dueOn: CalendarDate;
  /** Interest still owed on this period before the renewal payment. */
  interestOutstanding: MoneyInput;
}

export interface RenewalInput {
  loan: {
    currentPrincipalBase: MoneyInput;
    outstandingPrincipal: MoneyInput;
    renewalCount: number;
    schedule: PeriodRule;
  };
  /**
   * Periods this renewal closes. Usually one, but a client catching up on three
   * missed periods closes all three in a single renewal.
   */
  closingPeriods: readonly ClosingPeriod[];
  /** Interest actually received. */
  interestPaid: MoneyInput;
  capitalChange: CapitalChange;
  /** Business date the renewal is recorded on. */
  effectiveOn: CalendarDate;
  dueBasis: RenewalDueBasis;
  /**
   * Permits renewing while interest remains unpaid. Off by default: a renewal
   * that silently forgives or defers interest is how a portfolio stops
   * reconciling. When enabled, the shortfall is reported as carried, not erased.
   */
  allowPartialInterest?: boolean;
}

export interface RenewalPlan {
  sequence: number;

  /** Interest collected and attributed to the closed periods. */
  interestCollected: Money;
  /** Interest that remains owed, when a partial renewal was explicitly allowed. */
  interestCarried: Money;
  /** Per-period breakdown, so every peso lands on a specific period. */
  interestAllocations: readonly { periodId: string; amount: Money }[];

  previousPrincipalBase: Money;
  newPrincipalBase: Money;
  previousOutstandingPrincipal: Money;
  newOutstandingPrincipal: Money;

  /** Extra cash handed to the client. Leaves the till. */
  additionalDisbursed: Money;
  /** Capital returned by the client. Enters the till. */
  principalCollected: Money;

  /** Total entering the till: interest + capital returned. */
  cashIn: Money;
  /** Total leaving the till: additional capital disbursed. */
  cashOut: Money;
  /** cashIn - cashOut. Negative when the renewal costs the business money. */
  netCash: Money;

  newDueOn: CalendarDate;
  closedPeriodIds: readonly string[];
}

/**
 * Plans a renewal.
 *
 * A renewal never replaces or deletes the loan (point 13). It closes the periods
 * that were settled, records the capital movement, and opens the next period. The
 * Renewal row is the historical link, and the loan keeps its identity, its code
 * and its entire payment history.
 *
 * The capital base and the outstanding principal are tracked separately because
 * they answer different questions: the base is what a
 * SIMPLE_ON_ORIGINAL_PRINCIPAL loan charges interest on, while the outstanding
 * principal is what the client actually owes. A renewal that adds $500.000 moves
 * both; a renewal that collects $400.000 of capital moves both down.
 */
export function planRenewal(input: RenewalInput): RenewalPlan {
  if (input.closingPeriods.length === 0) {
    throw new RenewalError("A renewal must close at least one period.");
  }
  if (!Number.isInteger(input.loan.renewalCount) || input.loan.renewalCount < 0) {
    throw new RenewalError("renewalCount must be a non-negative whole number.");
  }

  const interestPaid = Money.of(input.interestPaid);
  if (interestPaid.isNegative()) {
    throw new RenewalError("The interest paid cannot be negative.");
  }

  const interestDue = Money.sum(
    input.closingPeriods.map((p) => p.interestOutstanding),
  );

  for (const period of input.closingPeriods) {
    if (Money.of(period.interestOutstanding).isNegative()) {
      throw new RenewalError(
        `Period ${period.periodId} reports negative outstanding interest.`,
      );
    }
  }

  if (interestPaid.greaterThan(interestDue)) {
    throw new RenewalError(
      `The renewal receives ${interestPaid.toString()} of interest but only ` +
        `${interestDue.toString()} is owed on the periods being closed.`,
    );
  }

  if (interestPaid.lessThan(interestDue) && !input.allowPartialInterest) {
    throw new RenewalError(
      `Renewing requires the interest to be settled: ${interestDue.toString()} ` +
        `is owed and ${interestPaid.toString()} was received. Enable a partial ` +
        "renewal explicitly if the remainder should be carried forward.",
    );
  }

  // Spread the received interest across the closing periods, oldest first.
  const interestAllocations: { periodId: string; amount: Money }[] = [];
  let remaining = interestPaid;
  for (const period of input.closingPeriods) {
    const owed = Money.of(period.interestOutstanding);
    const applied = Money.min(owed, remaining);
    if (applied.isPositive()) {
      interestAllocations.push({ periodId: period.periodId, amount: applied });
      remaining = remaining.minus(applied);
    }
    if (remaining.isZero()) break;
  }

  const previousBase = Money.of(input.loan.currentPrincipalBase);
  const previousOutstanding = Money.of(input.loan.outstandingPrincipal);

  if (previousBase.isNegative() || previousOutstanding.isNegative()) {
    throw new RenewalError("The loan principal is negative; its state is corrupt.");
  }

  let additionalDisbursed = Money.zero();
  let principalCollected = Money.zero();

  switch (input.capitalChange.kind) {
    case "UNCHANGED":
      break;

    case "INCREASE": {
      additionalDisbursed = Money.of(input.capitalChange.additionalDisbursed);
      if (!additionalDisbursed.isPositive()) {
        throw new RenewalError(
          "A capital increase must disburse a positive amount.",
        );
      }
      break;
    }

    case "DECREASE": {
      principalCollected = Money.of(input.capitalChange.principalCollected);
      if (!principalCollected.isPositive()) {
        throw new RenewalError(
          "A capital reduction must collect a positive amount.",
        );
      }
      if (principalCollected.greaterThan(previousOutstanding)) {
        throw new RenewalError(
          `Cannot collect ${principalCollected.toString()} of capital: only ` +
            `${previousOutstanding.toString()} is outstanding. Use the settlement ` +
            "flow to close the loan.",
        );
      }
      break;
    }
  }

  const newOutstandingPrincipal = previousOutstanding
    .plus(additionalDisbursed)
    .minus(principalCollected);

  // The interest base follows the outstanding capital by the same delta, so a
  // SIMPLE_ON_ORIGINAL_PRINCIPAL loan charges the renewed capital going forward
  // while every closed period keeps the basis it was computed with.
  const newPrincipalBase = previousBase
    .plus(additionalDisbursed)
    .minus(principalCollected);

  if (newPrincipalBase.isNegative() || newOutstandingPrincipal.isNegative()) {
    throw new RenewalError(
      "The renewal would leave a negative principal, which is not allowed.",
    );
  }

  const anchor = resolveAnchor(input);
  const newDueOn = advanceByPeriod(anchor, input.loan.schedule, 1);

  const cashIn = interestPaid.plus(principalCollected);
  const cashOut = additionalDisbursed;

  return {
    sequence: input.loan.renewalCount + 1,
    interestCollected: interestPaid,
    interestCarried: interestDue.minus(interestPaid),
    interestAllocations,
    previousPrincipalBase: previousBase,
    newPrincipalBase,
    previousOutstandingPrincipal: previousOutstanding,
    newOutstandingPrincipal,
    additionalDisbursed,
    principalCollected,
    cashIn,
    cashOut,
    netCash: cashIn.minus(cashOut),
    newDueOn,
    closedPeriodIds: input.closingPeriods.map((p) => p.periodId),
  };
}

/**
 * The date the next period is measured from.
 *
 * With PREVIOUS_DUE_DATE this is the latest due date among the closed periods,
 * which keeps a client who caught up on three missed periods from getting a free
 * extra cycle.
 */
function resolveAnchor(input: RenewalInput): CalendarDate {
  if (input.dueBasis === "EFFECTIVE_DATE") return input.effectiveOn;

  let latest = input.closingPeriods[0]!.dueOn;
  for (const period of input.closingPeriods) {
    if (period.dueOn > latest) latest = period.dueOn;
  }
  return latest;
}
