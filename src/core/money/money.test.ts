import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";

import {
  formatMoney,
  formatMoneyCompact,
  formatPercent,
  formatPercentagePoints,
  formatRate,
} from "./format";
import { Money, MoneyError } from "./money";

describe("Money construction", () => {
  it("accepts plain decimal strings", () => {
    expect(Money.of("1000000").toString()).toBe("1000000");
    expect(Money.of("1000000.55").toString()).toBe("1000000.55");
    expect(Money.of("-250000").toString()).toBe("-250000");
  });

  it("refuses number inputs, because floats lose decimal precision", () => {
    // @ts-expect-error -- rejecting `number` at the type level is the point.
    expect(() => Money.of(1000000)).toThrow(MoneyError);
  });

  it("refuses formatted strings instead of silently misreading them", () => {
    // "1.000.000" would parse as 1 peso with a fraction. Reject it loudly.
    expect(() => Money.of("1.000.000")).toThrow(MoneyError);
    expect(() => Money.of("$1000000")).toThrow(MoneyError);
    expect(() => Money.of("")).toThrow(MoneyError);
  });

  it("accepts bigint and Decimal", () => {
    expect(Money.of(1000000n).toString()).toBe("1000000");
    expect(Money.of(new Decimal("123.45")).toString()).toBe("123.45");
  });
});

describe("Money arithmetic keeps exact decimal precision", () => {
  it("does not drift the way binary floats do", () => {
    // The canonical float failure: 0.1 + 0.2 !== 0.3
    expect(Money.of("0.1").plus("0.2").equals("0.3")).toBe(true);
    expect(0.1 + 0.2 === 0.3).toBe(false);
  });

  it("survives a long chain of additions without losing a centavo", () => {
    let acc = Money.zero();
    for (let i = 0; i < 1000; i += 1) acc = acc.plus("0.01");
    expect(acc.equals("10")).toBe(true);
  });

  it("adds and subtracts", () => {
    expect(Money.of("1000000").plus("200000").toString()).toBe("1200000");
    expect(Money.of("1000000").minus("400000").toString()).toBe("600000");
  });

  it("sums a list", () => {
    expect(Money.sum(["200000", "100000", "50000"]).toString()).toBe("350000");
    expect(Money.sum([]).isZero()).toBe(true);
  });

  it("refuses division by zero", () => {
    expect(() => Money.of("1000").dividedBy(0)).toThrow(MoneyError);
  });
});

describe("percentOf implements the rate rules from points 4 and 6", () => {
  it("computes the example from the specification exactly", () => {
    // $1.000.000 at 20% per period.
    const principal = Money.of("1000000");
    const perPeriod = principal.percentOf("20");
    expect(perPeriod.toString()).toBe("200000");

    // Simple interest on the original principal: the interest per period never
    // changes, and nothing is capitalized.
    expect(perPeriod.times(1).toString()).toBe("200000");
    expect(perPeriod.times(2).toString()).toBe("400000");
    expect(perPeriod.times(3).toString()).toBe("600000");

    // Totals owed after N periods, principal untouched.
    expect(principal.plus(perPeriod.times(1)).toString()).toBe("1200000");
    expect(principal.plus(perPeriod.times(2)).toString()).toBe("1400000");
    expect(principal.plus(perPeriod.times(3)).toString()).toBe("1600000");
  });

  it("keeps sub-peso precision instead of rounding behind our back", () => {
    // 20% of $1.333.333 is 266.666,6 exactly. The engine must not decide on its
    // own what to do with that .6 -- the loan rounding rule does, later.
    expect(Money.of("1333333").percentOf("20").toString()).toBe("266666.6");
  });

  it("handles fractional rates", () => {
    expect(Money.of("1000000").percentOf("2.5").toString()).toBe("25000");
    expect(Money.of("500000").percentOf("0.5").toString()).toBe("2500");
  });
});

describe("quantize is the only place precision is given up", () => {
  const value = Money.of("266666.6");

  it("rounds to whole pesos with HALF_UP", () => {
    expect(value.quantize("1", "HALF_UP").toString()).toBe("266667");
    expect(Money.of("266666.4").quantize("1", "HALF_UP").toString()).toBe("266666");
    expect(Money.of("266666.5").quantize("1", "HALF_UP").toString()).toBe("266667");
  });

  it("rounds to whole pesos with HALF_EVEN (banker's rounding)", () => {
    // .5 goes to the nearest even integer, which removes the upward bias that
    // HALF_UP accumulates across many operations.
    expect(Money.of("266666.5").quantize("1", "HALF_EVEN").toString()).toBe("266666");
    expect(Money.of("266667.5").quantize("1", "HALF_EVEN").toString()).toBe("266668");
  });

  it("truncates toward zero with DOWN and away from zero with UP", () => {
    expect(value.quantize("1", "DOWN").toString()).toBe("266666");
    expect(value.quantize("1", "UP").toString()).toBe("266667");
    expect(Money.of("-266666.6").quantize("1", "DOWN").toString()).toBe("-266666");
    expect(Money.of("-266666.6").quantize("1", "UP").toString()).toBe("-266667");
  });

  it("supports a centavo quantum for currencies that need it", () => {
    expect(Money.of("266666.666").quantize("0.01", "HALF_UP").toString()).toBe(
      "266666.67",
    );
  });

  it("can snap to larger units, such as the nearest hundred pesos", () => {
    expect(Money.of("266666.6").quantize("100", "HALF_UP").toString()).toBe("266700");
  });

  it("refuses a non-positive quantum", () => {
    expect(() => value.quantize("0", "HALF_UP")).toThrow(MoneyError);
    expect(() => value.quantize("-1", "HALF_UP")).toThrow(MoneyError);
  });
});

