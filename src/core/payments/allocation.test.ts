import { describe, expect, it } from "vitest";

import { calendarDate } from "@/core/time/calendar-date";

import {
  allocatePayment,
  AllocationError,
  outstandingInterest,
  totalDebt,
  type DebtSnapshot,
} from "./allocation";

const d = calendarDate;

/** The scenario from point 10: $1.000.000 of capital, $200.000 of interest. */
function singlePeriodDebt(): DebtSnapshot {
  return {
    periods: [
      { periodId: "p1", dueOn: d("2026-10-24"), interestOutstanding: "200000" },
    ],
    principalOutstanding: "1000000",
  };
}

describe("the worked example from point 10", () => {
  it("applies $300.000 as $200.000 interest then $100.000 capital", () => {
    const plan = allocatePayment({
      amount: "300000",
      debt: singlePeriodDebt(),
      strategy: "INTEREST_FIRST",
    });

    expect(plan.interestTotal.toString()).toBe("200000");
    expect(plan.principalTotal.toString()).toBe("100000");
    expect(plan.resultingPrincipal.toString()).toBe("900000");
    expect(plan.unapplied.isZero()).toBe(true);
  });

  it("records every peso against a named destination, never a bare total", () => {
    const plan = allocatePayment({
      amount: "300000",
      debt: singlePeriodDebt(),
      strategy: "INTEREST_FIRST",
    });

    // This is the shape that goes into payment_allocations.
    expect(plan.interestAllocations).toHaveLength(1);
    expect(plan.interestAllocations[0]!.periodId).toBe("p1");
    expect(plan.interestAllocations[0]!.amount.toString()).toBe("200000");
    expect(plan.periodOutcomes[0]!.fullySettled).toBe(true);
  });
});

describe("PRINCIPAL_FIRST reverses the order", () => {
  it("consumes capital before interest", () => {
    const plan = allocatePayment({
      amount: "300000",
      debt: singlePeriodDebt(),
      strategy: "PRINCIPAL_FIRST",
    });

    expect(plan.principalTotal.toString()).toBe("300000");
    expect(plan.interestTotal.isZero()).toBe(true);
    expect(plan.resultingPrincipal.toString()).toBe("700000");
    expect(plan.periodOutcomes[0]!.interestAfter.toString()).toBe("200000");
  });
});

describe("partial payments (point 12)", () => {
  it("applies $100.000 against $200.000 of interest and leaves the rest pending", () => {
    const plan = allocatePayment({
      amount: "100000",
      debt: singlePeriodDebt(),
      strategy: "INTEREST_FIRST",
    });

    expect(plan.interestTotal.toString()).toBe("100000");
    expect(plan.principalTotal.isZero()).toBe(true);
    // The period must NOT be marked as fully paid.
    expect(plan.periodOutcomes[0]!.interestAfter.toString()).toBe("100000");
    expect(plan.periodOutcomes[0]!.fullySettled).toBe(false);
  });

  it("marks a period settled only when it reaches exactly zero", () => {
    const plan = allocatePayment({
      amount: "200000",
      debt: singlePeriodDebt(),
      strategy: "INTEREST_FIRST",
    });
    expect(plan.periodOutcomes[0]!.fullySettled).toBe(true);
    expect(plan.principalTotal.isZero()).toBe(true);
  });
});

describe("multiple overdue periods are settled oldest first", () => {
  const threePeriods: DebtSnapshot = {
    periods: [
      { periodId: "p1", dueOn: d("2026-10-24"), interestOutstanding: "200000" },
      { periodId: "p2", dueOn: d("2026-11-24"), interestOutstanding: "200000" },
      { periodId: "p3", dueOn: d("2026-12-24"), interestOutstanding: "200000" },
    ],
    principalOutstanding: "1000000",
  };

  it("clears the oldest period fully before touching the next", () => {
    const plan = allocatePayment({
      amount: "300000",
      debt: threePeriods,
      strategy: "INTEREST_FIRST",
    });

    expect(plan.interestTotal.toString()).toBe("300000");
    expect(plan.principalTotal.isZero()).toBe(true);
    expect(plan.interestAllocations.map((a) => a.amount.toString())).toEqual([
      "200000",
      "100000",
    ]);
    expect(plan.periodOutcomes[0]!.fullySettled).toBe(true);
    expect(plan.periodOutcomes[1]!.fullySettled).toBe(false);
    expect(plan.periodOutcomes[1]!.interestAfter.toString()).toBe("100000");
    expect(plan.periodOutcomes[2]!.interestApplied.isZero()).toBe(true);
  });

  it("reports an outcome for every period, including untouched ones", () => {
    const plan = allocatePayment({
      amount: "50000",
      debt: threePeriods,
      strategy: "INTEREST_FIRST",
    });
    expect(plan.periodOutcomes).toHaveLength(3);
  });

  it("moves on to capital once all interest is cleared", () => {
    const plan = allocatePayment({
      amount: "800000",
      debt: threePeriods,
      strategy: "INTEREST_FIRST",
    });
    expect(plan.interestTotal.toString()).toBe("600000");
    expect(plan.principalTotal.toString()).toBe("200000");
    expect(plan.resultingPrincipal.toString()).toBe("800000");
  });
});

