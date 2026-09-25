import { describe, expect, it } from "vitest";

import { calendarDate } from "@/core/time/calendar-date";

import { planRenewal, RenewalError, type RenewalInput } from "./renewal";

const d = calendarDate;

/** The loan from point 13: $1.000.000 of capital with $200.000 of interest due. */
function baseRenewal(overrides: Partial<RenewalInput> = {}): RenewalInput {
  return {
    loan: {
      currentPrincipalBase: "1000000",
      outstandingPrincipal: "1000000",
      renewalCount: 0,
      schedule: { periodicity: "MONTHLY", anchor: "CALENDAR" },
    },
    closingPeriods: [
      { periodId: "p1", dueOn: d("2026-10-24"), interestOutstanding: "200000" },
    ],
    interestPaid: "200000",
    capitalChange: { kind: "UNCHANGED" },
    effectiveOn: d("2026-10-24"),
    dueBasis: "PREVIOUS_DUE_DATE",
    ...overrides,
  };
}

describe("the worked example from point 13", () => {
  it("collects the interest and carries the same capital forward", () => {
    const plan = planRenewal(baseRenewal());

    expect(plan.interestCollected.toString()).toBe("200000");
    expect(plan.interestCarried.isZero()).toBe(true);
    // Capital continues at $1.000.000 -- unchanged.
    expect(plan.newPrincipalBase.toString()).toBe("1000000");
    expect(plan.newOutstandingPrincipal.toString()).toBe("1000000");
    expect(plan.newDueOn).toBe("2026-11-24");
    expect(plan.sequence).toBe(1);
    expect(plan.closedPeriodIds).toEqual(["p1"]);
  });

  it("moves only the interest through the till", () => {
    const plan = planRenewal(baseRenewal());
    expect(plan.cashIn.toString()).toBe("200000");
    expect(plan.cashOut.isZero()).toBe(true);
    expect(plan.netCash.toString()).toBe("200000");
  });

  it("increments the renewal counter from whatever it was", () => {
    const plan = planRenewal(
      baseRenewal({
        loan: {
          currentPrincipalBase: "1000000",
          outstandingPrincipal: "1000000",
          renewalCount: 4,
          schedule: { periodicity: "MONTHLY", anchor: "CALENDAR" },
        },
      }),
    );
    expect(plan.sequence).toBe(5);
  });

  it("attributes the interest to the specific period it closed", () => {
    const plan = planRenewal(baseRenewal());
    expect(plan.interestAllocations).toEqual([
      { periodId: "p1", amount: expect.anything() },
    ]);
    expect(plan.interestAllocations[0]!.amount.toString()).toBe("200000");
  });
});

describe("the worked example from point 14: renewal with more capital", () => {
  it("adds the additional disbursement to both the base and the balance", () => {
    const plan = planRenewal(
      baseRenewal({
        capitalChange: { kind: "INCREASE", additionalDisbursed: "500000" },
      }),
    );

    expect(plan.previousPrincipalBase.toString()).toBe("1000000");
    expect(plan.interestCollected.toString()).toBe("200000");
    expect(plan.additionalDisbursed.toString()).toBe("500000");
    // New capital: $1.500.000
    expect(plan.newPrincipalBase.toString()).toBe("1500000");
    expect(plan.newOutstandingPrincipal.toString()).toBe("1500000");
  });

  it("reports both directions of cash so the till reconciles", () => {
    const plan = planRenewal(
      baseRenewal({
        capitalChange: { kind: "INCREASE", additionalDisbursed: "500000" },
      }),
    );
    expect(plan.cashIn.toString()).toBe("200000");
    expect(plan.cashOut.toString()).toBe("500000");
    // The renewal costs the business $300.000 of liquidity today.
    expect(plan.netCash.toString()).toBe("-300000");
  });

  it("refuses a non-positive increase", () => {
    expect(() =>
      planRenewal(
        baseRenewal({
          capitalChange: { kind: "INCREASE", additionalDisbursed: "0" },
        }),
      ),
    ).toThrow(RenewalError);
  });
});

describe("renewal that also collects capital", () => {
  it("reduces the base and the balance", () => {
    const plan = planRenewal(
      baseRenewal({
        capitalChange: { kind: "DECREASE", principalCollected: "400000" },
      }),
    );
    expect(plan.principalCollected.toString()).toBe("400000");
    expect(plan.newPrincipalBase.toString()).toBe("600000");
    expect(plan.newOutstandingPrincipal.toString()).toBe("600000");
    expect(plan.cashIn.toString()).toBe("600000");
    expect(plan.netCash.toString()).toBe("600000");
  });

  it("refuses to collect more capital than is outstanding", () => {
    expect(() =>
      planRenewal(
        baseRenewal({
          capitalChange: { kind: "DECREASE", principalCollected: "1200000" },
        }),
      ),
    ).toThrow(RenewalError);
  });
});

