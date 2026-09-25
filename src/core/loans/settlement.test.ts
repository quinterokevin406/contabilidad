import { describe, expect, it } from "vitest";

import { calendarDate } from "@/core/time/calendar-date";

import type { MoneyRule } from "./interest";
import {
  planSettlement,
  quoteSettlement,
  SettlementError,
  type SettlementQuoteInput,
} from "./settlement";

const d = calendarDate;
const COP: MoneyRule = { roundingMode: "HALF_UP", moneyQuantum: "1" };

function baseQuote(
  overrides: Partial<SettlementQuoteInput> = {},
): SettlementQuoteInput {
  return {
    principalOutstanding: "1000000",
    accruedInterestOutstanding: "200000",
    openPeriod: {
      startsOn: d("2026-10-24"),
      dueOn: d("2026-11-24"),
      fullPeriodInterest: "200000",
    },
    openPeriodPolicy: "NOT_CHARGED",
    asOf: d("2026-11-08"),
    money: COP,
    ...overrides,
  };
}

describe("the settlement quote breaks down every component (point 16)", () => {
  it("adds capital and accrued interest", () => {
    const quote = quoteSettlement(baseQuote());
    expect(quote.principalOutstanding.toString()).toBe("1000000");
    expect(quote.accruedInterestOutstanding.toString()).toBe("200000");
    expect(quote.total.toString()).toBe("1200000");
  });

  it("includes administrator-configured extra concepts", () => {
    const quote = quoteSettlement(
      baseQuote({
        additionalCharges: [
          { concept: "Gastos de cobranza", amount: "50000" },
          { concept: "Papelería", amount: "10000" },
        ],
      }),
    );
    expect(quote.additionalChargesTotal.toString()).toBe("60000");
    expect(quote.total.toString()).toBe("1260000");
    expect(quote.additionalCharges.map((c) => c.concept)).toEqual([
      "Gastos de cobranza",
      "Papelería",
    ]);
  });

  it("refuses a negative charge", () => {
    expect(() =>
      quoteSettlement(
        baseQuote({ additionalCharges: [{ concept: "Ajuste", amount: "-1" }] }),
      ),
    ).toThrow(SettlementError);
  });

  it("refuses to quote a loan with a negative balance", () => {
    expect(() =>
      quoteSettlement(baseQuote({ principalOutstanding: "-1" })),
    ).toThrow(SettlementError);
  });
});

describe("the open period policy is stated, never assumed", () => {
  it("NOT_CHARGED owes nothing for a period still running", () => {
    const quote = quoteSettlement(baseQuote({ openPeriodPolicy: "NOT_CHARGED" }));
    expect(quote.openPeriodCharge.isZero()).toBe(true);
    expect(quote.total.toString()).toBe("1200000");
    expect(quote.openPeriodExplanation).toContain("no se cobra");
  });

  it("FULL_PERIOD charges the whole period as if it had matured", () => {
    const quote = quoteSettlement(baseQuote({ openPeriodPolicy: "FULL_PERIOD" }));
    expect(quote.openPeriodCharge.toString()).toBe("200000");
    expect(quote.total.toString()).toBe("1400000");
  });

  it("PRORATED charges by elapsed days", () => {
    // 24/10 to 24/11 is 31 days. Settling on 08/11 means 15 days elapsed.
    // 200.000 x 15/31 = 96.774,19... -> 96.774 at HALF_UP on whole pesos.
    const quote = quoteSettlement(baseQuote({ openPeriodPolicy: "PRORATED" }));
    expect(quote.openPeriodCharge.toString()).toBe("96774");
    expect(quote.total.toString()).toBe("1296774");
    expect(quote.openPeriodExplanation).toContain("15 de 31");
  });

  it("PRORATED clamps at both ends", () => {
    // Quoted on the start date: nothing elapsed.
    const atStart = quoteSettlement(
      baseQuote({ openPeriodPolicy: "PRORATED", asOf: d("2026-10-24") }),
    );
    expect(atStart.openPeriodCharge.isZero()).toBe(true);

    // Quoted past the due date: never more than the full period.
    const past = quoteSettlement(
      baseQuote({ openPeriodPolicy: "PRORATED", asOf: d("2026-12-31") }),
    );
    expect(past.openPeriodCharge.toString()).toBe("200000");
  });

  it("charges nothing when there is no open period", () => {
    const quote = quoteSettlement(
      baseQuote({ openPeriod: null, openPeriodPolicy: "FULL_PERIOD" }),
    );
    expect(quote.openPeriodCharge.isZero()).toBe(true);
    expect(quote.openPeriodExplanation).toContain("No hay");
  });
});

