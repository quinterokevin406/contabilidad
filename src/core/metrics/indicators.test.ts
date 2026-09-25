import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";

import {
  assessExpenseGrowth,
  compareMetric,
  delinquencyRatio,
  equityGrowth,
  expenseRatio,
  measureGoal,
  netMargin,
  profitGrowth,
  recoveryRatio,
} from "./indicators";

describe("the six metrics of point 73", () => {
  it("computes net margin", () => {
    const ratio = netMargin({ netProfit: "5800000", operatingIncome: "7900000" });
    expect(ratio.isComparable).toBe(true);
    expect(ratio.value!.toDecimalPlaces(2).toString()).toBe("73.42");
  });

  it("computes the expense ratio", () => {
    const ratio = expenseRatio({
      operatingExpenses: "2100000",
      operatingIncome: "7900000",
    });
    expect(ratio.value!.toDecimalPlaces(2).toString()).toBe("26.58");
  });

  it("computes the delinquency ratio from the example in point 70", () => {
    // Cartera vencida $3.400.000 sobre cartera pendiente $34.000.000 = 10%.
    const ratio = delinquencyRatio({
      portfolioOverdue: "3400000",
      portfolioOutstanding: "34000000",
    });
    expect(ratio.value!.toString()).toBe("10");
  });

  it("computes the recovery ratio", () => {
    const ratio = recoveryRatio({
      principalRecovered: "8000000",
      principalScheduled: "10000000",
    });
    expect(ratio.value!.toString()).toBe("80");
  });

  it("computes equity growth from the example in point 70", () => {
    // $40.000.000 -> $43.200.000 is +8%.
    const ratio = equityGrowth({
      openingEquity: "40000000",
      closingEquity: "43200000",
    });
    expect(ratio.value!.toString()).toBe("8");
  });

  it("computes profit growth", () => {
    const ratio = profitGrowth({
      currentProfit: "5800000",
      previousProfit: "5078000",
    });
    expect(ratio.value!.toDecimalPlaces(1).toString()).toBe("14.2");
  });

  it("carries its own arithmetic so the UI can show the formula", () => {
    const ratio = netMargin({ netProfit: "5800000", operatingIncome: "7900000" });
    expect(ratio.numerator.toString()).toBe("5800000");
    expect(ratio.denominator.toString()).toBe("7900000");
    expect(ratio.metricKey).toBe("net_margin");
  });
});

describe("a zero denominator is never Infinity, NaN or a misleading 0%", () => {
  it("reports net margin as not comparable with no income", () => {
    const ratio = netMargin({ netProfit: "500000", operatingIncome: "0" });
    expect(ratio.isComparable).toBe(false);
    expect(ratio.value).toBeNull();
    expect(ratio.notComparableReason).toContain("ingresos operativos");
  });

  it("reports the expense ratio as not comparable with no income", () => {
    const ratio = expenseRatio({ operatingExpenses: "500000", operatingIncome: "0" });
    expect(ratio.value).toBeNull();
    expect(ratio.isComparable).toBe(false);
  });

  it("reports delinquency as not comparable with no portfolio", () => {
    const ratio = delinquencyRatio({
      portfolioOverdue: "0",
      portfolioOutstanding: "0",
    });
    expect(ratio.value).toBeNull();
    expect(ratio.notComparableReason).toContain("cartera pendiente");
  });

  it("reports recovery as not comparable when no capital was scheduled", () => {
    // This is the revolving interest-only case from the specification: no capital
    // is ever scheduled, so a 0% recovery rate would be a lie.
    const ratio = recoveryRatio({
      principalRecovered: "0",
      principalScheduled: "0",
    });
    expect(ratio.value).toBeNull();
    expect(ratio.notComparableReason).toContain("capital programado");
  });

  it("reports equity growth as not comparable from a zero base", () => {
    const ratio = equityGrowth({ openingEquity: "0", closingEquity: "5000000" });
    expect(ratio.value).toBeNull();
    expect(ratio.notComparableReason).toContain("patrimonio inicial");
  });

  it("reports profit growth as not comparable from a zero base", () => {
    const ratio = profitGrowth({ currentProfit: "5000000", previousProfit: "0" });
    expect(ratio.value).toBeNull();
  });
});