describe("payments larger than the whole debt", () => {
  it("reports the excess as unapplied instead of absorbing it", () => {
    const plan = allocatePayment({
      amount: "1500000",
      debt: singlePeriodDebt(),
      strategy: "INTEREST_FIRST",
    });

    expect(plan.interestTotal.toString()).toBe("200000");
    expect(plan.principalTotal.toString()).toBe("1000000");
    expect(plan.resultingPrincipal.isZero()).toBe(true);
    // $300.000 more than the debt. The service layer decides what to do; it is
    // never silently swallowed into a negative balance.
    expect(plan.unapplied.toString()).toBe("300000");
  });

  it("never drives the principal below zero", () => {
    const plan = allocatePayment({
      amount: "5000000",
      debt: singlePeriodDebt(),
      strategy: "PRINCIPAL_FIRST",
    });
    expect(plan.resultingPrincipal.isZero()).toBe(true);
    expect(plan.resultingPrincipal.isNegative()).toBe(false);
  });
});

describe("manual distribution (point 11)", () => {
  it("accepts a distribution that matches the payment exactly", () => {
    const plan = allocatePayment({
      amount: "300000",
      debt: singlePeriodDebt(),
      strategy: "MANUAL_ONLY",
      manual: {
        interest: [{ periodId: "p1", amount: "50000" }],
        principal: "250000",
      },
    });

    expect(plan.interestTotal.toString()).toBe("50000");
    expect(plan.principalTotal.toString()).toBe("250000");
    expect(plan.resultingPrincipal.toString()).toBe("750000");
    expect(plan.periodOutcomes[0]!.interestAfter.toString()).toBe("150000");
    expect(plan.periodOutcomes[0]!.fullySettled).toBe(false);
  });

  it("refuses a distribution that does not add up to the payment", () => {
    // $250.000 + $50.000 must equal the $300.000 received. No tolerance.
    expect(() =>
      allocatePayment({
        amount: "300000",
        debt: singlePeriodDebt(),
        strategy: "MANUAL_ONLY",
        manual: {
          interest: [{ periodId: "p1", amount: "50000" }],
          principal: "200000",
        },
      }),
    ).toThrow(AllocationError);

    expect(() =>
      allocatePayment({
        amount: "300000",
        debt: singlePeriodDebt(),
        strategy: "MANUAL_ONLY",
        manual: {
          interest: [{ periodId: "p1", amount: "100000" }],
          principal: "250000",
        },
      }),
    ).toThrow(AllocationError);
  });

  it("refuses more interest than a period actually owes", () => {
    expect(() =>
      allocatePayment({
        amount: "300000",
        debt: singlePeriodDebt(),
        strategy: "MANUAL_ONLY",
        manual: {
          interest: [{ periodId: "p1", amount: "300000" }],
        },
      }),
    ).toThrow(AllocationError);
  });

  it("refuses more capital than is outstanding, unless settling explicitly", () => {
    const debt: DebtSnapshot = {
      periods: [],
      principalOutstanding: "1000000",
    };

    expect(() =>
      allocatePayment({
        amount: "1200000",
        debt,
        strategy: "MANUAL_ONLY",
        manual: { principal: "1200000" },
      }),
    ).toThrow(AllocationError);

    // The explicit settlement flow may exceed it.
    const settled = allocatePayment({
      amount: "1200000",
      debt,
      strategy: "MANUAL_ONLY",
      manual: { principal: "1200000" },
      allowPrincipalOverpayment: true,
    });
    expect(settled.principalTotal.toString()).toBe("1200000");
    expect(settled.resultingPrincipal.isZero()).toBe(true);
  });

  it("refuses an unknown period", () => {
    expect(() =>
      allocatePayment({
        amount: "100000",
        debt: singlePeriodDebt(),
        strategy: "MANUAL_ONLY",
        manual: { interest: [{ periodId: "does-not-exist", amount: "100000" }] },
      }),
    ).toThrow(AllocationError);
  });

  it("refuses the same period listed twice", () => {
    expect(() =>
      allocatePayment({
        amount: "200000",
        debt: singlePeriodDebt(),
        strategy: "MANUAL_ONLY",
        manual: {
          interest: [
            { periodId: "p1", amount: "100000" },
            { periodId: "p1", amount: "100000" },
          ],
        },
      }),
    ).toThrow(AllocationError);
  });

  it("refuses negative components", () => {
    expect(() =>
      allocatePayment({
        amount: "100000",
        debt: singlePeriodDebt(),
        strategy: "MANUAL_ONLY",
        manual: {
          interest: [{ periodId: "p1", amount: "200000" }],
          principal: "-100000",
        },
      }),
    ).toThrow(AllocationError);
  });

  it("requires a distribution when the strategy is MANUAL_ONLY", () => {
    expect(() =>
      allocatePayment({
        amount: "100000",
        debt: singlePeriodDebt(),
        strategy: "MANUAL_ONLY",
      }),
    ).toThrow(AllocationError);
  });

  it("supports fees alongside interest and capital", () => {
    const plan = allocatePayment({
      amount: "300000",
      debt: singlePeriodDebt(),
      strategy: "MANUAL_ONLY",
      manual: {
        interest: [{ periodId: "p1", amount: "200000" }],
        principal: "80000",
        fees: [{ concept: "Gastos de cobranza", amount: "20000" }],
      },
    });
    expect(plan.feeTotal.toString()).toBe("20000");
    expect(plan.feeAllocations[0]!.concept).toBe("Gastos de cobranza");
  });
});