describe("a full settlement must match the quote exactly", () => {
  it("accepts the exact total", () => {
    const quote = quoteSettlement(baseQuote());
    const plan = planSettlement({
      quote,
      amountReceived: "1200000",
      kind: "FULL_PAYMENT",
      settledOn: d("2026-11-08"),
    });

    expect(plan.interestCollected.toString()).toBe("200000");
    expect(plan.principalCollected.toString()).toBe("1000000");
    expect(plan.amountWrittenOff.isZero()).toBe(true);
    expect(plan.cashIn.toString()).toBe("1200000");
  });

  it("refuses anything other than the exact total", () => {
    const quote = quoteSettlement(baseQuote());
    for (const amount of ["1199999", "1200001", "0"]) {
      expect(() =>
        planSettlement({
          quote,
          amountReceived: amount,
          kind: "FULL_PAYMENT",
          settledOn: d("2026-11-08"),
        }),
      ).toThrow(SettlementError);
    }
  });

  it("applies interest before capital, so revenue is recognised first", () => {
    const quote = quoteSettlement(
      baseQuote({
        openPeriodPolicy: "FULL_PERIOD",
        additionalCharges: [{ concept: "Gastos", amount: "50000" }],
      }),
    );
    const plan = planSettlement({
      quote,
      amountReceived: quote.total.toString(),
      kind: "FULL_PAYMENT",
      settledOn: d("2026-11-08"),
    });

    // Accrued 200.000 + open period 200.000 = 400.000 of interest.
    expect(plan.interestCollected.toString()).toBe("400000");
    expect(plan.chargesCollected.toString()).toBe("50000");
    expect(plan.principalCollected.toString()).toBe("1000000");
  });
});

describe("a write-off closes the loan without pretending it was collected", () => {
  it("records the uncollected remainder explicitly", () => {
    const quote = quoteSettlement(baseQuote());
    const plan = planSettlement({
      quote,
      amountReceived: "900000",
      kind: "WRITE_OFF",
      reason: "Acuerdo con el cliente por incapacidad de pago.",
      settledOn: d("2026-11-08"),
    });

    expect(plan.interestCollected.toString()).toBe("200000");
    expect(plan.principalCollected.toString()).toBe("700000");
    // $300.000 of capital closed without being recovered.
    expect(plan.amountWrittenOff.toString()).toBe("300000");
    expect(plan.reason).toBe("Acuerdo con el cliente por incapacidad de pago.");
  });

  it("supports closing a loan with nothing received at all", () => {
    const quote = quoteSettlement(baseQuote());
    const plan = planSettlement({
      quote,
      amountReceived: "0",
      kind: "WRITE_OFF",
      reason: "Cartera incobrable.",
      settledOn: d("2026-11-08"),
    });
    expect(plan.cashIn.isZero()).toBe(true);
    expect(plan.amountWrittenOff.toString()).toBe("1200000");
  });

  it("requires a stated reason", () => {
    const quote = quoteSettlement(baseQuote());
    for (const reason of [undefined, null, "", "   "]) {
      expect(() =>
        planSettlement({
          quote,
          amountReceived: "900000",
          kind: "WRITE_OFF",
          reason,
          settledOn: d("2026-11-08"),
        }),
      ).toThrow(SettlementError);
    }
  });

  it("refuses to receive more than the quote", () => {
    const quote = quoteSettlement(baseQuote());
    expect(() =>
      planSettlement({
        quote,
        amountReceived: "1300000",
        kind: "WRITE_OFF",
        reason: "Ajuste",
        settledOn: d("2026-11-08"),
      }),
    ).toThrow(SettlementError);
  });

  it("refuses a negative amount", () => {
    const quote = quoteSettlement(baseQuote());
    expect(() =>
      planSettlement({
        quote,
        amountReceived: "-1",
        kind: "WRITE_OFF",
        reason: "Ajuste",
        settledOn: d("2026-11-08"),
      }),
    ).toThrow(SettlementError);
  });
});

describe("every settlement accounts for the full amount received", () => {
  it("balances across policies and amounts", () => {
    const policies = ["NOT_CHARGED", "FULL_PERIOD", "PRORATED"] as const;

    for (const policy of policies) {
      const quote = quoteSettlement(
        baseQuote({
          openPeriodPolicy: policy,
          additionalCharges: [{ concept: "Gastos", amount: "25000" }],
        }),
      );

      const plan = planSettlement({
        quote,
        amountReceived: quote.total.toString(),
        kind: "FULL_PAYMENT",
        settledOn: d("2026-11-08"),
      });

      const applied = plan.interestCollected
        .plus(plan.principalCollected)
        .plus(plan.chargesCollected);
      expect(applied.equals(quote.total)).toBe(true);
      expect(plan.amountWrittenOff.isZero()).toBe(true);
    }
  });
});
