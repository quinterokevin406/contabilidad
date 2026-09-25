import { describe, expect, it } from "vitest";

import {
  affectsProfit,
  composeEquity,
  computeOperatingResult,
  LedgerError,
  projectCashPosition,
  reconcileClosure,
  type FinancialClass,
  type LedgerEntry,
} from "./ledger";

function entry(
  direction: "IN" | "OUT",
  amount: string,
  financialClass: FinancialClass,
): LedgerEntry {
  return { direction, amount, financialClass };
}

describe("the till projection from point 24", () => {
  it("reproduces the worked example exactly", () => {
    // Saldo inicial $5.000.000
    // + cobro intereses $1.000.000
    // + capital recuperado $800.000
    // - nuevo préstamo $2.000.000
    // - gastos $150.000
    // = saldo esperado $4.650.000
    const position = projectCashPosition("5000000", [
      entry("IN", "1000000", "INTEREST"),
      entry("IN", "800000", "PRINCIPAL"),
      entry("OUT", "2000000", "PRINCIPAL"),
      entry("OUT", "150000", "OPERATING_EXPENSE"),
    ]);

    expect(position.totalIn.toString()).toBe("1800000");
    expect(position.totalOut.toString()).toBe("2150000");
    expect(position.expectedBalance.toString()).toBe("4650000");
  });

  it("is blind to what a movement means, as a till should be", () => {
    // Same cash in, completely different meanings. The drawer holds the same.
    const asInterest = projectCashPosition("0", [entry("IN", "500000", "INTEREST")]);
    const asPrincipal = projectCashPosition("0", [entry("IN", "500000", "PRINCIPAL")]);
    const asEquity = projectCashPosition("0", [
      entry("IN", "500000", "EQUITY_CONTRIBUTION"),
    ]);

    expect(asInterest.expectedBalance.toString()).toBe("500000");
    expect(asPrincipal.expectedBalance.toString()).toBe("500000");
    expect(asEquity.expectedBalance.toString()).toBe("500000");
  });

  it("handles an empty day", () => {
    const position = projectCashPosition("5000000", []);
    expect(position.expectedBalance.toString()).toBe("5000000");
  });

  it("refuses a negative amount, because direction carries the sign", () => {
    expect(() =>
      projectCashPosition("0", [entry("IN", "-500000", "INTEREST")]),
    ).toThrow(LedgerError);
  });
});

describe("closure reconciliation (point 28)", () => {
  it("reports a balanced till", () => {
    const result = reconcileClosure("4650000", "4650000");
    expect(result.isBalanced).toBe(true);
    expect(result.difference.isZero()).toBe(true);
    expect(result.summary).toContain("cuadra");
  });

  it("reports a shortfall with a negative difference", () => {
    const result = reconcileClosure("4650000", "4300000");
    expect(result.isShort).toBe(true);
    expect(result.isOver).toBe(false);
    expect(result.difference.toString()).toBe("-350000");
    expect(result.summary).toContain("Faltan");
  });

  it("reports a surplus", () => {
    const result = reconcileClosure("4650000", "4700000");
    expect(result.isOver).toBe(true);
    expect(result.difference.toString()).toBe("50000");
    expect(result.summary).toContain("Sobran");
  });

  it("refuses a negative count", () => {
    expect(() => reconcileClosure("4650000", "-1")).toThrow(LedgerError);
  });
});

