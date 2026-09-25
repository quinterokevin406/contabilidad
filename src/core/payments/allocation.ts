import { Money, type MoneyInput } from "@/core/money/money";
import type { CalendarDate } from "@/core/time/calendar-date";

/** Mirrors the AllocationStrategy enum in the Prisma schema. */
export type AllocationStrategy =
  | "INTEREST_FIRST"
  | "PRINCIPAL_FIRST"
  | "MANUAL_ONLY";

export class AllocationError extends Error {}

/** One period's unpaid interest, as it stands right now. */
export interface PeriodDebt {
  periodId: string;
  dueOn: CalendarDate;
  /** interestAccrued - interestPaid - interestWaived. Never negative. */
  interestOutstanding: MoneyInput;
}

/** Everything a loan currently owes. */
export interface DebtSnapshot {
  /**
   * Accrued periods with interest still owed. MUST be ordered oldest first:
   * a payment settles the oldest debt before the newest, which is what both the
   * client and the aging report expect.
   */
  periods: readonly PeriodDebt[];
  principalOutstanding: MoneyInput;
}

/** Operator-authored distribution for the manual flow (point 11). */
export interface ManualDistribution {
  interest?: readonly { periodId: string; amount: MoneyInput }[];
  principal?: MoneyInput;
  fees?: readonly { concept: string; amount: MoneyInput }[];
}

export interface InterestAllocation {
  periodId: string;
  amount: Money;
}

export interface FeeAllocation {
  concept: string;
  amount: Money;
}

/** What happened to one period as a result of the payment. */
export interface PeriodOutcome {
  periodId: string;
  interestBefore: Money;
  interestApplied: Money;
  interestAfter: Money;
  /**
   * True only when the period reached exactly zero. A partial payment leaves this
   * false so the period stays PARTIALLY_PAID (point 12).
   */
  fullySettled: boolean;
}

export interface AllocationPlan {
  /** Cash received. Always equals interestTotal + principalTotal + feeTotal + unapplied. */
  total: Money;
  interestAllocations: readonly InterestAllocation[];
  feeAllocations: readonly FeeAllocation[];
  interestTotal: Money;
  principalTotal: Money;
  feeTotal: Money;
  /**
   * Received money that exceeded the whole debt. The service layer decides what
   * to do with it -- refuse the payment, or record it under an explicit
   * settlement flow -- but it is never silently absorbed into a balance.
   */
  unapplied: Money;
  /** Principal balance after the payment is posted. */
  resultingPrincipal: Money;
  periodOutcomes: readonly PeriodOutcome[];
  strategyApplied: AllocationStrategy;
}

export interface AllocateOptions {
  amount: MoneyInput;
  debt: DebtSnapshot;
  strategy: AllocationStrategy;
  /** Required when strategy is MANUAL_ONLY. */
  manual?: ManualDistribution;
  /**
   * Allows principal to be reduced below zero-debt only through the explicit
   * settlement flow (point 51). Off by default.
   */
  allowPrincipalOverpayment?: boolean;
}

/**
 * Splits a received amount across interest, principal and fees.
 *
 * This is the single source of truth for how a peso is applied. Nothing else in
 * the system decides allocation, which is what makes the rule testable and keeps
 * the ledger reconcilable: `payment.amount` must always equal the sum of its
 * allocation rows plus whatever was reported as unapplied.
 */
export function allocatePayment(options: AllocateOptions): AllocationPlan {
  const total = Money.of(options.amount);

  if (!total.isPositive()) {
    throw new AllocationError("A payment must be a positive amount.");
  }

  const principalOutstanding = Money.of(options.debt.principalOutstanding);
  if (principalOutstanding.isNegative()) {
    throw new AllocationError(
      "The loan principal is negative, which means the loan state is corrupt.",
    );
  }

  for (const period of options.debt.periods) {
    if (Money.of(period.interestOutstanding).isNegative()) {
      throw new AllocationError(
        `Period ${period.periodId} reports negative outstanding interest.`,
      );
    }
  }

  return options.strategy === "MANUAL_ONLY"
    ? allocateManually(total, options, principalOutstanding)
    : allocateAutomatically(total, options, principalOutstanding);
}