describe("the due date basis is stated, never guessed", () => {
  it("keeps the contract rhythm with PREVIOUS_DUE_DATE", () => {
    // Client pays late, on the 27th. The next date stays on the 24th.
    const plan = planRenewal(
      baseRenewal({ effectiveOn: d("2026-10-27"), dueBasis: "PREVIOUS_DUE_DATE" }),
    );
    expect(plan.newDueOn).toBe("2026-11-24");
  });

  it("restarts the clock with EFFECTIVE_DATE", () => {
    const plan = planRenewal(
      baseRenewal({ effectiveOn: d("2026-10-27"), dueBasis: "EFFECTIVE_DATE" }),
    );
    expect(plan.newDueOn).toBe("2026-11-27");
  });

  it("anchors to the LATEST closed period, so catching up grants no free cycle", () => {
    const plan = planRenewal(
      baseRenewal({
        closingPeriods: [
          { periodId: "p1", dueOn: d("2026-10-24"), interestOutstanding: "200000" },
          { periodId: "p2", dueOn: d("2026-11-24"), interestOutstanding: "200000" },
          { periodId: "p3", dueOn: d("2026-12-24"), interestOutstanding: "200000" },
        ],
        interestPaid: "600000",
        effectiveOn: d("2026-12-30"),
        dueBasis: "PREVIOUS_DUE_DATE",
      }),
    );
    expect(plan.newDueOn).toBe("2027-01-24");
  });
});

describe("closing several missed periods at once", () => {
  it("spreads the interest across them oldest first", () => {
    const plan = planRenewal(
      baseRenewal({
        closingPeriods: [
          { periodId: "p1", dueOn: d("2026-10-24"), interestOutstanding: "200000" },
          { periodId: "p2", dueOn: d("2026-11-24"), interestOutstanding: "200000" },
        ],
        interestPaid: "400000",
      }),
    );
    expect(plan.interestAllocations.map((a) => a.periodId)).toEqual(["p1", "p2"]);
    expect(plan.interestAllocations.map((a) => a.amount.toString())).toEqual([
      "200000",
      "200000",
    ]);
    expect(plan.closedPeriodIds).toEqual(["p1", "p2"]);
  });
});

describe("interest must be settled unless a partial renewal is explicit", () => {
  it("refuses to renew with interest still owed", () => {
    expect(() =>
      planRenewal(baseRenewal({ interestPaid: "150000" })),
    ).toThrow(RenewalError);
  });

  it("carries the shortfall when a partial renewal is explicitly allowed", () => {
    const plan = planRenewal(
      baseRenewal({ interestPaid: "150000", allowPartialInterest: true }),
    );
    expect(plan.interestCollected.toString()).toBe("150000");
    // The remainder is reported, never erased.
    expect(plan.interestCarried.toString()).toBe("50000");
  });

  it("refuses more interest than the closing periods owe", () => {
    expect(() =>
      planRenewal(baseRenewal({ interestPaid: "300000" })),
    ).toThrow(RenewalError);
  });

  it("refuses negative interest", () => {
    expect(() =>
      planRenewal(baseRenewal({ interestPaid: "-1" })),
    ).toThrow(RenewalError);
  });
});

describe("input validation", () => {
  it("refuses a renewal that closes nothing", () => {
    expect(() => planRenewal(baseRenewal({ closingPeriods: [] }))).toThrow(
      RenewalError,
    );
  });

  it("refuses a corrupt renewal counter", () => {
    expect(() =>
      planRenewal(
        baseRenewal({
          loan: {
            currentPrincipalBase: "1000000",
            outstandingPrincipal: "1000000",
            renewalCount: -1,
            schedule: { periodicity: "MONTHLY", anchor: "CALENDAR" },
          },
        }),
      ),
    ).toThrow(RenewalError);
  });

  it("refuses a negative principal on the loan", () => {
    expect(() =>
      planRenewal(
        baseRenewal({
          loan: {
            currentPrincipalBase: "-1000000",
            outstandingPrincipal: "-1000000",
            renewalCount: 0,
            schedule: { periodicity: "MONTHLY", anchor: "CALENDAR" },
          },
        }),
      ),
    ).toThrow(RenewalError);
  });

  it("refuses a period with negative outstanding interest", () => {
    expect(() =>
      planRenewal(
        baseRenewal({
          closingPeriods: [
            { periodId: "p1", dueOn: d("2026-10-24"), interestOutstanding: "-1" },
          ],
          interestPaid: "0",
        }),
      ),
    ).toThrow(RenewalError);
  });
});
