import { Money, type MoneyInput } from "@/core/money/money";

/**
 * Mirrors the FinancialClass enum in the Prisma schema.
 *
 * This is the backbone of points 26, 27 and 58. An administrator may invent any
 * category name they like, but the category must declare one of these classes,
 * and every report sums by class. That is the structural reason principal
 * recovery can never be counted as profit.
 */
export type FinancialClass =
  | "PRINCIPAL"
  | "INTEREST"
  | "OPERATING_INCOME"
  | "OPERATING_EXPENSE"
  | "EQUITY_CONTRIBUTION"
  | "EQUITY_WITHDRAWAL"
  | "TRANSFER";

export type CashDirection = "IN" | "OUT";

export class LedgerError extends Error {}

/** One cash movement, reduced to what the ledger maths needs. */
export interface LedgerEntry {
  direction: CashDirection;
  /** Always positive. The sign lives in `direction`. */
  amount: MoneyInput;
  financialClass: FinancialClass;
  /**
   * Whether the movement actually moves money in or out of the till.
   *
   * Defaults to true. It is false only for a bad-debt write-off, which is a real
   * loss but moves no cash — the money left the drawer when the loan was
   * disbursed. The till ignores those rows; the result counts them.
   */
  affectsCash?: boolean;
  /**
   * Marks a bad-debt write-off so it can be reported on its own line.
   *
   * It still counts as an operating expense — the loss is real — but "we spent
   * more on transport" and "we lost a loan" are different stories, and a growth
   * report that blends them teaches the wrong lesson.
   */
  isWriteOff?: boolean;
}

/**
 * Which classes count toward operating profit.
 *
 * Declared as data rather than buried in a conditional so the rule is visible,
 * testable, and impossible to drift out of sync with the reports.
 */
const PROFIT_CLASSES: Readonly<Record<FinancialClass, "income" | "expense" | "excluded">> = {
  // Revenue.
  INTEREST: "income",
  OPERATING_INCOME: "income",
  // Cost.
  OPERATING_EXPENSE: "expense",
  // Balance sheet only. Recovering or lending capital is not a result.
  PRINCIPAL: "excluded",
  // Owner money in and out is equity, never revenue or expense.
  EQUITY_CONTRIBUTION: "excluded",
  EQUITY_WITHDRAWAL: "excluded",
  // Nets to zero by definition.
  TRANSFER: "excluded",
};

export function affectsProfit(financialClass: FinancialClass): boolean {
  return PROFIT_CLASSES[financialClass] !== "excluded";
}

// --- Cash position ----------------------------------------------------------

export interface CashPosition {
  openingBalance: Money;
  totalIn: Money;
  totalOut: Money;
  /** openingBalance + totalIn - totalOut */
  expectedBalance: Money;
}

/**
 * Projects the balance a till should hold (point 24).
 *
 * Deliberately blind to what any movement MEANS: the drawer does not care whether
 * a peso arrived as interest or as recovered capital. Profitability is a separate
 * question, answered by `computeOperatingResult`.
 *
 * Non-cash entries are skipped. A bad-debt write-off belongs in the result but
 * not in the drawer: that money left when the loan was disbursed, and counting it
 * a second time would understate the till by the written-off amount.
 */
export function projectCashPosition(
  openingBalance: MoneyInput,
  entries: readonly LedgerEntry[],
): CashPosition {
  const opening = Money.of(openingBalance);

  let totalIn = Money.zero();
  let totalOut = Money.zero();

  for (const entry of entries) {
    const amount = Money.of(entry.amount);
    if (amount.isNegative()) {
      throw new LedgerError(
        "A cash movement amount must be positive; direction carries the sign.",
      );
    }
    if (entry.affectsCash === false) continue;
    if (entry.direction === "IN") totalIn = totalIn.plus(amount);
    else totalOut = totalOut.plus(amount);
  }

  return {
    openingBalance: opening,
    totalIn,
    totalOut,
    expectedBalance: opening.plus(totalIn).minus(totalOut),
  };
}

export interface ClosureReconciliation {
  expectedBalance: Money;
  countedBalance: Money;
  /** countedBalance - expectedBalance. Negative means the till is short. */
  difference: Money;
  isBalanced: boolean;
  isShort: boolean;
  isOver: boolean;
  /** Plain-language summary for the closure screen. */
  summary: string;
}

/** Reconciles a counted till against its expected balance (point 28). */
export function reconcileClosure(
  expectedBalance: MoneyInput,
  countedBalance: MoneyInput,
): ClosureReconciliation {
  const expected = Money.of(expectedBalance);
  const counted = Money.of(countedBalance);

  if (counted.isNegative()) {
    throw new LedgerError("A counted till balance cannot be negative.");
  }

  const difference = counted.minus(expected);

  return {
    expectedBalance: expected,
    countedBalance: counted,
    difference,
    isBalanced: difference.isZero(),
    isShort: difference.isNegative(),
    isOver: difference.isPositive(),
    summary: difference.isZero()
      ? "La caja cuadra exactamente."
      : difference.isNegative()
        ? `Faltan ${difference.abs().toString()} respecto al saldo esperado.`
        : `Sobran ${difference.toString()} respecto al saldo esperado.`,
  };
}

// --- Operating result -------------------------------------------------------

