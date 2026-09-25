import { describe, expect, it } from "vitest";

import {
  addDays,
  addMonths,
  calendarDate,
  CalendarDateError,
  compareCalendarDates,
  differenceInDays,
  endOfIsoWeek,
  endOfMonth,
  fromPrismaDate,
  isoWeek,
  isoWeekday,
  startOfIsoWeek,
  startOfMonth,
  toBusinessDate,
  todayIn,
  toPrismaDate,
} from "./calendar-date";
import {
  describeDueDistance,
  formatDate,
  formatDateLong,
  formatDateShort,
  formatMonthUpper,
} from "./format";
import {
  advanceByPeriod,
  buildDueDates,
  elapsedPeriods,
  PeriodError,
  periodicityLabel,
  resolvePeriodDays,
  type PeriodRule,
} from "./period";

const d = calendarDate;

describe("CalendarDate validation", () => {
  it("accepts real dates", () => {
    expect(d("2026-09-24")).toBe("2026-09-24");
    expect(d("2024-02-29")).toBe("2024-02-29");
  });

  it("rejects malformed and impossible dates", () => {
    expect(() => d("24/09/2026")).toThrow(CalendarDateError);
    expect(() => d("2026-9-24")).toThrow(CalendarDateError);
    expect(() => d("2026-13-01")).toThrow(CalendarDateError);
    expect(() => d("2026-02-30")).toThrow(CalendarDateError);
    // 2026 is not a leap year.
    expect(() => d("2026-02-29")).toThrow(CalendarDateError);
  });
});

describe("day arithmetic is immune to the host time zone", () => {
  it("adds and subtracts days across month and year boundaries", () => {
    expect(addDays(d("2026-09-24"), 7)).toBe("2026-10-01");
    expect(addDays(d("2026-12-31"), 1)).toBe("2027-01-01");
    expect(addDays(d("2027-01-01"), -1)).toBe("2026-12-31");
  });

  it("counts whole days between dates", () => {
    expect(differenceInDays(d("2026-09-24"), d("2026-10-24"))).toBe(30);
    expect(differenceInDays(d("2026-10-24"), d("2026-09-24"))).toBe(-30);
    expect(differenceInDays(d("2026-09-24"), d("2026-09-24"))).toBe(0);
  });

  it("compares chronologically", () => {
    expect(compareCalendarDates(d("2026-09-24"), d("2026-10-24"))).toBe(-1);
    expect(compareCalendarDates(d("2026-10-24"), d("2026-09-24"))).toBe(1);
    expect(compareCalendarDates(d("2026-09-24"), d("2026-09-24"))).toBe(0);
  });
});

describe("addMonths clamps to the end of the target month", () => {
  it("walks the same day of month when it exists", () => {
    // The example from the specification.
    expect(addMonths(d("2026-09-24"), 1)).toBe("2026-10-24");
    expect(addMonths(d("2026-09-24"), 2)).toBe("2026-11-24");
    expect(addMonths(d("2026-09-24"), 3)).toBe("2026-12-24");
  });

  it("clamps 31 January to the last day of February instead of spilling", () => {
    expect(addMonths(d("2026-01-31"), 1)).toBe("2026-02-28");
    expect(addMonths(d("2024-01-31"), 1)).toBe("2024-02-29");
    expect(addMonths(d("2026-03-31"), 1)).toBe("2026-04-30");
  });

  it("crosses year boundaries in both directions", () => {
    expect(addMonths(d("2026-12-24"), 1)).toBe("2027-01-24");
    expect(addMonths(d("2026-01-24"), -1)).toBe("2025-12-24");
    expect(addMonths(d("2026-01-24"), -13)).toBe("2024-12-24");
  });
});

