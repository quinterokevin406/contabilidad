import { describe, expect, it } from "vitest";

import { calendarDate } from "@/core/time/calendar-date";

import {
  AGING_BUCKETS,
  computeDaysOverdue,
  deriveCompliance,
  deriveLifecycle,
  describeLoanState,
  resolveAgingBucket,
  type ComplianceInput,
} from "./state";

const d = calendarDate;

function compliance(overrides: Partial<ComplianceInput> = {}): ComplianceInput {
  return {
    oldestUnpaidDueOn: null,
    nextDueOn: d("2026-11-24"),
    today: d("2026-10-24"),
    overdueGraceDays: 0,
    dueSoonLeadDays: 3,
    ...overrides,
  };
}

describe("deriveCompliance", () => {
  it("is CURRENT when nothing is owed and the next date is far away", () => {
    expect(deriveCompliance(compliance())).toBe("CURRENT");
  });

  it("is DUE_SOON inside the lead window", () => {
    expect(
      deriveCompliance(compliance({ nextDueOn: d("2026-10-26") })),
    ).toBe("DUE_SOON");
    expect(
      deriveCompliance(compliance({ nextDueOn: d("2026-10-27") })),
    ).toBe("DUE_SOON");
    expect(
      deriveCompliance(compliance({ nextDueOn: d("2026-10-28") })),
    ).toBe("CURRENT");
  });

  it("is OVERDUE once the grace window on the oldest unpaid period passes", () => {
    // Due 24/10, no grace, today 24/10: owed today, not yet late.
    expect(
      deriveCompliance(compliance({ oldestUnpaidDueOn: d("2026-10-24") })),
    ).toBe("DUE_SOON");

    // Today 25/10: one day late.
    expect(
      deriveCompliance(
        compliance({ oldestUnpaidDueOn: d("2026-10-24"), today: d("2026-10-25") }),
      ),
    ).toBe("OVERDUE");
  });

  it("honours a configured grace period", () => {
    const input = compliance({
      oldestUnpaidDueOn: d("2026-10-24"),
      today: d("2026-10-27"),
      overdueGraceDays: 3,
    });
    expect(deriveCompliance(input)).toBe("DUE_SOON");
    expect(deriveCompliance({ ...input, today: d("2026-10-28") })).toBe("OVERDUE");
  });

  it("judges lateness by the OLDEST unpaid period, never the newest", () => {
    // Three periods behind. A grace window on the most recent one must not mask
    // the first one being months late.
    expect(
      deriveCompliance(
        compliance({
          oldestUnpaidDueOn: d("2026-07-24"),
          nextDueOn: d("2026-11-24"),
          today: d("2026-10-24"),
          overdueGraceDays: 5,
        }),
      ),
    ).toBe("OVERDUE");
  });

  it("refuses negative day configuration", () => {
    expect(() => deriveCompliance(compliance({ overdueGraceDays: -1 }))).toThrow();
    expect(() => deriveCompliance(compliance({ dueSoonLeadDays: -1 }))).toThrow();
  });
});

describe("computeDaysOverdue counts from the due date itself", () => {
  it("returns zero when nothing is unpaid", () => {
    expect(computeDaysOverdue(null, d("2026-10-24"))).toBe(0);
  });

  it("returns zero on and before the due date", () => {
    expect(computeDaysOverdue(d("2026-10-24"), d("2026-10-24"))).toBe(0);
    expect(computeDaysOverdue(d("2026-10-24"), d("2026-10-20"))).toBe(0);
  });

  it("counts calendar days late", () => {
    expect(computeDaysOverdue(d("2026-10-24"), d("2026-10-25"))).toBe(1);
    expect(computeDaysOverdue(d("2026-09-24"), d("2026-10-24"))).toBe(30);
  });
});

describe("deriveLifecycle", () => {
  it("stays ACTIVE while any balance remains", () => {
    expect(
      deriveLifecycle("ACTIVE", {
        outstandingPrincipal: "900000",
        outstandingInterest: "0",
      }),
    ).toBe("ACTIVE");

    expect(
      deriveLifecycle("ACTIVE", {
        outstandingPrincipal: "0",
        outstandingInterest: "200000",
      }),
    ).toBe("ACTIVE");
  });

  it("becomes PAID only at exactly zero on both sides", () => {
    expect(
      deriveLifecycle("ACTIVE", {
        outstandingPrincipal: "0",
        outstandingInterest: "0",
      }),
    ).toBe("PAID");

    // A single residual peso keeps the loan open. "Close enough" does not exist.
    expect(
      deriveLifecycle("ACTIVE", {
        outstandingPrincipal: "1",
        outstandingInterest: "0",
      }),
    ).toBe("ACTIVE");
  });

  it("never revisits a terminal state from a balance check", () => {
    for (const terminal of ["PAID", "CANCELLED", "ARCHIVED"] as const) {
      expect(
        deriveLifecycle(terminal, {
          outstandingPrincipal: "500000",
          outstandingInterest: "100000",
        }),
      ).toBe(terminal);
    }
  });

  it("refuses a negative balance", () => {
    expect(() =>
      deriveLifecycle("ACTIVE", {
        outstandingPrincipal: "-1",
        outstandingInterest: "0",
      }),
    ).toThrow();
  });
});

