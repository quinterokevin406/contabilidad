import Decimal from "decimal.js";

import { Money, type MoneyInput } from "@/core/money/money";
import {
  differenceInDays,
  type CalendarDate,
} from "@/core/time/calendar-date";

import type { MoneyRule } from "./interest";

export class SettlementError extends Error {}

/**
 * How the period in progress is treated when a client settles early.
 *
 * This changes the amount owed, so the engine does NOT choose. The caller states
 * it and the organization stores its own default.
 *
 * - NOT_CHARGED: only interest that has already come due is owed. Consistent with
 *   how accrual works everywhere else in this system: interest becomes an
 *   obligation on the due date, so a period still running owes nothing yet.
 * - FULL_PERIOD: the period in progress is charged in full, as if it had matured.
 * - PRORATED: the period in progress is charged by elapsed days.
 */
export type OpenPeriodPolicy = "NOT_CHARGED" | "FULL_PERIOD" | "PRORATED";

/** An administrator-configured extra concept (point 16). */
export interface SettlementCharge {
  concept: string;
  amount: MoneyInput;
}

/** The period currently running, which has not accrued yet. */
export interface OpenPeriod {
  startsOn: CalendarDate;
  dueOn: CalendarDate;
  /** Interest this period would owe at maturity. */
  fullPeriodInterest: MoneyInput;
}

export interface SettlementQuoteInput {
  /** Capital still owed. */
  principalOutstanding: MoneyInput;
  /** Interest already accrued and still unpaid, across all matured periods. */
  accruedInterestOutstanding: MoneyInput;
  /** The period in progress. Null when the loan has no open period. */
  openPeriod: OpenPeriod | null;
  openPeriodPolicy: OpenPeriodPolicy;
  /** Date the settlement is quoted for. */
  asOf: CalendarDate;
  /** Extra configured concepts. Never invented by the engine. */
  additionalCharges?: readonly SettlementCharge[];
  money: MoneyRule;
}

export interface SettlementQuote {
  principalOutstanding: Money;
  accruedInterestOutstanding: Money;
  /** Charge for the period in progress, per the stated policy. */
  openPeriodCharge: Money;
  openPeriodPolicy: OpenPeriodPolicy;
  /** How the open-period charge was arrived at, shown verbatim to the operator. */
  openPeriodExplanation: string;
  additionalCharges: readonly { concept: string; amount: Money }[];
  additionalChargesTotal: Money;
  /** Everything the client must hand over to close the loan today. */
  total: Money;
}

/**
 * Computes what it costs to close a loan today.
 *
 * Every component is reported separately so the confirmation screen can show the
 * operator exactly what they are charging and why, rather than one opaque number
 * (point 16).
 */
export function quoteSettlement(
  input: SettlementQuoteInput,
): SettlementQuote {
  const principal = Money.of(input.principalOutstanding);
  const accruedInterest = Money.of(input.accruedInterestOutstanding);

  if (principal.isNegative() || accruedInterest.isNegative()) {
    throw new SettlementError(
      "Cannot quote a settlement on a loan with a negative balance.",
    );
  }

  const { charge: openPeriodCharge, explanation: openPeriodExplanation } =
    computeOpenPeriodCharge(input);

  const additionalCharges = (input.additionalCharges ?? []).map((c) => {
    const amount = Money.of(c.amount);
    if (amount.isNegative()) {
      throw new SettlementError("A settlement charge cannot be negative.");
    }
    return { concept: c.concept, amount };
  });

  const additionalChargesTotal = Money.sum(
    additionalCharges.map((c) => c.amount),
  );

  return {
    principalOutstanding: principal,
    accruedInterestOutstanding: accruedInterest,
    openPeriodCharge,
    openPeriodPolicy: input.openPeriodPolicy,
    openPeriodExplanation,
    additionalCharges,
    additionalChargesTotal,
    total: principal
      .plus(accruedInterest)
      .plus(openPeriodCharge)
      .plus(additionalChargesTotal),
  };
}

