import { describe, expect, it } from "vitest";

import { Money } from "@/core/money/money";
import { calendarDate } from "@/core/time/calendar-date";

import {
  AccrualError,
  dueDateFor,
  planAccrual,
  projectInterestThrough,
  projectPeriod,
  startDateFor,
  type AccrualLoan,
} from "./accrual";
import type { MoneyRule } from "./interest";

const d = calendarDate;
const COP: MoneyRule = { roundingMode: "HALF_UP", moneyQuantum: "1" };

/** Juan Pérez from point 4: $1.000.000, 20% monthly, disbursed 24/09/2026. */
function juanPerez(overrides: Partial<AccrualLoan> = {}): AccrualLoan {
  return {
    anchorDueOn: d("2026-10-24"),
    anchorIndex: 0,
    lastPeriodIndex: 0,
    schedule: { periodicity: "MONTHLY", anchor: "CALENDAR" },
    interestMethod: "SIMPLE_ON_ORIGINAL_PRINCIPAL",
    ratePercent: "20",
    money: COP,
    principal: {
      currentPrincipalBase: "1000000",
      outstandingPrincipal: "1000000",
    },
    ...overrides,
  };
}

describe("schedule derivation", () => {
  it("derives each due date from the first one, not from its predecessor", () => {
    const loan = juanPerez();
    expect(dueDateFor(loan, 1)).toBe("2026-10-24");
    expect(dueDateFor(loan, 2)).toBe("2026-11-24");
    expect(dueDateFor(loan, 3)).toBe("2026-12-24");
    expect(dueDateFor(loan, 4)).toBe("2027-01-24");
  });

  it("recovers the day of month after a clamped February", () => {
    const loan = juanPerez({ anchorDueOn: d("2026-01-31") });
    expect(dueDateFor(loan, 1)).toBe("2026-01-31");
    expect(dueDateFor(loan, 2)).toBe("2026-02-28");
    // Anchoring to the first date means March returns to the 31st.
    expect(dueDateFor(loan, 3)).toBe("2026-03-31");
  });

  it("starts each period where the previous one ended", () => {
    const loan = juanPerez();
    // Period 1 runs from the disbursement anchor to the first due date.
    expect(startDateFor(loan, 1)).toBe("2026-09-24");
    expect(startDateFor(loan, 2)).toBe("2026-10-24");
    expect(startDateFor(loan, 3)).toBe("2026-11-24");
  });

  it("rejects a non-positive period index", () => {
    const loan = juanPerez();
    expect(() => dueDateFor(loan, 0)).toThrow(AccrualError);
    expect(() => dueDateFor(loan, -1)).toThrow(AccrualError);
    expect(() => dueDateFor(loan, 1.5)).toThrow(AccrualError);
  });
});

describe("the schedule anchor survives a renewal", () => {
  // A renewal can restart the rhythm, but period indices must stay unique and
  // monotonic for the life of the loan. Resetting the counter instead of moving
  // the anchor makes a second renewal collide with the periods the first one
  // already wrote -- which is exactly the bug this models.
  const afterRenewal = juanPerez({
    // Six periods already accrued and closed; the renewal reopens at 24/04/2027.
    anchorDueOn: d("2027-04-24"),
    anchorIndex: 6,
    lastPeriodIndex: 6,
  });

  it("numbers the next period after the last one, not from one", () => {
    const plan = planAccrual(afterRenewal, d("2027-04-24"));
    expect(plan.newPeriods).toHaveLength(1);
    expect(plan.newPeriods[0]!.periodIndex).toBe(7);
    expect(plan.newPeriods[0]!.dueOn).toBe("2027-04-24");
  });

  it("keeps advancing from the new anchor", () => {
    expect(dueDateFor(afterRenewal, 7)).toBe("2027-04-24");
    expect(dueDateFor(afterRenewal, 8)).toBe("2027-05-24");
    expect(dueDateFor(afterRenewal, 9)).toBe("2027-06-24");
  });

  it("refuses to recompute a date that predates the anchor", () => {
    // Periods 1 to 6 keep the due dates stored on their own rows; recomputing
    // them from a moved anchor would silently rewrite history.
    expect(() => dueDateFor(afterRenewal, 6)).toThrow(AccrualError);
    expect(() => dueDateFor(afterRenewal, 1)).toThrow(AccrualError);
  });

  it("starts the renewed period one period before its due date", () => {
    expect(startDateFor(afterRenewal, 7)).toBe("2027-03-24");
  });
});