describe("profit classification is the guard rail of point 26", () => {
  it("declares which classes reach the result", () => {
    expect(affectsProfit("INTEREST")).toBe(true);
    expect(affectsProfit("OPERATING_INCOME")).toBe(true);
    expect(affectsProfit("OPERATING_EXPENSE")).toBe(true);

    // The four a naive implementation gets wrong.
    expect(affectsProfit("PRINCIPAL")).toBe(false);
    expect(affectsProfit("EQUITY_CONTRIBUTION")).toBe(false);
    expect(affectsProfit("EQUITY_WITHDRAWAL")).toBe(false);
    expect(affectsProfit("TRANSFER")).toBe(false);
  });

  it("never counts recovered capital as profit", () => {
    // $18.000.000 of capital came back and $2.000.000 of interest was collected.
    // The business earned $2.000.000, not $20.000.000.
    const result = computeOperatingResult([
      entry("IN", "18000000", "PRINCIPAL"),
      entry("IN", "2000000", "INTEREST"),
    ]);

    expect(result.netProfit.toString()).toBe("2000000");
    expect(result.operatingIncome.toString()).toBe("2000000");
    expect(result.principalRecovered.toString()).toBe("18000000");
  });

  it("never counts a disbursement as an operating expense", () => {
    const result = computeOperatingResult([
      entry("OUT", "20000000", "PRINCIPAL"),
      entry("IN", "2000000", "INTEREST"),
      entry("OUT", "150000", "OPERATING_EXPENSE"),
    ]);

    expect(result.operatingExpenses.toString()).toBe("150000");
    expect(result.principalDisbursed.toString()).toBe("20000000");
    // Profit is unaffected by the capital going out.
    expect(result.netProfit.toString()).toBe("1850000");
  });

  it("never counts an owner contribution as revenue", () => {
    const result = computeOperatingResult([
      entry("IN", "40000000", "EQUITY_CONTRIBUTION"),
      entry("IN", "2000000", "INTEREST"),
    ]);

    expect(result.operatingIncome.toString()).toBe("2000000");
    expect(result.equityContributions.toString()).toBe("40000000");
    expect(result.netProfit.toString()).toBe("2000000");
  });

  it("never counts an owner withdrawal as an expense", () => {
    const result = computeOperatingResult([
      entry("IN", "2000000", "INTEREST"),
      entry("OUT", "5000000", "EQUITY_WITHDRAWAL"),
      entry("OUT", "150000", "OPERATING_EXPENSE"),
    ]);

    expect(result.operatingExpenses.toString()).toBe("150000");
    expect(result.equityWithdrawals.toString()).toBe("5000000");
    expect(result.netProfit.toString()).toBe("1850000");
  });

  it("ignores transfers between own accounts", () => {
    const result = computeOperatingResult([
      entry("OUT", "1000000", "TRANSFER"),
      entry("IN", "1000000", "TRANSFER"),
      entry("IN", "2000000", "INTEREST"),
    ]);
    expect(result.netProfit.toString()).toBe("2000000");
  });

  it("subtracts a reversed movement instead of double counting it", () => {
    // A reversal of collected interest sends the money back out.
    const result = computeOperatingResult([
      entry("IN", "2000000", "INTEREST"),
      entry("OUT", "500000", "INTEREST"),
    ]);
    expect(result.interestIncome.toString()).toBe("1500000");
    expect(result.netProfit.toString()).toBe("1500000");
  });

  it("subtracts a reversed expense", () => {
    const result = computeOperatingResult([
      entry("IN", "2000000", "INTEREST"),
      entry("OUT", "300000", "OPERATING_EXPENSE"),
      entry("IN", "100000", "OPERATING_EXPENSE"),
    ]);
    expect(result.operatingExpenses.toString()).toBe("200000");
    expect(result.netProfit.toString()).toBe("1800000");
  });

  it("produces a loss when expenses exceed revenue", () => {
    const result = computeOperatingResult([
      entry("IN", "500000", "INTEREST"),
      entry("OUT", "800000", "OPERATING_EXPENSE"),
    ]);
    expect(result.netProfit.toString()).toBe("-300000");
  });

  it("separates interest from other operating income", () => {
    const result = computeOperatingResult([
      entry("IN", "7400000", "INTEREST"),
      entry("IN", "500000", "OPERATING_INCOME"),
      entry("OUT", "2100000", "OPERATING_EXPENSE"),
    ]);
    expect(result.interestIncome.toString()).toBe("7400000");
    expect(result.otherOperatingIncome.toString()).toBe("500000");
    expect(result.operatingIncome.toString()).toBe("7900000");
    expect(result.netProfit.toString()).toBe("5800000");
  });
});