function computeOpenPeriodCharge(input: SettlementQuoteInput): {
  charge: Money;
  explanation: string;
} {
  if (!input.openPeriod) {
    return {
      charge: Money.zero(),
      explanation: "No hay un período en curso.",
    };
  }

  const full = Money.of(input.openPeriod.fullPeriodInterest);
  if (full.isNegative()) {
    throw new SettlementError("The open period interest cannot be negative.");
  }

  switch (input.openPeriodPolicy) {
    case "NOT_CHARGED":
      return {
        charge: Money.zero(),
        explanation:
          "El período en curso no se cobra: el interés se causa en la fecha de " +
          "vencimiento y este período aún no vence.",
      };

    case "FULL_PERIOD":
      return {
        charge: full,
        explanation:
          "El período en curso se cobra completo, como si hubiera vencido.",
      };

    case "PRORATED": {
      const totalDays = differenceInDays(
        input.openPeriod.startsOn,
        input.openPeriod.dueOn,
      );
      if (totalDays <= 0) {
        throw new SettlementError(
          "The open period has a non-positive length, so it cannot be prorated.",
        );
      }

      const elapsedRaw = differenceInDays(input.openPeriod.startsOn, input.asOf);
      // Clamp: a settlement quoted before the period started owes nothing, and
      // one quoted after the due date owes at most the full period.
      const elapsed = Math.min(Math.max(elapsedRaw, 0), totalDays);

      const charge = full
        .times(new Decimal(elapsed).dividedBy(totalDays))
        .quantize(input.money.moneyQuantum, input.money.roundingMode);

      return {
        charge,
        explanation:
          `El período en curso se cobra proporcional: ${elapsed} de ${totalDays} ` +
          "días transcurridos.",
      };
    }
  }
}

export type SettlementKind = "FULL_PAYMENT" | "WRITE_OFF";

export interface SettlementInput {
  quote: SettlementQuote;
  /** Cash actually received. */
  amountReceived: MoneyInput;
  kind: SettlementKind;
  /** Mandatory for a WRITE_OFF: why the remainder is being closed unpaid. */
  reason?: string | null;
  settledOn: CalendarDate;
}

export interface SettlementPlan {
  kind: SettlementKind;
  settledOn: CalendarDate;

  /** Applied to capital. Recovery, never profit. */
  principalCollected: Money;
  /** Applied to interest. This is the part that is revenue. */
  interestCollected: Money;
  /** Applied to configured charges. */
  chargesCollected: Money;

  /** Closed without being collected. Only non-zero for a WRITE_OFF. */
  amountWrittenOff: Money;

  /** Cash entering the till. */
  cashIn: Money;

  principalOutstandingAtSettlement: Money;
  interestOutstandingAtSettlement: Money;
  reason: string | null;
}

/**
 * Plans the closure of a loan.
 *
 * Interest is applied before capital, so the revenue side of the settlement is
 * recognised first and a shortfall falls on capital recovery rather than on
 * profit. A WRITE_OFF requires a stated reason and records the uncollected
 * remainder explicitly; nothing is ever quietly zeroed out.
 */
export function planSettlement(input: SettlementInput): SettlementPlan {
  const received = Money.of(input.amountReceived);
  if (received.isNegative()) {
    throw new SettlementError("The amount received cannot be negative.");
  }

  const { quote } = input;

  if (input.kind === "FULL_PAYMENT" && !received.equals(quote.total)) {
    throw new SettlementError(
      `A full settlement must receive exactly ${quote.total.toString()}; ` +
        `${received.toString()} was received. Use a write-off to close the loan ` +
        "for less, or register an ordinary payment instead.",
    );
  }

  if (input.kind === "WRITE_OFF") {
    if (!input.reason || input.reason.trim() === "") {
      throw new SettlementError("A write-off requires a stated reason.");
    }
    if (received.greaterThan(quote.total)) {
      throw new SettlementError(
        "A write-off cannot receive more than the settlement total.",
      );
    }
  }

  // Interest first, then configured charges, then capital.
  let remaining = received;

  const interestCollected = Money.min(
    quote.accruedInterestOutstanding.plus(quote.openPeriodCharge),
    remaining,
  );
  remaining = remaining.minus(interestCollected);

  const chargesCollected = Money.min(quote.additionalChargesTotal, remaining);
  remaining = remaining.minus(chargesCollected);

  const principalCollected = Money.min(quote.principalOutstanding, remaining);
  remaining = remaining.minus(principalCollected);

  if (remaining.isPositive()) {
    throw new SettlementError(
      `The settlement leaves ${remaining.toString()} unapplied, which means the ` +
        "quote and the amount received do not agree. This is a bug.",
    );
  }

  const amountWrittenOff = quote.total.minus(received);

  return {
    kind: input.kind,
    settledOn: input.settledOn,
    principalCollected,
    interestCollected,
    chargesCollected,
    amountWrittenOff,
    cashIn: received,
    principalOutstandingAtSettlement: quote.principalOutstanding,
    interestOutstandingAtSettlement: quote.accruedInterestOutstanding.plus(
      quote.openPeriodCharge,
    ),
    reason: input.reason?.trim() || null,
  };
}