describe("comparison and capping helpers", () => {
  it("compares", () => {
    const a = Money.of("200000");
    const b = Money.of("300000");
    expect(a.lessThan(b)).toBe(true);
    expect(b.greaterThan(a)).toBe(true);
    expect(a.equals("200000")).toBe(true);
    expect(a.greaterThanOrEqual("200000")).toBe(true);
    expect(a.lessThanOrEqual("200000")).toBe(true);
  });

  it("reports sign", () => {
    expect(Money.zero().isZero()).toBe(true);
    expect(Money.of("1").isPositive()).toBe(true);
    expect(Money.of("-1").isNegative()).toBe(true);
  });

  it("caps with min, which is how a partial payment stops at the debt", () => {
    // Interest owed 200.000, client hands over 100.000: apply only 100.000.
    expect(Money.min("200000", "100000").toString()).toBe("100000");
    // Client hands over 300.000 against 200.000 of interest: cap at 200.000 and
    // let the caller route the rest to principal.
    expect(Money.min("200000", "300000").toString()).toBe("200000");
    expect(Money.max("200000", "300000").toString()).toBe("300000");
  });
});

describe("persistence form", () => {
  it("emits a fixed 2-decimal string matching NUMERIC(18,2)", () => {
    expect(Money.of("1000000").toDatabaseString()).toBe("1000000.00");
    expect(Money.of("1000000.5").toDatabaseString()).toBe("1000000.50");
    expect(Money.zero().toDatabaseString()).toBe("0.00");
  });

  it("refuses to persist a value the column cannot hold", () => {
    // Truncating silently on the way to the database is exactly the bug this
    // type exists to prevent.
    expect(() => Money.of("266666.666").toDatabaseString()).toThrow(MoneyError);
  });
});

describe("formatMoney follows the Colombian convention from point 2", () => {
  it("renders whole pesos with dot separators and no space after the symbol", () => {
    expect(formatMoney("1000000")).toBe("$1.000.000");
    expect(formatMoney("250000")).toBe("$250.000");
    expect(formatMoney("35500000")).toBe("$35.500.000");
    expect(formatMoney("0")).toBe("$0");
  });

  it("hides decimals when there are none, and shows them when there are", () => {
    expect(formatMoney("1000000")).toBe("$1.000.000");
    expect(formatMoney("1000000.55")).toBe("$1.000.000,55");
  });

  it("can force or suppress decimals", () => {
    expect(formatMoney("1000000", { decimals: "always" })).toBe("$1.000.000,00");
    expect(formatMoney("1000000.55", { decimals: "never" })).toBe("$1.000.001");
  });

  it("puts the sign in front of the symbol, consistently", () => {
    expect(formatMoney("-150000")).toBe("-$150.000");
    expect(formatMoney("150000", { signed: true })).toBe("+$150.000");
    expect(formatMoney("0", { signed: true })).toBe("$0");
  });

  it("can drop the symbol for table columns", () => {
    expect(formatMoney("1000000", { showSymbol: false })).toBe("1.000.000");
  });
});

describe("formatMoneyCompact", () => {
  it("abbreviates for chart axes", () => {
    expect(formatMoneyCompact("1200000")).toBe("$1,2 M");
    expect(formatMoneyCompact("850000")).toBe("$850 K");
    expect(formatMoneyCompact("35500000")).toBe("$36 M");
    expect(formatMoneyCompact("500")).toBe("$500");
    expect(formatMoneyCompact("-1200000")).toBe("-$1,2 M");
  });
});

describe("formatRate never lets a period be ambiguous (point 6)", () => {
  it("always states the period alongside the rate", () => {
    expect(formatRate("20", "MONTHLY")).toBe("20% mensual");
    expect(formatRate("5", "WEEKLY")).toBe("5% semanal");
    expect(formatRate("0.5", "DAILY")).toBe("0,5% diario");
    expect(formatRate("10", "BIWEEKLY")).toBe("10% quincenal");
  });

  it("spells out a custom period in days", () => {
    expect(formatRate("7", "CUSTOM", { customPeriodDays: 45 })).toBe(
      "7% cada 45 días",
    );
  });
});

describe("percentage rendering refuses to mislead (point 73)", () => {
  it("renders N/D instead of Infinity or NaN", () => {
    expect(formatPercent(null)).toBe("N/D");
    expect(formatPercent(undefined)).toBe("N/D");
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe("N/D");
    expect(formatPercent(Number.NaN)).toBe("N/D");
  });

  it("renders ordinary percentages", () => {
    expect(formatPercent("14.2")).toBe("14,2%");
    expect(formatPercent("10")).toBe("10,0%");
    expect(formatPercent("14.2", { signed: true })).toBe("+14,2%");
    expect(formatPercent("-3.2")).toBe("-3,2%");
  });

  it("reports a ratio change in percentage points, not as a percent of a percent", () => {
    // Delinquency moving 6,5% -> 10% is +3,5 points. Calling it "+53,8%" is
    // technically true and practically misleading.
    expect(formatPercentagePoints("3.5")).toBe("+3,5 puntos");
    expect(formatPercentagePoints("-2.1")).toBe("-2,1 puntos");
    expect(formatPercentagePoints("1")).toBe("+1,0 puntos");
    expect(formatPercentagePoints(null)).toBe("N/D");
  });
});