describe("equity separates growth earned from growth contributed (point 80)", () => {
  it("composes the closing position", () => {
    const equity = composeEquity({
      openingEquity: "40000000",
      netProfit: "5800000",
      ownerContributions: "0",
      ownerWithdrawals: "2600000",
    });
    expect(equity.closingEquity.toString()).toBe("43200000");
  });

  it("keeps an owner injection out of operating growth", () => {
    const equity = composeEquity({
      openingEquity: "40000000",
      netProfit: "2000000",
      ownerContributions: "10000000",
      ownerWithdrawals: "0",
    });

    expect(equity.closingEquity.toString()).toBe("52000000");
    // Equity grew by 12 million, but the business only earned 2 million of it.
    expect(equity.growthFromOperations.toString()).toBe("2000000");
    expect(equity.growthFromContributions.toString()).toBe("10000000");
  });

  it("reports net withdrawals as negative contributed growth", () => {
    const equity = composeEquity({
      openingEquity: "40000000",
      netProfit: "5000000",
      ownerContributions: "1000000",
      ownerWithdrawals: "4000000",
    });
    expect(equity.growthFromContributions.toString()).toBe("-3000000");
    expect(equity.growthFromOperations.toString()).toBe("5000000");
    expect(equity.closingEquity.toString()).toBe("42000000");
  });

  it("carries a loss through to equity", () => {
    const equity = composeEquity({
      openingEquity: "40000000",
      netProfit: "-1500000",
      ownerContributions: "0",
      ownerWithdrawals: "0",
    });
    expect(equity.closingEquity.toString()).toBe("38500000");
  });

  it("refuses negative contributions or withdrawals", () => {
    expect(() =>
      composeEquity({
        openingEquity: "0",
        netProfit: "0",
        ownerContributions: "-1",
        ownerWithdrawals: "0",
      }),
    ).toThrow(LedgerError);
  });
});

describe("bad debt: a real loss that moves no cash", () => {
  // Closing an uncollectable loan destroys capital, but that capital left the
  // till back when the loan was disbursed. Counting it again would understate
  // the drawer; not counting it at all would overstate equity forever.
  const writeOff: LedgerEntry = {
    direction: "OUT",
    amount: "10000000",
    financialClass: "OPERATING_EXPENSE",
    affectsCash: false,
    isWriteOff: true,
  };

  it("does not touch the till", () => {
    const position = projectCashPosition("5000000", [
      entry("IN", "2000000", "INTEREST"),
      writeOff,
    ]);
    expect(position.totalOut.isZero()).toBe(true);
    expect(position.expectedBalance.toString()).toBe("7000000");
  });

  it("does reduce profit", () => {
    const result = computeOperatingResult([
      entry("IN", "2000000", "INTEREST"),
      writeOff,
    ]);
    expect(result.operatingExpenses.toString()).toBe("10000000");
    expect(result.netProfit.toString()).toBe("-8000000");
  });

  it("is reported on its own line while still counting as expense", () => {
    const result = computeOperatingResult([
      entry("IN", "2000000", "INTEREST"),
      entry("OUT", "150000", "OPERATING_EXPENSE"),
      writeOff,
    ]);
    expect(result.badDebtExpense.toString()).toBe("10000000");
    // Already inside operatingExpenses; never added twice.
    expect(result.operatingExpenses.toString()).toBe("10150000");
    expect(result.netProfit.toString()).toBe("-8150000");
  });

  it("keeps the equity formula honest", () => {
    // Owner puts in 60M, lends 40M, writes off 10M of it.
    const entries: LedgerEntry[] = [
      entry("IN", "60000000", "EQUITY_CONTRIBUTION"),
      entry("OUT", "40000000", "PRINCIPAL"),
      writeOff,
    ];
    const result = computeOperatingResult(entries);
    const equity = composeEquity({
      openingEquity: "0",
      netProfit: result.netProfit,
      ownerContributions: result.equityContributions,
      ownerWithdrawals: result.equityWithdrawals,
    });

    // Cash 20M + receivable 30M = 50M. Without the write-off entry this would
    // still read 60M and the figure would be a lie.
    expect(equity.closingEquity.toString()).toBe("50000000");
    expect(projectCashPosition("0", entries).expectedBalance.toString()).toBe(
      "20000000",
    );
  });

  it("an ordinary expense still moves the till", () => {
    const position = projectCashPosition("5000000", [
      entry("OUT", "150000", "OPERATING_EXPENSE"),
    ]);
    expect(position.expectedBalance.toString()).toBe("4850000");
  });
});

describe("the till and the result answer different questions", () => {
  it("a month can grow the till while the business barely earns", () => {
    const entries: LedgerEntry[] = [
      entry("IN", "18000000", "PRINCIPAL"),
      entry("IN", "2000000", "INTEREST"),
      entry("OUT", "150000", "OPERATING_EXPENSE"),
    ];

    const till = projectCashPosition("5000000", entries);
    const result = computeOperatingResult(entries);

    // The drawer holds almost 25 million.
    expect(till.expectedBalance.toString()).toBe("24850000");
    // The business earned 1.85 million. Confusing these two is the mistake the
    // whole FinancialClass design exists to prevent.
    expect(result.netProfit.toString()).toBe("1850000");
  });
});