export interface OperatingResult {
  /** Interest collected. The core revenue of a lending business. */
  interestIncome: Money;
  /** Non-interest operating revenue. */
  otherOperatingIncome: Money;
  /** interestIncome + otherOperatingIncome */
  operatingIncome: Money;
  /** All operating cost, INCLUDING bad debt. */
  operatingExpenses: Money;
  /**
   * The bad-debt portion of `operatingExpenses`, broken out for reporting.
   *
   * Already included above; do not add it again.
   */
  badDebtExpense: Money;
  /** operatingIncome - operatingExpenses */
  netProfit: Money;

  // Reported separately, and deliberately NOT part of netProfit.
  /** Capital that came back. Recovery, not earnings. */
  principalRecovered: Money;
  /** Capital that went out as loans. Not an expense. */
  principalDisbursed: Money;
  /** Owner money in. Equity, not revenue. */
  equityContributions: Money;
  /** Owner money out. Equity, not expense. */
  equityWithdrawals: Money;
}

/**
 * Splits a set of movements into a profit-and-loss statement.
 *
 * The four figures at the bottom are the ones a naive implementation gets wrong.
 * They are reported because the operator needs them, and they are kept out of
 * `netProfit` because including them would answer the wrong question: a month
 * where $18.000.000 of capital came back and $2.000.000 of interest was collected
 * earned $2.000.000, not $20.000.000.
 */
export function computeOperatingResult(
  entries: readonly LedgerEntry[],
): OperatingResult {
  let interestIncome = Money.zero();
  let otherOperatingIncome = Money.zero();
  let operatingExpenses = Money.zero();
  let badDebtExpense = Money.zero();
  let principalRecovered = Money.zero();
  let principalDisbursed = Money.zero();
  let equityContributions = Money.zero();
  let equityWithdrawals = Money.zero();

  for (const entry of entries) {
    const amount = Money.of(entry.amount);
    if (amount.isNegative()) {
      throw new LedgerError(
        "A cash movement amount must be positive; direction carries the sign.",
      );
    }

    switch (entry.financialClass) {
      case "INTEREST":
        // Interest normally arrives; a reversal sends it back out.
        interestIncome =
          entry.direction === "IN"
            ? interestIncome.plus(amount)
            : interestIncome.minus(amount);
        break;

      case "OPERATING_INCOME":
        otherOperatingIncome =
          entry.direction === "IN"
            ? otherOperatingIncome.plus(amount)
            : otherOperatingIncome.minus(amount);
        break;

      case "OPERATING_EXPENSE": {
        const signed = entry.direction === "OUT" ? amount : amount.negated();
        operatingExpenses = operatingExpenses.plus(signed);
        if (entry.isWriteOff) badDebtExpense = badDebtExpense.plus(signed);
        break;
      }

      case "PRINCIPAL":
        if (entry.direction === "IN") {
          principalRecovered = principalRecovered.plus(amount);
        } else {
          principalDisbursed = principalDisbursed.plus(amount);
        }
        break;

      case "EQUITY_CONTRIBUTION":
        equityContributions =
          entry.direction === "IN"
            ? equityContributions.plus(amount)
            : equityContributions.minus(amount);
        break;

      case "EQUITY_WITHDRAWAL":
        equityWithdrawals =
          entry.direction === "OUT"
            ? equityWithdrawals.plus(amount)
            : equityWithdrawals.minus(amount);
        break;

      case "TRANSFER":
        // Nets to zero across own accounts; irrelevant to the result.
        break;
    }
  }

  const operatingIncome = interestIncome.plus(otherOperatingIncome);

  return {
    interestIncome,
    otherOperatingIncome,
    operatingIncome,
    operatingExpenses,
    badDebtExpense,
    netProfit: operatingIncome.minus(operatingExpenses),
    principalRecovered,
    principalDisbursed,
    equityContributions,
    equityWithdrawals,
  };
}

// --- Equity -----------------------------------------------------------------

export interface EquityPosition {
  openingEquity: Money;
  /** Profit generated by the operation during the period. */
  netProfit: Money;
  ownerContributions: Money;
  ownerWithdrawals: Money;
  /** openingEquity + netProfit + contributions - withdrawals */
  closingEquity: Money;
  /** Change attributable to the business operating. */
  growthFromOperations: Money;
  /** Change attributable to the owner putting money in or taking it out. */
  growthFromContributions: Money;
}

/**
 * Composes the equity movement of a period (points 58 and 80).
 *
 * Growth from operations and growth from contributions are kept apart because
 * they answer completely different questions. An owner who injects $10.000.000
 * has more capital, but the business did not earn it, and a growth chart that
 * blends the two is lying to whoever reads it.
 */
export function composeEquity(input: {
  openingEquity: MoneyInput;
  netProfit: MoneyInput;
  ownerContributions: MoneyInput;
  ownerWithdrawals: MoneyInput;
}): EquityPosition {
  const opening = Money.of(input.openingEquity);
  const netProfit = Money.of(input.netProfit);
  const contributions = Money.of(input.ownerContributions);
  const withdrawals = Money.of(input.ownerWithdrawals);

  if (contributions.isNegative() || withdrawals.isNegative()) {
    throw new LedgerError("Owner contributions and withdrawals cannot be negative.");
  }

  return {
    openingEquity: opening,
    netProfit,
    ownerContributions: contributions,
    ownerWithdrawals: withdrawals,
    closingEquity: opening.plus(netProfit).plus(contributions).minus(withdrawals),
    growthFromOperations: netProfit,
    growthFromContributions: contributions.minus(withdrawals),
  };
}
