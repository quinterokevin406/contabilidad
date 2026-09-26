import { describe, expect, it } from "vitest";

import { calendarDate } from "@/core/time/calendar-date";

import {
  assessAccess,
  computeCoverage,
  nextBillingDate,
  type SubscriptionTerms,
} from "./subscription";

const base: SubscriptionTerms = {
  paidThrough: calendarDate("2026-03-05"),
  billingDay: 5,
  graceDays: 5,
  renewalBasis: "PREVIOUS_DUE_DATE",
  startedAt: calendarDate("2026-01-05"),
};

describe("assessAccess", () => {
  it("treats the paid-through day itself as still paid", () => {
    // Off by one here cuts off a customer who has paid. Cheap to get wrong,
    // expensive to explain.
    expect(assessAccess(base, calendarDate("2026-03-05")).state).toBe(
      "CURRENT",
    );
    expect(assessAccess(base, calendarDate("2026-03-05")).shouldSuspend).toBe(
      false,
    );
  });

  it("owes from the day after, without cutting off yet", () => {
    const day = assessAccess(base, calendarDate("2026-03-06"));
    expect(day.state).toBe("IN_GRACE");
    expect(day.daysPastDue).toBe(1);
    expect(day.shouldSuspend).toBe(false);
  });

  it("keeps access through the last day of grace", () => {
    const last = assessAccess(base, calendarDate("2026-03-10"));
    expect(last.state).toBe("IN_GRACE");
    expect(last.shouldSuspend).toBe(false);
  });

  it("suspends the day after grace runs out", () => {
    const over = assessAccess(base, calendarDate("2026-03-11"));
    expect(over.state).toBe("OVERDUE");
    expect(over.shouldSuspend).toBe(true);
    expect(over.cutoffOn).toBe("2026-03-10");
  });

  it("never suspends a subscription that was never billed", () => {
    const trial = assessAccess(
      { ...base, paidThrough: null },
      calendarDate("2030-01-01"),
    );
    expect(trial.state).toBe("TRIAL");
    expect(trial.shouldSuspend).toBe(false);
  });

  it("honours zero grace days", () => {
    const strict = { ...base, graceDays: 0 };
    expect(assessAccess(strict, calendarDate("2026-03-05")).state).toBe(
      "CURRENT",
    );
    expect(assessAccess(strict, calendarDate("2026-03-06")).shouldSuspend).toBe(
      true,
    );
  });
});

describe("computeCoverage", () => {
  it("continues from where the last period ended when paid on time", () => {
    const coverage = computeCoverage({
      terms: base,
      paidOn: calendarDate("2026-03-04"),
      periods: 1,
    });
    expect(coverage.from).toBe("2026-03-06");
    expect(coverage.through).toBe("2026-04-05");
  });

  it("does not reward a late payment under PREVIOUS_DUE_DATE", () => {
    // Due the 5th, paid the 20th: still only paid through the 5th of the next
    // month. The fifteen late days were used and are not sold again.
    const coverage = computeCoverage({
      terms: base,
      paidOn: calendarDate("2026-03-20"),
      periods: 1,
    });
    expect(coverage.from).toBe("2026-03-06");
    expect(coverage.through).toBe("2026-04-05");
  });

  it("gives the late days away under EFFECTIVE_DATE", () => {
    const coverage = computeCoverage({
      terms: { ...base, renewalBasis: "EFFECTIVE_DATE" },
      paidOn: calendarDate("2026-03-20"),
      periods: 1,
    });
    expect(coverage.from).toBe("2026-03-20");
    expect(coverage.through).toBe("2026-04-19");
  });

  it("starts a first payment at the subscription start, not the payment date", () => {
    const coverage = computeCoverage({
      terms: { ...base, paidThrough: null },
      paidOn: calendarDate("2026-01-20"),
      periods: 1,
    });
    expect(coverage.from).toBe("2026-01-05");
    expect(coverage.through).toBe("2026-02-04");
  });

  it("buys several periods at once", () => {
    const coverage = computeCoverage({
      terms: base,
      paidOn: calendarDate("2026-03-01"),
      periods: 3,
    });
    expect(coverage.from).toBe("2026-03-06");
    expect(coverage.through).toBe("2026-06-05");
  });

  it("keeps the billing day across a short month", () => {
    // 31 Jan + 1 month has to land on 28 Feb, not spill into March.
    const coverage = computeCoverage({
      terms: { ...base, paidThrough: calendarDate("2026-01-30") },
      paidOn: calendarDate("2026-01-29"),
      periods: 1,
    });
    expect(coverage.from).toBe("2026-01-31");
    expect(coverage.through).toBe("2026-02-27");
  });

  it("refuses a payment that buys less than a period", () => {
    expect(() =>
      computeCoverage({ terms: base, paidOn: base.startedAt, periods: 0 }),
    ).toThrow();
  });
});

describe("nextBillingDate", () => {
  it("is the day after the paid window", () => {
    expect(nextBillingDate(base, calendarDate("2026-03-01"))).toBe(
      "2026-03-06",
    );
  });

  it("is today once the bill is already late", () => {
    expect(nextBillingDate(base, calendarDate("2026-03-20"))).toBe(
      "2026-03-20",
    );
  });
});