// --- Automatic --------------------------------------------------------------

function allocateAutomatically(
  total: Money,
  options: AllocateOptions,
  principalOutstanding: Money,
): AllocationPlan {
  let remaining = total;
  const interestAllocations: InterestAllocation[] = [];
  const periodOutcomes: PeriodOutcome[] = [];
  let principalTotal = Money.zero();

  const applyInterest = () => {
    for (const period of options.debt.periods) {
      const before = Money.of(period.interestOutstanding);
      // min() is what makes a partial payment stop at the debt instead of
      // overshooting into a negative balance.
      const applied = Money.min(before, remaining);
      const after = before.minus(applied);

      periodOutcomes.push({
        periodId: period.periodId,
        interestBefore: before,
        interestApplied: applied,
        interestAfter: after,
        fullySettled: after.isZero() && !before.isZero(),
      });

      if (applied.isPositive()) {
        interestAllocations.push({ periodId: period.periodId, amount: applied });
        remaining = remaining.minus(applied);
      }
      if (remaining.isZero()) break;
    }
  };

  const applyPrincipal = () => {
    const applied = Money.min(principalOutstanding, remaining);
    if (applied.isPositive()) {
      principalTotal = applied;
      remaining = remaining.minus(applied);
    }
  };

  if (options.strategy === "INTEREST_FIRST") {
    applyInterest();
    applyPrincipal();
  } else {
    applyPrincipal();
    applyInterest();
  }

  // Periods the payment never reached still belong in the outcome list, so the
  // caller sees the complete post-payment picture rather than a partial one.
  for (const period of options.debt.periods) {
    if (!periodOutcomes.some((o) => o.periodId === period.periodId)) {
      const before = Money.of(period.interestOutstanding);
      periodOutcomes.push({
        periodId: period.periodId,
        interestBefore: before,
        interestApplied: Money.zero(),
        interestAfter: before,
        fullySettled: false,
      });
    }
  }

  const interestTotal = Money.sum(interestAllocations.map((a) => a.amount));

  return assertBalanced({
    total,
    interestAllocations,
    feeAllocations: [],
    interestTotal,
    principalTotal,
    feeTotal: Money.zero(),
    unapplied: remaining,
    resultingPrincipal: principalOutstanding.minus(principalTotal),
    periodOutcomes,
    strategyApplied: options.strategy,
  });
}

// --- Manual -----------------------------------------------------------------