describe("month and week boundaries", () => {
  it("finds month edges", () => {
    expect(startOfMonth(d("2026-09-24"))).toBe("2026-09-01");
    expect(endOfMonth(d("2026-09-24"))).toBe("2026-09-30");
    expect(endOfMonth(d("2026-02-10"))).toBe("2026-02-28");
    expect(endOfMonth(d("2024-02-10"))).toBe("2024-02-29");
  });

  it("finds ISO week edges (Monday to Sunday)", () => {
    // 24/09/2026 is a Thursday.
    expect(isoWeekday(d("2026-09-24"))).toBe(4);
    expect(startOfIsoWeek(d("2026-09-24"))).toBe("2026-09-21");
    expect(endOfIsoWeek(d("2026-09-24"))).toBe("2026-09-27");
  });

  it("computes ISO week numbers", () => {
    expect(isoWeek(d("2026-09-24"))).toEqual({ year: 2026, week: 39 });
    expect(isoWeek(d("2026-01-01"))).toEqual({ year: 2026, week: 1 });
  });
});

describe("time zone boundary", () => {
  it("resolves the business date in America/Bogota, not in UTC", () => {
    // 25/09/2026 02:00 UTC is still 24/09 at 21:00 in Bogota (UTC-5). A system
    // that trusted the server clock would file this payment on the wrong day.
    const instant = new Date("2026-09-25T02:00:00Z");
    expect(toBusinessDate(instant, "America/Bogota")).toBe("2026-09-24");
    expect(toBusinessDate(instant, "UTC")).toBe("2026-09-25");
  });

  it("resolves today in a given zone", () => {
    const instant = new Date("2026-09-24T14:30:00Z");
    expect(todayIn("America/Bogota", instant)).toBe("2026-09-24");
  });
});

describe("Prisma date boundary round-trips", () => {
  it("survives the trip to a @db.Date column and back", () => {
    const original = d("2026-09-24");
    const stored = toPrismaDate(original);
    expect(stored.toISOString()).toBe("2026-09-24T00:00:00.000Z");
    expect(fromPrismaDate(stored)).toBe(original);
  });
});

describe("period advancement", () => {
  const monthlyCalendar: PeriodRule = {
    periodicity: "MONTHLY",
    anchor: "CALENDAR",
  };

  it("resolves the day count of each fixed periodicity", () => {
    expect(resolvePeriodDays({ periodicity: "DAILY", anchor: "FIXED_DAYS" })).toBe(1);
    expect(resolvePeriodDays({ periodicity: "WEEKLY", anchor: "FIXED_DAYS" })).toBe(7);
    expect(resolvePeriodDays({ periodicity: "BIWEEKLY", anchor: "FIXED_DAYS" })).toBe(15);
    expect(resolvePeriodDays({ periodicity: "MONTHLY", anchor: "FIXED_DAYS" })).toBe(30);
  });

  it("requires a positive day count for a CUSTOM periodicity", () => {
    expect(() =>
      resolvePeriodDays({ periodicity: "CUSTOM", anchor: "FIXED_DAYS" }),
    ).toThrow(PeriodError);
    expect(() =>
      resolvePeriodDays({
        periodicity: "CUSTOM",
        anchor: "FIXED_DAYS",
        customPeriodDays: 0,
      }),
    ).toThrow(PeriodError);
    expect(
      resolvePeriodDays({
        periodicity: "CUSTOM",
        anchor: "FIXED_DAYS",
        customPeriodDays: 45,
      }),
    ).toBe(45);
  });

  it("walks calendar months for a MONTHLY loan anchored to CALENDAR", () => {
    expect(advanceByPeriod(d("2026-09-24"), monthlyCalendar)).toBe("2026-10-24");
    expect(advanceByPeriod(d("2026-09-24"), monthlyCalendar, 3)).toBe("2026-12-24");
  });

  it("walks 30 days for a MONTHLY loan anchored to FIXED_DAYS", () => {
    const rule: PeriodRule = { periodicity: "MONTHLY", anchor: "FIXED_DAYS" };
    expect(advanceByPeriod(d("2026-09-24"), rule)).toBe("2026-10-24");
    // The two anchors diverge across a 31-day month, which is exactly why the
    // choice is stored per loan.
    expect(advanceByPeriod(d("2026-01-24"), rule)).toBe("2026-02-23");
    expect(advanceByPeriod(d("2026-01-24"), monthlyCalendar)).toBe("2026-02-24");
  });

  it("walks days for the day-count periodicities", () => {
    expect(
      advanceByPeriod(d("2026-09-24"), { periodicity: "WEEKLY", anchor: "CALENDAR" }),
    ).toBe("2026-10-01");
    expect(
      advanceByPeriod(d("2026-09-24"), { periodicity: "BIWEEKLY", anchor: "CALENDAR" }),
    ).toBe("2026-10-09");
    expect(
      advanceByPeriod(d("2026-09-24"), { periodicity: "DAILY", anchor: "CALENDAR" }),
    ).toBe("2026-09-25");
  });
});

