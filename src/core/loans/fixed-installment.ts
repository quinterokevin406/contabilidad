import {
  dueDateFor,
  startDateFor,
  type ScheduleAnchor,
} from "@/core/loans/accrual";
import { Money, type MoneyInput } from "@/core/money/money";
import type { RoundingMode } from "@/core/money/rounding";
import type { CalendarDate } from "@/core/time/calendar-date";

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
  /** The clean figure the rate produces, before the instalment is rounded. */
  nominalInterest: Money;
  /** What is actually earned once the instalment is rounded up. */
  totalInterest: Money;
  /** principal + totalInterest, and also installment × periods. */
  totalRepaid: Money;
  /** The round figure quoted and paid EVERY period, the last one included. */
  installment: Money;
  /**
   * What rounding the instalment up added to the earnings.
   *
   * 1.960.000 ÷ 6 is 326.666,67, and a lender quotes 326.700. Six of those
   * collect 200 pesos more than the rate alone produced. That is not hidden:
   * the agreed total is what the six instalments add up to, and this is the
   * difference, shown so nobody has to work it out.
   */
  roundingGain: Money;
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
  const nominalInterest = interestPerPeriod.times(terms.periods);

  // The quoted instalment, rounded UP: a lender says "326.700", never
  // "326.666,67", and never a figure below what the rate produced. Rounding up
  // is what makes every instalment identical — there is no odd last one to
  // explain to a client holding a payment card.
  const exact = principal.plus(nominalInterest).dividedBy(terms.periods);

  // A rounding step bigger than the instalment itself stops being rounding and
  // becomes the price: at a quantum of 1.000.000, a 326.667 instalment would
  // jump to a million and the client would repay six times what they owe.
  // Rounding may add at most one step per instalment, never reshape the loan.
  if (Money.of(terms.installmentQuantum).greaterThan(exact)) {
    throw new FixedInstallmentError(
      "El redondeo es más grande que la cuota misma y cambiaría el préstamo " +
        "entero. Elegí uno más fino.",
    );
  }

  const installment = exact.quantize(terms.installmentQuantum, "UP");

  // The agreed total is what the instalments add up to, not the other way
  // round. That is how the deal is actually struck: six of these.
  const totalRepaid = installment.times(terms.periods);
  const totalInterest = totalRepaid.minus(principal);
  const roundingGain = totalInterest.minus(nominalInterest);

  // Capital is what has to come back exactly: the lender handed over a
  // million and a million is what returns. So the capital column is split
  // first, the remainder landing in the last instalment, and interest is
  // whatever each payment has left over. Doing it the other way round would
  // recover more or less principal than was lent, and the portfolio would be
  // wrong from the first day.
  const capitalPerPeriod = principal
    .dividedBy(terms.periods)
    .quantize(terms.installmentQuantum, "DOWN");

  const schedule: Installment[] = [];
  let principalPaid = Money.zero();

  for (let i = 1; i <= terms.periods; i += 1) {
    const last = i === terms.periods;
    const capital = last ? principal.minus(principalPaid) : capitalPerPeriod;
    const interest = installment.minus(capital);

    principalPaid = principalPaid.plus(capital);

    schedule.push({
      number: i,
      amount: installment,
      interest,
      principal: capital,
      principalRemaining: principal.minus(principalPaid),
    });
  }

  return {
    principal,
    nominalInterest,
    totalInterest,
    totalRepaid,
    installment,
    roundingGain,
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

/** One instalment with the dates it actually falls between. */
export interface ScheduledInstallment extends Installment {
  /** 1-based period index, matching LoanPeriod.periodIndex. */
  periodIndex: number;
  startsOn: CalendarDate;
  dueOn: CalendarDate;
}

/**
 * Puts dates on a plan, so it can be written to the database and handed to a
 * client on paper.
 *
 * The dates come from the same schedule engine every other loan uses, which is
 * what keeps a fixed-instalment loan due on the 24th like all the others — the
 * February clamp included.
 */
export function scheduleFixedInstallments(
  plan: FixedInstallmentPlan,
  anchor: ScheduleAnchor,
): ScheduledInstallment[] {
  return plan.schedule.map((installment) => {
    const periodIndex = anchor.anchorIndex + installment.number;
    return {
      ...installment,
      periodIndex,
      startsOn: startDateFor(anchor, periodIndex),
      dueOn: dueDateFor(anchor, periodIndex),
    };
  });
}