describe("growth metrics use the absolute previous value", () => {
  it("reports recovery from a loss as growth, not as a decline", () => {
    // From -$1.000.000 to +$500.000 is an improvement of 1.500.000. Dividing by
    // the raw negative denominator would report -150%, which inverts the truth.
    const ratio = profitGrowth({
      currentProfit: "500000",
      previousProfit: "-1000000",
    });
    expect(ratio.value!.toString()).toBe("150");
  });

  it("reports a deepening loss as negative growth", () => {
    const ratio = profitGrowth({
      currentProfit: "-2000000",
      previousProfit: "-1000000",
    });
    expect(ratio.value!.toString()).toBe("-100");
  });
});

describe("variation meaning (point 71)", () => {
  it("treats a rising margin as favorable and a falling one as unfavorable", () => {
    const up = compareMetric(
      "net_margin",
      netMargin({ netProfit: "5800000", operatingIncome: "7900000" }),
      new Decimal("65"),
      { name: "Margen neto" },
    );
    expect(up.meaning).toBe("FAVORABLE");
    expect(up.deltaPoints!.toDecimalPlaces(2).toString()).toBe("8.42");

    const down = compareMetric(
      "net_margin",
      netMargin({ netProfit: "5800000", operatingIncome: "7900000" }),
      new Decimal("80"),
      { name: "Margen neto" },
    );
    expect(down.meaning).toBe("UNFAVORABLE");
  });

  it("treats rising delinquency as unfavorable", () => {
    const variation = compareMetric(
      "delinquency_ratio",
      delinquencyRatio({
        portfolioOverdue: "3400000",
        portfolioOutstanding: "34000000",
      }),
      new Decimal("6.5"),
      { name: "Morosidad" },
    );
    expect(variation.meaning).toBe("UNFAVORABLE");
    expect(variation.deltaPoints!.toString()).toBe("3.5");
    // Point 71: a ratio change is reported in percentage points.
    expect(variation.message).toContain("puntos");
    expect(variation.message).toContain("6,5%");
    expect(variation.message).toContain("10,0%");
  });

  it("treats falling delinquency as favorable", () => {
    const variation = compareMetric(
      "delinquency_ratio",
      delinquencyRatio({
        portfolioOverdue: "1700000",
        portfolioOutstanding: "34000000",
      }),
      new Decimal("10"),
      { name: "Morosidad" },
    );
    expect(variation.meaning).toBe("FAVORABLE");
  });

  it("reports no change as neutral", () => {
    const variation = compareMetric(
      "delinquency_ratio",
      delinquencyRatio({
        portfolioOverdue: "3400000",
        portfolioOutstanding: "34000000",
      }),
      new Decimal("10"),
      { name: "Morosidad" },
    );
    expect(variation.meaning).toBe("NEUTRAL");
    expect(variation.message).toContain("se mantuvo igual");
  });

  it("stays neutral and explains itself when the metric is not comparable", () => {
    const variation = compareMetric(
      "net_margin",
      netMargin({ netProfit: "0", operatingIncome: "0" }),
      new Decimal("65"),
      { name: "Margen neto" },
    );
    expect(variation.isComparable).toBe(false);
    expect(variation.meaning).toBe("NEUTRAL");
    expect(variation.message).toContain("N/D");
  });

  it("stays neutral when there is no previous period", () => {
    const variation = compareMetric(
      "net_margin",
      netMargin({ netProfit: "5800000", operatingIncome: "7900000" }),
      null,
      { name: "Margen neto" },
    );
    expect(variation.isComparable).toBe(false);
    expect(variation.notComparableReason).toContain("período anterior");
  });

  it("never claims WHY a metric moved", () => {
    const variation = compareMetric(
      "delinquency_ratio",
      delinquencyRatio({
        portfolioOverdue: "3400000",
        portfolioOutstanding: "34000000",
      }),
      new Decimal("6.5"),
      { name: "Morosidad" },
    );
    // Point 82: state what the data shows, never invent a cause.
    for (const causal of ["porque", "debido a", "a causa de"]) {
      expect(variation.message.toLowerCase()).not.toContain(causal);
    }
  });
});