describe("a period accrues exactly when its due date arrives", () => {
  it("accrues nothing on the day of disbursement", () => {
    const plan = planAccrual(juanPerez(), d("2026-09-24"));
    expect(plan.newPeriods).toHaveLength(0);
    expect(plan.lastPeriodIndex).toBe(0);
    expect(plan.nextDueOn).toBe("2026-10-24");
  });

  it("accrues nothing the day before the due date", () => {
    const plan = planAccrual(juanPerez(), d("2026-10-23"));
    expect(plan.newPeriods).toHaveLength(0);
  });

  it("accrues the first period ON the due date, so today's collections work", () => {
    const plan = planAccrual(juanPerez(), d("2026-10-24"));
    expect(plan.newPeriods).toHaveLength(1);
    expect(plan.newPeriods[0]!.periodIndex).toBe(1);
    expect(plan.newPeriods[0]!.dueOn).toBe("2026-10-24");
    expect(plan.newPeriods[0]!.interestAccrued.toString()).toBe("200000");
    expect(plan.lastPeriodIndex).toBe(1);
    expect(plan.nextDueOn).toBe("2026-11-24");
  });

  it("never materializes a period that has not come due", () => {
    // Freezing a future period's principal basis is the bug this prevents: a
    // later capital payment would leave that basis stale.
    const plan = planAccrual(juanPerez(), d("2026-11-01"));
    expect(plan.newPeriods.map((p) => p.dueOn)).toEqual(["2026-10-24"]);
  });
});

describe("catching up several missed periods at once", () => {
  it("materializes one row per elapsed period, each with the same simple interest", () => {
    const plan = planAccrual(juanPerez(), d("2026-12-24"));

    expect(plan.newPeriods).toHaveLength(3);
    expect(plan.newPeriods.map((p) => p.periodIndex)).toEqual([1, 2, 3]);
    expect(plan.newPeriods.map((p) => p.dueOn)).toEqual([
      "2026-10-24",
      "2026-11-24",
      "2026-12-24",
    ]);
    // Point 4: three unpaid periods owe $600.000, never a compounded $728.000.
    expect(Money.sum(plan.newPeriods.map((p) => p.interestAccrued)).toString()).toBe(
      "600000",
    );
    expect(plan.newPeriods.map((p) => p.interestAccrued.toString())).toEqual([
      "200000",
      "200000",
      "200000",
    ]);
  });

  it("resumes from the last materialized index without redoing work", () => {
    const plan = planAccrual(
      juanPerez({ lastPeriodIndex: 2 }),
      d("2026-12-24"),
    );
    expect(plan.newPeriods).toHaveLength(1);
    expect(plan.newPeriods[0]!.periodIndex).toBe(3);
    expect(plan.newPeriods[0]!.dueOn).toBe("2026-12-24");
  });

  it("is idempotent once everything due has been materialized", () => {
    const plan = planAccrual(
      juanPerez({ lastPeriodIndex: 3 }),
      d("2026-12-24"),
    );
    expect(plan.newPeriods).toHaveLength(0);
    expect(plan.lastPeriodIndex).toBe(3);
  });
});

describe("each accrued period freezes the inputs it was computed from", () => {
  it("stores the principal basis and the rate applied", () => {
    const plan = planAccrual(juanPerez(), d("2026-10-24"));
    const period = plan.newPeriods[0]!;
    expect(period.principalBasis.toString()).toBe("1000000");
    expect(period.rateApplied.toString()).toBe("20");
  });

  it("freezes the ORIGINAL base under SIMPLE_ON_ORIGINAL_PRINCIPAL", () => {
    // Capital already paid down to 600k, but this method charges the base.
    const plan = planAccrual(
      juanPerez({
        principal: {
          currentPrincipalBase: "1000000",
          outstandingPrincipal: "600000",
        },
      }),
      d("2026-10-24"),
    );
    expect(plan.newPeriods[0]!.principalBasis.toString()).toBe("1000000");
    expect(plan.newPeriods[0]!.interestAccrued.toString()).toBe("200000");
  });

  it("freezes the CURRENT balance under SIMPLE_ON_OUTSTANDING_PRINCIPAL", () => {
    const plan = planAccrual(
      juanPerez({
        interestMethod: "SIMPLE_ON_OUTSTANDING_PRINCIPAL",
        principal: {
          currentPrincipalBase: "1000000",
          outstandingPrincipal: "600000",
        },
      }),
      d("2026-10-24"),
    );
    expect(plan.newPeriods[0]!.principalBasis.toString()).toBe("600000");
    expect(plan.newPeriods[0]!.interestAccrued.toString()).toBe("120000");
  });
});