describe("input validation (point 51)", () => {
  it("refuses a zero or negative payment", () => {
    expect(() =>
      allocatePayment({
        amount: "0",
        debt: singlePeriodDebt(),
        strategy: "INTEREST_FIRST",
      }),
    ).toThrow(AllocationError);

    expect(() =>
      allocatePayment({
        amount: "-100000",
        debt: singlePeriodDebt(),
        strategy: "INTEREST_FIRST",
      }),
    ).toThrow(AllocationError);
  });

  it("refuses a corrupt debt snapshot", () => {
    expect(() =>
      allocatePayment({
        amount: "100000",
        debt: { periods: [], principalOutstanding: "-500000" },
        strategy: "INTEREST_FIRST",
      }),
    ).toThrow(AllocationError);

    expect(() =>
      allocatePayment({
        amount: "100000",
        debt: {
          periods: [
            { periodId: "p1", dueOn: d("2026-10-24"), interestOutstanding: "-1" },
          ],
          principalOutstanding: "1000000",
        },
        strategy: "INTEREST_FIRST",
      }),
    ).toThrow(AllocationError);
  });
});

describe("every plan accounts for the full payment", () => {
  it("balances across a spread of amounts and strategies", () => {
    const amounts = ["1", "50000", "200000", "200001", "999999", "1200000", "5000000"];
    const strategies = ["INTEREST_FIRST", "PRINCIPAL_FIRST"] as const;

    for (const amount of amounts) {
      for (const strategy of strategies) {
        const plan = allocatePayment({
          amount,
          debt: singlePeriodDebt(),
          strategy,
        });
        const accounted = plan.interestTotal
          .plus(plan.principalTotal)
          .plus(plan.feeTotal)
          .plus(plan.unapplied);
        expect(accounted.equals(amount)).toBe(true);
      }
    }
  });
});

describe("debt helpers", () => {
  it("sums outstanding interest and total debt", () => {
    const debt: DebtSnapshot = {
      periods: [
        { periodId: "p1", dueOn: d("2026-10-24"), interestOutstanding: "200000" },
        { periodId: "p2", dueOn: d("2026-11-24"), interestOutstanding: "150000" },
      ],
      principalOutstanding: "1000000",
    };
    expect(outstandingInterest(debt).toString()).toBe("350000");
    expect(totalDebt(debt).toString()).toBe("1350000");
  });

  it("handles an empty period list", () => {
    const debt: DebtSnapshot = { periods: [], principalOutstanding: "1000000" };
    expect(outstandingInterest(debt).isZero()).toBe(true);
    expect(totalDebt(debt).toString()).toBe("1000000");
  });
});