describe("buildDueDates anchors every date to the original, not to its predecessor", () => {
  it("produces the monthly schedule from the specification", () => {
    expect(buildDueDates(d("2026-10-24"), { periodicity: "MONTHLY", anchor: "CALENDAR" }, 4))
      .toEqual(["2026-10-24", "2026-11-24", "2026-12-24", "2027-01-24"]);
  });

  it("recovers the day of month after a clamped February", () => {
    // 31/01 -> 28/02 -> 31/03. Deriving each date from its predecessor would
    // drag the whole schedule back to the 28th forever.
    expect(buildDueDates(d("2026-01-31"), { periodicity: "MONTHLY", anchor: "CALENDAR" }, 4))
      .toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });
});

describe("elapsedPeriods", () => {
  const monthly: PeriodRule = { periodicity: "MONTHLY", anchor: "CALENDAR" };

  it("counts only whole elapsed periods", () => {
    expect(elapsedPeriods(d("2026-09-24"), d("2026-09-24"), monthly)).toBe(0);
    expect(elapsedPeriods(d("2026-09-24"), d("2026-10-23"), monthly)).toBe(0);
    expect(elapsedPeriods(d("2026-09-24"), d("2026-10-24"), monthly)).toBe(1);
    expect(elapsedPeriods(d("2026-09-24"), d("2026-12-24"), monthly)).toBe(3);
  });

  it("never returns a negative count", () => {
    expect(elapsedPeriods(d("2026-10-24"), d("2026-09-24"), monthly)).toBe(0);
  });

  it("counts day-based periods by division", () => {
    const weekly: PeriodRule = { periodicity: "WEEKLY", anchor: "FIXED_DAYS" };
    expect(elapsedPeriods(d("2026-09-24"), d("2026-10-15"), weekly)).toBe(3);
    expect(elapsedPeriods(d("2026-09-24"), d("2026-10-14"), weekly)).toBe(2);
  });
});

describe("date formatting follows the Colombian convention", () => {
  it("renders dd/MM/yyyy", () => {
    expect(formatDate(d("2026-09-24"))).toBe("24/09/2026");
    expect(formatDate(d("2026-01-05"))).toBe("05/01/2026");
  });

  it("renders short and long forms", () => {
    expect(formatDateShort(d("2026-09-24"))).toBe("24 SEP");
    expect(formatDateLong(d("2026-09-24"))).toBe("24 de septiembre de 2026");
    expect(formatMonthUpper(2026, 9)).toBe("SEPTIEMBRE 2026");
  });

  it("labels periodicities", () => {
    expect(periodicityLabel({ periodicity: "MONTHLY", anchor: "CALENDAR" })).toBe(
      "Mensual",
    );
    expect(
      periodicityLabel({
        periodicity: "CUSTOM",
        anchor: "FIXED_DAYS",
        customPeriodDays: 45,
      }),
    ).toBe("Cada 45 días");
  });
});

describe("describeDueDistance always yields text, never only a colour", () => {
  const today = d("2026-10-24");

  it("describes overdue loans", () => {
    expect(describeDueDistance(d("2026-10-23"), today)).toEqual({
      days: -1,
      label: "1 día vencido",
      tone: "overdue",
    });
    expect(describeDueDistance(d("2026-09-24"), today).label).toBe("30 días vencidos");
  });

  it("describes today and tomorrow", () => {
    expect(describeDueDistance(today, today).label).toBe("Vence hoy");
    expect(describeDueDistance(d("2026-10-25"), today).label).toBe("Vence mañana");
  });

  it("separates soon from future using the configured lead time", () => {
    expect(describeDueDistance(d("2026-10-27"), today).tone).toBe("soon");
    expect(describeDueDistance(d("2026-10-30"), today).tone).toBe("future");
    expect(
      describeDueDistance(d("2026-10-30"), today, { dueSoonLeadDays: 10 }).tone,
    ).toBe("soon");
  });
});