describe("non-monthly schedules", () => {
  it("accrues weekly periods", () => {
    const weekly = juanPerez({
      anchorDueOn: d("2026-10-01"),
      schedule: { periodicity: "WEEKLY", anchor: "FIXED_DAYS" },
      ratePercent: "5",
    });
    const plan = planAccrual(weekly, d("2026-10-22"));
    expect(plan.newPeriods.map((p) => p.dueOn)).toEqual([
      "2026-10-01",
      "2026-10-08",
      "2026-10-15",
      "2026-10-22",
    ]);
    expect(plan.newPeriods[0]!.interestAccrued.toString()).toBe("50000");
  });

  it("accrues a custom 45-day schedule", () => {
    const custom = juanPerez({
      anchorDueOn: d("2026-10-01"),
      schedule: {
        periodicity: "CUSTOM",
        anchor: "FIXED_DAYS",
        customPeriodDays: 45,
      },
    });
    const plan = planAccrual(custom, d("2026-11-15"));
    expect(plan.newPeriods.map((p) => p.dueOn)).toEqual([
      "2026-10-01",
      "2026-11-15",
    ]);
  });
});

describe("projections never touch the database (point 9 preview)", () => {
  it("produces the confirmation summary from the specification", () => {
    const projection = projectPeriod(juanPerez(), 1);
    expect(projection.isProjection).toBe(true);
    expect(projection.startsOn).toBe("2026-09-24");
    expect(projection.dueOn).toBe("2026-10-24");
    expect(projection.basis.toString()).toBe("1000000");
    expect(projection.interest.toString()).toBe("200000");
    // TOTAL AL PRIMER VENCIMIENTO: $1.200.000
    expect(projection.totalAtDueDate.toString()).toBe("1200000");
  });

  it("reflects the current balance for an outstanding-balance loan", () => {
    const projection = projectPeriod(
      juanPerez({
        interestMethod: "SIMPLE_ON_OUTSTANDING_PRINCIPAL",
        principal: {
          currentPrincipalBase: "1000000",
          outstandingPrincipal: "600000",
        },
      }),
      2,
    );
    expect(projection.interest.toString()).toBe("120000");
    expect(projection.totalAtDueDate.toString()).toBe("720000");
  });
});

describe("projectInterestThrough feeds the collections calendar", () => {
  it("forecasts the periods falling inside a horizon", () => {
    const result = projectInterestThrough(
      juanPerez(),
      d("2026-09-24"),
      d("2026-12-24"),
    );
    expect(result.periods.map((p) => p.dueOn)).toEqual([
      "2026-10-24",
      "2026-11-24",
      "2026-12-24",
    ]);
    expect(result.total.toString()).toBe("600000");
  });

  it("returns nothing when no period falls inside the horizon", () => {
    const result = projectInterestThrough(
      juanPerez(),
      d("2026-09-24"),
      d("2026-10-01"),
    );
    expect(result.periods).toHaveLength(0);
    expect(result.total.isZero()).toBe(true);
  });

  it("refuses a horizon before the as-of date", () => {
    expect(() =>
      projectInterestThrough(juanPerez(), d("2026-10-24"), d("2026-09-24")),
    ).toThrow(AccrualError);
  });
});

describe("input validation", () => {
  it("refuses a corrupt period index on the loan", () => {
    expect(() => planAccrual(juanPerez({ lastPeriodIndex: -1 }), d("2026-10-24")))
      .toThrow(AccrualError);
    expect(() => planAccrual(juanPerez({ lastPeriodIndex: 1.5 }), d("2026-10-24")))
      .toThrow(AccrualError);
  });
});