describe("expense growth is judged against income growth, never alone", () => {
  it("flags expenses outpacing income as unfavorable", () => {
    // Expenses +19,3% while income +8,5%.
    const assessment = assessExpenseGrowth({
      previousExpenses: "1760000",
      currentExpenses: "2100000",
      previousIncome: "7280000",
      currentIncome: "7900000",
    });
    expect(assessment.meaning).toBe("UNFAVORABLE");
    expect(assessment.message).toContain("superior");
  });

  it("treats expenses growing slower than income as favorable", () => {
    const assessment = assessExpenseGrowth({
      previousExpenses: "2000000",
      currentExpenses: "2100000",
      previousIncome: "5000000",
      currentIncome: "7900000",
    });
    expect(assessment.meaning).toBe("FAVORABLE");
    expect(assessment.message).toContain("inferior");
  });

  it("does not call rising expenses bad on their own", () => {
    // Expenses doubled. So did income. That is a business growing.
    const assessment = assessExpenseGrowth({
      previousExpenses: "1000000",
      currentExpenses: "2000000",
      previousIncome: "4000000",
      currentIncome: "8000000",
    });
    expect(assessment.meaning).toBe("NEUTRAL");
    expect(assessment.message).toContain("misma proporción");
  });

  it("refuses to compare without a base period", () => {
    const assessment = assessExpenseGrowth({
      previousExpenses: "0",
      currentExpenses: "2000000",
      previousIncome: "4000000",
      currentIncome: "8000000",
    });
    expect(assessment.meaning).toBe("NEUTRAL");
    expect(assessment.message).toContain("No hay base suficiente");
  });
});

describe("goal progress (point 85)", () => {
  it("measures an AT_LEAST goal", () => {
    // META CAPITAL $100.000.000, actual $43.200.000 -> 43,2%
    const progress = measureGoal({
      target: "100000000",
      actual: "43200000",
      direction: "AT_LEAST",
    });
    expect(progress.percent!.toDecimalPlaces(1).toString()).toBe("43.2");
    expect(progress.isMet).toBe(false);
  });

  it("marks an AT_LEAST goal met when reached", () => {
    const progress = measureGoal({
      target: "100000000",
      actual: "100000000",
      direction: "AT_LEAST",
    });
    expect(progress.isMet).toBe(true);
    expect(progress.percent!.toString()).toBe("100");
  });

  it("clamps progress at 100 instead of showing 150% achieved", () => {
    const progress = measureGoal({
      target: "100000000",
      actual: "150000000",
      direction: "AT_LEAST",
    });
    expect(progress.percent!.toString()).toBe("100");
    expect(progress.isMet).toBe(true);
  });

  it("treats an AT_MOST goal as a ceiling, not an achievement", () => {
    // Expense limit $2.000.000, actual $2.100.000: the limit was breached.
    const breached = measureGoal({
      target: "2000000",
      actual: "2100000",
      direction: "AT_MOST",
    });
    expect(breached.isMet).toBe(false);
    // Progress is the allowance consumed, capped at 100.
    expect(breached.percent!.toString()).toBe("100");

    const within = measureGoal({
      target: "2000000",
      actual: "1500000",
      direction: "AT_MOST",
    });
    expect(within.isMet).toBe(true);
    expect(within.percent!.toString()).toBe("75");
  });

  it("reports a zero target as not comparable", () => {
    const progress = measureGoal({
      target: "0",
      actual: "100",
      direction: "AT_LEAST",
    });
    expect(progress.percent).toBeNull();
    expect(progress.isComparable).toBe(false);
  });

  it("never reports negative progress", () => {
    const progress = measureGoal({
      target: "100000000",
      actual: "-5000000",
      direction: "AT_LEAST",
    });
    expect(progress.percent!.toString()).toBe("0");
  });
});