describe("describeLoanState composes the eight states of point 17", () => {
  const zeroDebt = { outstandingPrincipal: "0", outstandingInterest: "0" };
  const withInterest = {
    outstandingPrincipal: "1000000",
    outstandingInterest: "200000",
  };

  it("labels a healthy active loan AL DÍA", () => {
    const state = describeLoanState({
      lifecycle: "ACTIVE",
      compliance: "CURRENT",
      debt: { outstandingPrincipal: "1000000", outstandingInterest: "0" },
      daysOverdue: 0,
    });
    expect(state.code).toBe("AL_DIA");
    expect(state.tone).toBe("positive");
    expect(state.explanation).toBeTruthy();
  });

  it("labels accrued-but-in-grace interest as PENDIENTE", () => {
    const state = describeLoanState({
      lifecycle: "ACTIVE",
      compliance: "DUE_SOON",
      debt: withInterest,
      daysOverdue: 0,
    });
    expect(state.code).toBe("PENDIENTE");
    expect(state.tone).toBe("warning");
  });

  it("labels a late loan VENCIDO and states the day count in words", () => {
    const state = describeLoanState({
      lifecycle: "ACTIVE",
      compliance: "OVERDUE",
      debt: withInterest,
      daysOverdue: 30,
    });
    expect(state.code).toBe("VENCIDO");
    expect(state.tone).toBe("danger");
    expect(state.explanation).toContain("30 días");

    const oneDay = describeLoanState({
      lifecycle: "ACTIVE",
      compliance: "OVERDUE",
      debt: withInterest,
      daysOverdue: 1,
    });
    expect(oneDay.explanation).toContain("1 día de atraso");
  });

  it("labels a renewal in flight EN RENOVACIÓN", () => {
    const state = describeLoanState({
      lifecycle: "ACTIVE",
      compliance: "OVERDUE",
      debt: withInterest,
      daysOverdue: 5,
      renewalInProgress: true,
    });
    expect(state.code).toBe("EN_RENOVACION");
  });

  it("labels the terminal states", () => {
    expect(
      describeLoanState({
        lifecycle: "PAID",
        compliance: "CURRENT",
        debt: zeroDebt,
        daysOverdue: 0,
      }).code,
    ).toBe("PAGADO");

    expect(
      describeLoanState({
        lifecycle: "CANCELLED",
        compliance: "CURRENT",
        debt: zeroDebt,
        daysOverdue: 0,
      }).code,
    ).toBe("CANCELADO");

    expect(
      describeLoanState({
        lifecycle: "ARCHIVED",
        compliance: "CURRENT",
        debt: zeroDebt,
        daysOverdue: 0,
      }).code,
    ).toBe("ARCHIVADO");
  });

  it("always pairs a tone with readable text (point 56)", () => {
    const cases = [
      { lifecycle: "ACTIVE", compliance: "CURRENT" },
      { lifecycle: "ACTIVE", compliance: "DUE_SOON" },
      { lifecycle: "ACTIVE", compliance: "OVERDUE" },
      { lifecycle: "PAID", compliance: "CURRENT" },
      { lifecycle: "CANCELLED", compliance: "CURRENT" },
      { lifecycle: "ARCHIVED", compliance: "CURRENT" },
    ] as const;

    for (const c of cases) {
      const state = describeLoanState({
        ...c,
        debt: withInterest,
        daysOverdue: 3,
      });
      expect(state.label.length).toBeGreaterThan(0);
      expect(state.explanation.length).toBeGreaterThan(0);
    }
  });
});

describe("aging buckets (point 79)", () => {
  it("covers every day count from 1 upward with no gaps", () => {
    for (let day = 1; day <= 200; day += 1) {
      expect(resolveAgingBucket(day)).not.toBeNull();
    }
  });

  it("places day counts in the documented ranges", () => {
    expect(resolveAgingBucket(1)!.label).toBe("1–7 días");
    expect(resolveAgingBucket(7)!.label).toBe("1–7 días");
    expect(resolveAgingBucket(8)!.label).toBe("8–15 días");
    expect(resolveAgingBucket(15)!.label).toBe("8–15 días");
    expect(resolveAgingBucket(16)!.label).toBe("16–30 días");
    expect(resolveAgingBucket(30)!.label).toBe("16–30 días");
    expect(resolveAgingBucket(31)!.label).toBe("31–60 días");
    expect(resolveAgingBucket(60)!.label).toBe("31–60 días");
    expect(resolveAgingBucket(61)!.label).toBe("61–90 días");
    expect(resolveAgingBucket(90)!.label).toBe("61–90 días");
    expect(resolveAgingBucket(91)!.label).toBe("+90 días");
    expect(resolveAgingBucket(500)!.label).toBe("+90 días");
  });

  it("returns null for a loan that is not overdue", () => {
    expect(resolveAgingBucket(0)).toBeNull();
    expect(resolveAgingBucket(-5)).toBeNull();
  });

  it("declares contiguous, non-overlapping bucket boundaries", () => {
    for (let i = 1; i < AGING_BUCKETS.length; i += 1) {
      const previous = AGING_BUCKETS[i - 1]!;
      const current = AGING_BUCKETS[i]!;
      expect(previous.toDays).not.toBeNull();
      expect(current.fromDays).toBe(previous.toDays! + 1);
    }
  });
});