function allocateManually(
  total: Money,
  options: AllocateOptions,
  principalOutstanding: Money,
): AllocationPlan {
  const manual = options.manual;
  if (!manual) {
    throw new AllocationError(
      "A MANUAL_ONLY allocation requires an explicit distribution.",
    );
  }

  const byPeriod = new Map(options.debt.periods.map((p) => [p.periodId, p]));
  const seen = new Set<string>();
  const interestAllocations: InterestAllocation[] = [];

  for (const entry of manual.interest ?? []) {
    const amount = Money.of(entry.amount);
    if (amount.isNegative()) {
      throw new AllocationError("A manual interest amount cannot be negative.");
    }
    if (amount.isZero()) continue;

    if (seen.has(entry.periodId)) {
      throw new AllocationError(
        `Period ${entry.periodId} appears twice in the manual distribution.`,
      );
    }
    seen.add(entry.periodId);

    const period = byPeriod.get(entry.periodId);
    if (!period) {
      throw new AllocationError(
        `Period ${entry.periodId} is not part of this loan's outstanding debt.`,
      );
    }
    const outstanding = Money.of(period.interestOutstanding);
    if (amount.greaterThan(outstanding)) {
      throw new AllocationError(
        `Cannot apply ${amount.toString()} to period ${entry.periodId}: ` +
          `only ${outstanding.toString()} of interest is outstanding.`,
      );
    }
    interestAllocations.push({ periodId: entry.periodId, amount });
  }

  const principalTotal = Money.of(manual.principal ?? "0");
  if (principalTotal.isNegative()) {
    throw new AllocationError("A manual principal amount cannot be negative.");
  }
  if (
    principalTotal.greaterThan(principalOutstanding) &&
    !options.allowPrincipalOverpayment
  ) {
    throw new AllocationError(
      `Cannot apply ${principalTotal.toString()} to principal: only ` +
        `${principalOutstanding.toString()} is outstanding. Use the settlement ` +
        "flow to close a loan for more than its balance.",
    );
  }

  const feeAllocations: FeeAllocation[] = [];
  for (const fee of manual.fees ?? []) {
    const amount = Money.of(fee.amount);
    if (amount.isNegative()) {
      throw new AllocationError("A manual fee amount cannot be negative.");
    }
    if (amount.isZero()) continue;
    feeAllocations.push({ concept: fee.concept, amount });
  }

  const interestTotal = Money.sum(interestAllocations.map((a) => a.amount));
  const feeTotal = Money.sum(feeAllocations.map((f) => f.amount));
  const distributed = interestTotal.plus(principalTotal).plus(feeTotal);

  // Point 11: capital + intereses must equal the amount received, exactly.
  // No tolerance, no silent remainder.
  if (!distributed.equals(total)) {
    throw new AllocationError(
      `The manual distribution totals ${distributed.toString()} but the payment ` +
        `is ${total.toString()}. They must match exactly.`,
    );
  }

  const periodOutcomes: PeriodOutcome[] = options.debt.periods.map((period) => {
    const before = Money.of(period.interestOutstanding);
    const applied =
      interestAllocations.find((a) => a.periodId === period.periodId)?.amount ??
      Money.zero();
    const after = before.minus(applied);
    return {
      periodId: period.periodId,
      interestBefore: before,
      interestApplied: applied,
      interestAfter: after,
      fullySettled: after.isZero() && !before.isZero(),
    };
  });

  return assertBalanced({
    total,
    interestAllocations,
    feeAllocations,
    interestTotal,
    principalTotal,
    feeTotal,
    unapplied: Money.zero(),
    resultingPrincipal: Money.max(
      Money.zero(),
      principalOutstanding.minus(principalTotal),
    ),
    periodOutcomes,
    strategyApplied: "MANUAL_ONLY",
  });
}

// --- Invariant --------------------------------------------------------------

/**
 * Final guard: the plan must account for every peso received.
 *
 * This is cheap and it runs on every payment. If a future change to the strategy
 * logic ever loses or invents a centavo, it fails here rather than surfacing
 * three months later as a portfolio that does not reconcile.
 */
function assertBalanced(plan: AllocationPlan): AllocationPlan {
  const accounted = plan.interestTotal
    .plus(plan.principalTotal)
    .plus(plan.feeTotal)
    .plus(plan.unapplied);

  if (!accounted.equals(plan.total)) {
    throw new AllocationError(
      `Allocation does not balance: accounted ${accounted.toString()} against a ` +
        `payment of ${plan.total.toString()}. This is a bug in the allocation engine.`,
    );
  }

  const allocationSum = Money.sum(plan.interestAllocations.map((a) => a.amount));
  if (!allocationSum.equals(plan.interestTotal)) {
    throw new AllocationError(
      "Interest allocation rows do not sum to the reported interest total.",
    );
  }

  return plan;
}

/** Total debt (interest + principal) represented by a snapshot. */
export function totalDebt(debt: DebtSnapshot): Money {
  const interest = Money.sum(debt.periods.map((p) => p.interestOutstanding));
  return interest.plus(debt.principalOutstanding);
}

/** Outstanding interest across all accrued periods. */
export function outstandingInterest(debt: DebtSnapshot): Money {
  return Money.sum(debt.periods.map((p) => p.interestOutstanding));
}
