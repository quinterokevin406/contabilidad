import Decimal from "decimal.js";

import { Money, type MoneyInput } from "@/core/money/money";
import type { RoundingMode } from "@/core/money/rounding";

/** Mirrors the InterestMethod enum in the Prisma schema. */
export type InterestMethod =
  | "SIMPLE_ON_ORIGINAL_PRINCIPAL"
  | "SIMPLE_ON_OUTSTANDING_PRINCIPAL";

export class InterestError extends Error {}

/**
 * The rounding contract of one loan, frozen at creation.
 *
 * Carried explicitly through every calculation rather than read from settings,
 * so an organization changing its default cannot restate an existing loan.
 */
export interface MoneyRule {
  roundingMode: RoundingMode;
  /** Smallest representable unit: "1" for whole pesos. */
  moneyQuantum: MoneyInput;
}

/** The principal figures a loan carries at a given moment. */
export interface PrincipalState {
  /**
   * The base that SIMPLE_ON_ORIGINAL_PRINCIPAL charges interest on. Equals the
   * originally disbursed principal until a renewal changes the capital.
   */
  currentPrincipalBase: MoneyInput;
  /** Principal still owed, reduced only by principal allocations. */
  outstandingPrincipal: MoneyInput;
}

/**
 * Selects the principal an interest calculation applies to.
 *
 * This single function is the entire difference between the two methods, and
 * isolating it here is what keeps point 5 honest: the choice lives in one place
 * and is covered by its own tests.
 *
 * - SIMPLE_ON_ORIGINAL_PRINCIPAL: always the original base. Paying down capital
 *   does NOT reduce the next period's interest. Interest never compounds.
 * - SIMPLE_ON_OUTSTANDING_PRINCIPAL: the balance as it stands. Paying down
 *   capital reduces the next period's interest.
 */
export function resolveInterestBasis(
  method: InterestMethod,
  state: PrincipalState,
): Money {
  switch (method) {
    case "SIMPLE_ON_ORIGINAL_PRINCIPAL":
      return Money.of(state.currentPrincipalBase);
    case "SIMPLE_ON_OUTSTANDING_PRINCIPAL":
      return Money.of(state.outstandingPrincipal);
  }
}

export interface PeriodInterestInput {
  method: InterestMethod;
  principal: PrincipalState;
  /** Rate for ONE period, as a percentage. 20 means 20% per period. */
  ratePercent: Decimal | string;
  money: MoneyRule;
}

export interface PeriodInterestResult {
  /**
   * The principal the interest was computed on. Persisted on the LoanPeriod row
   * so the figure can always be re-derived exactly as it was.
   */
  basis: Money;
  /** The rate applied, persisted alongside the basis. */
  rateApplied: Decimal;
  /** The interest before rounding, kept for transparency and for tests. */
  rawInterest: Money;
  /** The official amount owed for the period, after the loan rounding rule. */
  interest: Money;
}

/**
 * Computes the interest owed for a single period.
 *
 * Interest is never compounded: each period is charged on a principal basis,
 * never on principal plus accumulated interest (point 4). Three unpaid monthly
 * periods on $1.000.000 at 20% owe $600.000 of interest, not $728.000.
 */
export function computePeriodInterest(
  input: PeriodInterestInput,
): PeriodInterestResult {
  const rate = new Decimal(input.ratePercent.toString());

  if (rate.isNegative()) {
    throw new InterestError("A negative interest rate is not allowed.");
  }

  const basis = resolveInterestBasis(input.method, input.principal);

  if (basis.isNegative()) {
    throw new InterestError(
      "The interest basis is negative, which means the loan state is corrupt.",
    );
  }

  const rawInterest = basis.percentOf(rate);
  const interest = rawInterest.quantize(
    input.money.moneyQuantum,
    input.money.roundingMode,
  );

  return { basis, rateApplied: rate, rawInterest, interest };
}

/**
 * Total interest accrued over `periods` consecutive unpaid periods, under simple
 * interest on a fixed basis.
 *
 * Used for projections and for the loan creation preview. The authoritative
 * figures always come from the materialized LoanPeriod rows, never from this
 * helper, because a real loan may have had its basis or rate change partway
 * through via a renewal.
 */
export function projectSimpleInterest(
  input: PeriodInterestInput,
  periods: number,
): Money {
  if (!Number.isInteger(periods) || periods < 0) {
    throw new InterestError(
      "projectSimpleInterest requires a non-negative whole period count.",
    );
  }
  const { interest } = computePeriodInterest(input);
  return interest.times(periods);
}

/**
 * Advisory check for point 60.
 *
 * Reports whether a configured rate exceeds an administrator-defined review
 * threshold. It is a flag for a human, nothing more: the system never alters a
 * rate, a balance or a contract on the basis of this result, and it makes no
 * legal determination.
 */
export interface RateReviewResult {
  exceedsThreshold: boolean;
  ratePercent: Decimal;
  thresholdPercent: Decimal | null;
  /** Administrator-authored note, shown verbatim when the threshold is passed. */
  note: string | null;
}

export function reviewRate(
  ratePercent: Decimal | string,
  thresholdPercent: Decimal | string | null | undefined,
  note?: string | null,
): RateReviewResult {
  const rate = new Decimal(ratePercent.toString());
  if (thresholdPercent === null || thresholdPercent === undefined) {
    return {
      exceedsThreshold: false,
      ratePercent: rate,
      thresholdPercent: null,
      note: null,
    };
  }
  const threshold = new Decimal(thresholdPercent.toString());
  return {
    exceedsThreshold: rate.greaterThan(threshold),
    ratePercent: rate,
    thresholdPercent: threshold,
    note: rate.greaterThan(threshold) ? (note ?? null) : null,
  };
}
