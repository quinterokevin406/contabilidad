import { Money, type MoneyInput } from "@/core/money/money";
import type { RoundingMode } from "@/core/money/rounding";

/**
 * Level-payment loans with interest computed up front (points 4 and 9).
 *
 * The arrangement most informal lenders in Colombia actually use, and the one
 * they do on paper: a million at 16%, six months, interest worked out for the
 * whole term and added to the principal, the total split into six equal
 * instalments that cover capital and interest together.
 *
 *     1.000.000 × 16%        =   160.000 per period
 *     160.000 × 6            =   960.000 of interest
 *     1.000.000 + 960.000    = 1.960.000 to be repaid
 *     1.960.000 ÷ 6          =   326.667 per instalment
 *
 * This is NOT the same arithmetic as a bank's amortised loan. Here the rate
 * applies to the ORIGINAL principal for every period, so paying capital early
 * does not reduce the interest — it was fixed the day the loan was written.
 * Calling it an annual rate would be wrong by a wide margin, and this module
 * never does: the rate it is given is the rate per period, full stop.
 *
 * No I/O, no database, no clock. Every instalment this system will ever charge
 * comes out of here, so it can be read and tested on its own.
 */

export interface FixedInstallmentTerms {
  principal: MoneyInput;
  /** Rate for ONE period, as a percentage. 16 means 16% per period. */
  ratePercent: string;
  /** How many instalments the loan is repaid in. */
  periods: number;
  /**
   * What the instalment is rounded to, so it is a figure a person can say out
   * loud: "1" for whole pesos, "100" to the hundred, "1000" to the thousand.
   */
  installmentQuantum: MoneyInput;
  roundingMode: RoundingMode;
}

export interface Installment {
  /** 1-based, the way a client counts them. */
  number: number;
  /** What the client hands over. */
  amount: Money;
  /** The part of it that is the lender's earnings. */
  interest: Money;
  /** The part of it that returns the lender's own money. */
  principal: Money;
  /** Capital still owed once this instalment is paid. */
  principalRemaining: Money;
}

export interface FixedInstallmentPlan {
  /** What the lender hands over on day one. */
  principal: Money;
  /** Earnings over the whole term, known before the first payment. */
  totalInterest: Money;
  /** principal + totalInterest. */
  totalRepaid: Money;
  /** The round figure that is quoted and paid every period but the last. */
  installment: Money;
  /**
   * The last one, which absorbs whatever rounding left over.
   *
   * Rounding 1.960.000 ÷ 6 up to the hundred gives 326.700, and six of those
   * collect 200 pesos more than was agreed. Rather than quietly overcharge, the
   * difference lands here and the totals come out exact.
   */
  lastInstallment: Money;
  schedule: Installment[];
}

export class FixedInstallmentError extends Error {}

export function planFixedInstallments(
  terms: FixedInstallmentTerms,
): FixedInstallmentPlan {
  const principal = Money.of(terms.principal);

  if (!principal.isPositive()) {
    throw new FixedInstallmentError("El monto del préstamo tiene que ser mayor a cero.");
  }
  if (!Number.isInteger(terms.periods) || terms.periods < 1) {
    throw new FixedInstallmentError("El plazo tiene que ser al menos una cuota.");
  }
  if (terms.periods > 120) {
    throw new FixedInstallmentError("El plazo no puede pasar de 120 cuotas.");
  }

  const rate = Number(terms.ratePercent);
  if (!Number.isFinite(rate) || rate < 0) {
    throw new FixedInstallmentError("La tasa no es válida.");
  }

  // Interest on the ORIGINAL principal, for every period of the term. This one
  // line is the whole difference from an amortised loan.
  const interestPerPeriod = principal.percentOf(terms.ratePercent);
  const totalInterest = interestPerPeriod.times(terms.periods);
  const totalRepaid = principal.plus(totalInterest);

  // The quoted instalment: a figure that can be said out loud and written on a
  // card. Rounded DOWN so the rounding never collects more than was agreed —
  // what is left over is settled in the last one.
  const installment = totalRepaid
    .dividedBy(terms.periods)
    .quantize(terms.installmentQuantum, "DOWN");

  if (!installment.isPositive()) {
    throw new FixedInstallmentError(
      "La cuota redondeada da cero. Usá un redondeo más fino.",
    );
  }

  const lastInstallment = totalRepaid.minus(installment.times(terms.periods - 1));

  // Each instalment carries the same interest, because the interest never
  // depended on the outstanding balance. The capital inside it is whatever is
  // left of the payment.
  const schedule: Installment[] = [];
  let principalPaid = Money.zero();
  let interestPaid = Money.zero();

  for (let i = 1; i <= terms.periods; i += 1) {
    const last = i === terms.periods;
    const amount = last ? lastInstallment : installment;

    // The final period absorbs the rounding on both halves, so the columns add
    // up to the agreed totals exactly rather than to within a few pesos.
    const interest = last
      ? totalInterest.minus(interestPaid)
      : interestPerPeriod.quantize(terms.installmentQuantum, "DOWN");

    const capital = last ? principal.minus(principalPaid) : amount.minus(interest);

    interestPaid = interestPaid.plus(interest);
    principalPaid = principalPaid.plus(capital);

    schedule.push({
      number: i,
      amount,
      interest,
      principal: capital,
      principalRemaining: principal.minus(principalPaid),
    });
  }

  return {
    principal,
    totalInterest,
    totalRepaid,
    installment,
    lastInstallment,
    schedule,
  };
}

/**
 * What is still owed on a fixed-instalment loan, by the terms as written.
 *
 * The full agreed amount minus what has come in. It is deliberately NOT the
 * same as asking what a client would pay to cancel early — that is a separate
 * decision about forgiving unearned interest, and it belongs to settlement.
 */
export function outstandingByContract(
  plan: FixedInstallmentPlan,
  paidSoFar: MoneyInput,
): Money {
  const paid = Money.of(paidSoFar);
  const remaining = plan.totalRepaid.minus(paid);
  return remaining.isPositive() ? remaining : Money.zero();
}
