import Decimal from "decimal.js";

import { Money, type MoneyInput } from "@/core/money/money";

export class MetricError extends Error {}

/** Stable metric keys, matching PeriodSnapshotMetric.metricKey. */
export type MetricKey =
  | "net_margin"
  | "expense_ratio"
  | "delinquency_ratio"
  | "recovery_ratio"
  | "equity_growth"
  | "profit_growth";

/**
 * A computed ratio, with its own arithmetic attached.
 *
 * Numerator and denominator travel with the result so any percentage in the UI
 * can show where it came from. Point 72 asks for transparent indicators, not a
 * score nobody can audit.
 *
 * When the denominator is zero, `value` is null and `isComparable` is false. That
 * is the whole point of this type: point 73 forbids Infinity, NaN and a
 * misleading 0%, so the impossible case is represented in the data rather than
 * papered over at render time.
 */
export interface Ratio {
  metricKey: MetricKey;
  numerator: Decimal;
  denominator: Decimal;
  /** Percentage value, or null when the ratio is not comparable. */
  value: Decimal | null;
  isComparable: boolean;
  /** Shown verbatim to the user when not comparable. */
  notComparableReason: string | null;
}

function toDecimal(value: MoneyInput | Decimal | string): Decimal {
  if (value instanceof Decimal) return value;
  if (value instanceof Money) return value.toDecimal();
  return Money.of(value).toDecimal();
}

/**
 * Builds a percentage ratio, refusing to divide by zero.
 *
 * `useAbsoluteDenominator` matters for growth metrics: going from a loss of
 * -$1.000.000 to a profit of $500.000 is an improvement, and dividing by the raw
 * negative denominator would report it as a decline.
 */
function buildRatio(
  metricKey: MetricKey,
  numerator: Decimal,
  denominator: Decimal,
  zeroDenominatorReason: string,
  useAbsoluteDenominator = false,
): Ratio {
  const divisor = useAbsoluteDenominator ? denominator.abs() : denominator;

  if (divisor.isZero()) {
    return {
      metricKey,
      numerator,
      denominator,
      value: null,
      isComparable: false,
      notComparableReason: zeroDenominatorReason,
    };
  }

  return {
    metricKey,
    numerator,
    denominator,
    value: numerator.dividedBy(divisor).times(100),
    isComparable: true,
    notComparableReason: null,
  };
}

// --- The six metrics of point 73 -------------------------------------------

/** netProfit / operatingIncome x 100 */
export function netMargin(input: {
  netProfit: MoneyInput;
  operatingIncome: MoneyInput;
}): Ratio {
  return buildRatio(
    "net_margin",
    toDecimal(input.netProfit),
    toDecimal(input.operatingIncome),
    "No hubo ingresos operativos en el período, así que el margen no es comparable.",
  );
}

/** operatingExpenses / operatingIncome x 100 */
export function expenseRatio(input: {
  operatingExpenses: MoneyInput;
  operatingIncome: MoneyInput;
}): Ratio {
  return buildRatio(
    "expense_ratio",
    toDecimal(input.operatingExpenses),
    toDecimal(input.operatingIncome),
    "No hubo ingresos operativos en el período, así que el ratio de gastos no es comparable.",
  );
}

/** portfolioOverdue / portfolioOutstanding x 100 */
export function delinquencyRatio(input: {
  portfolioOverdue: MoneyInput;
  portfolioOutstanding: MoneyInput;
}): Ratio {
  return buildRatio(
    "delinquency_ratio",
    toDecimal(input.portfolioOverdue),
    toDecimal(input.portfolioOutstanding),
    "No hay cartera pendiente, así que no hay proporción de mora que calcular.",
  );
}

/** principalRecovered / principalScheduled x 100 */
export function recoveryRatio(input: {
  principalRecovered: MoneyInput;
  /**
   * Capital that was scheduled to come back in the period.
   *
   * On a revolving interest-only loan no capital is ever scheduled, so this is
   * legitimately zero and the ratio is reported as not comparable rather than as
   * a failure to collect.
   */
  principalScheduled: MoneyInput;
}): Ratio {
  return buildRatio(
    "recovery_ratio",
    toDecimal(input.principalRecovered),
    toDecimal(input.principalScheduled),
    "No había capital programado para recuperar en el período, así que la tasa de " +
      "recuperación no es comparable.",
  );
}

/** (closingEquity - openingEquity) / openingEquity x 100 */
export function equityGrowth(input: {
  openingEquity: MoneyInput;
  closingEquity: MoneyInput;
}): Ratio {
  const opening = toDecimal(input.openingEquity);
  const closing = toDecimal(input.closingEquity);
  return buildRatio(
    "equity_growth",
    closing.minus(opening),
    opening,
    "El patrimonio inicial era cero, así que el crecimiento porcentual no es comparable.",
    true,
  );
}

/** (currentProfit - previousProfit) / abs(previousProfit) x 100 */
export function profitGrowth(input: {
  currentProfit: MoneyInput;
  previousProfit: MoneyInput;
}): Ratio {
  const current = toDecimal(input.currentProfit);
  const previous = toDecimal(input.previousProfit);
  return buildRatio(
    "profit_growth",
    current.minus(previous),
    previous,
    "El período anterior no registró utilidad, así que el crecimiento porcentual " +
      "no es comparable.",
    true,
  );
}

// --- Variation semantics (point 71) ----------------------------------------

/**
 * What a movement in a metric means.
 *
 * CONTEXT_DEPENDENT exists because point 71 is explicit: rising expenses must not
 * be labelled bad automatically. Spending more while earning proportionally more
 * is a business growing, not a business leaking.
 */
export type VariationMeaning =
  | "FAVORABLE"
  | "UNFAVORABLE"
  | "CONTEXT_DEPENDENT"
  | "NEUTRAL";

/** Whether a higher value is better for each metric. */
const METRIC_DIRECTION: Readonly<
  Record<MetricKey, "higher_is_better" | "lower_is_better">
> = {
  net_margin: "higher_is_better",
  expense_ratio: "lower_is_better",
  delinquency_ratio: "lower_is_better",
  recovery_ratio: "higher_is_better",
  equity_growth: "higher_is_better",
  profit_growth: "higher_is_better",
};

/**
 * Metrics expressed as percentages.
 *
 * Their period-on-period change is reported in PERCENTAGE POINTS, not as a
 * percentage change. Delinquency moving from 6,5% to 10% is +3,5 points; calling
 * it "+53,8%" is technically true and practically misleading.
 */
const RATIO_METRICS: ReadonlySet<MetricKey> = new Set([
  "net_margin",
  "expense_ratio",
  "delinquency_ratio",
  "recovery_ratio",
]);

export interface Variation {
  metricKey: MetricKey;
  current: Decimal | null;
  previous: Decimal | null;
  /** Difference in percentage points for ratio metrics. */
  deltaPoints: Decimal | null;
  isComparable: boolean;
  notComparableReason: string | null;
  meaning: VariationMeaning;
  /** A statement of what the data shows. Never a claim about why. */
  message: string;
}

/**
 * Compares a metric against its previous value.
 *
 * The message states what changed and nothing more. Point 82 is explicit that the
 * system must not invent causal explanations, so this function reports movement
 * and refuses to speculate about its cause.
 */
export function compareMetric(
  metricKey: MetricKey,
  current: Ratio,
  previousValue: Decimal | number | string | null,
  labels: { name: string },
): Variation {
  const previous =
    previousValue === null || previousValue === undefined
      ? null
      : new Decimal(previousValue.toString());

  if (!current.isComparable || current.value === null) {
    return {
      metricKey,
      current: null,
      previous,
      deltaPoints: null,
      isComparable: false,
      notComparableReason: current.notComparableReason,
      meaning: "NEUTRAL",
      message: `${labels.name}: N/D. ${current.notComparableReason ?? ""}`.trim(),
    };
  }

  if (previous === null) {
    return {
      metricKey,
      current: current.value,
      previous: null,
      deltaPoints: null,
      isComparable: false,
      notComparableReason:
        "No hay un período anterior con el cual comparar este indicador.",
      meaning: "NEUTRAL",
      message: `${labels.name}: ${format(current.value)}%. Sin período anterior para comparar.`,
    };
  }

  const delta = current.value.minus(previous);
  const unit = RATIO_METRICS.has(metricKey) ? "puntos" : "%";
  const direction = METRIC_DIRECTION[metricKey];

  let meaning: VariationMeaning;
  if (delta.isZero()) {
    meaning = "NEUTRAL";
  } else if (direction === "higher_is_better") {
    meaning = delta.greaterThan(0) ? "FAVORABLE" : "UNFAVORABLE";
  } else {
    meaning = delta.greaterThan(0) ? "UNFAVORABLE" : "FAVORABLE";
  }

  const movement = delta.isZero()
    ? "se mantuvo igual"
    : delta.greaterThan(0)
      ? `aumentó ${format(delta.abs())} ${unit}`
      : `disminuyó ${format(delta.abs())} ${unit}`;

  return {
    metricKey,
    current: current.value,
    previous,
    deltaPoints: delta,
    isComparable: true,
    notComparableReason: null,
    meaning,
    message:
      `${labels.name} pasó de ${format(previous)}% a ${format(current.value)}%: ` +
      `${movement} frente al período anterior.`,
  };
}

function format(value: Decimal): string {
  return value.toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1).replace(".", ",");
}

/**
 * Judges expense growth against income growth (point 71).
 *
 * Rising expenses on their own say nothing. What matters is whether they are
 * outpacing the revenue that has to cover them, and that comparison is the only
 * honest way to call expense growth good or bad.
 */
export interface ExpenseGrowthAssessment {
  expenseGrowth: Ratio | null;
  incomeGrowth: Ratio | null;
  meaning: VariationMeaning;
  message: string;
}

export function assessExpenseGrowth(input: {
  currentExpenses: MoneyInput;
  previousExpenses: MoneyInput;
  currentIncome: MoneyInput;
  previousIncome: MoneyInput;
}): ExpenseGrowthAssessment {
  const prevExpenses = toDecimal(input.previousExpenses);
  const prevIncome = toDecimal(input.previousIncome);
  const curExpenses = toDecimal(input.currentExpenses);
  const curIncome = toDecimal(input.currentIncome);

  if (prevExpenses.isZero() || prevIncome.isZero()) {
    return {
      expenseGrowth: null,
      incomeGrowth: null,
      meaning: "NEUTRAL",
      message:
        "No hay base suficiente en el período anterior para comparar el " +
        "crecimiento de gastos con el de ingresos.",
    };
  }

  const expensePct = curExpenses.minus(prevExpenses).dividedBy(prevExpenses.abs()).times(100);
  const incomePct = curIncome.minus(prevIncome).dividedBy(prevIncome.abs()).times(100);

  const expenseGrowth: Ratio = {
    metricKey: "expense_ratio",
    numerator: curExpenses.minus(prevExpenses),
    denominator: prevExpenses,
    value: expensePct,
    isComparable: true,
    notComparableReason: null,
  };
  const incomeGrowth: Ratio = {
    metricKey: "net_margin",
    numerator: curIncome.minus(prevIncome),
    denominator: prevIncome,
    value: incomePct,
    isComparable: true,
    notComparableReason: null,
  };

  const base = `Los gastos variaron ${format(expensePct)}% y los ingresos operativos ${format(incomePct)}%.`;

  if (expensePct.greaterThan(incomePct)) {
    return {
      expenseGrowth,
      incomeGrowth,
      meaning: "UNFAVORABLE",
      message: `${base} El crecimiento del gasto fue superior al de los ingresos en este período.`,
    };
  }
  if (expensePct.lessThan(incomePct)) {
    return {
      expenseGrowth,
      incomeGrowth,
      meaning: "FAVORABLE",
      message: `${base} El crecimiento del gasto fue inferior al de los ingresos en este período.`,
    };
  }
  return {
    expenseGrowth,
    incomeGrowth,
    meaning: "NEUTRAL",
    message: `${base} Ambos variaron en la misma proporción.`,
  };
}

// --- Goals (point 85) -------------------------------------------------------

export type GoalDirection = "AT_LEAST" | "AT_MOST";

export interface GoalProgress {
  target: Decimal;
  actual: Decimal;
  /** 0 to 100, clamped. Null when the target is zero and progress is undefined. */
  percent: Decimal | null;
  isMet: boolean;
  isComparable: boolean;
  notComparableReason: string | null;
}

/**
 * Measures progress toward a configured goal.
 *
 * An AT_MOST goal is a ceiling, so progress means "how much of the allowance has
 * been used". Reporting it the same way as an AT_LEAST goal would show a business
 * blowing past its expense limit as 150% "achieved".
 */
export function measureGoal(input: {
  target: MoneyInput | Decimal;
  actual: MoneyInput | Decimal;
  direction: GoalDirection;
}): GoalProgress {
  const target = toDecimal(input.target);
  const actual = toDecimal(input.actual);

  if (target.isZero()) {
    return {
      target,
      actual,
      percent: null,
      isMet: input.direction === "AT_MOST" ? actual.lessThanOrEqualTo(0) : true,
      isComparable: false,
      notComparableReason: "La meta está en cero, así que el progreso no es comparable.",
    };
  }

  const rawPercent = actual.dividedBy(target).times(100);
  const clamped = Decimal.min(Decimal.max(rawPercent, 0), 100);

  return {
    target,
    actual,
    percent: clamped,
    isMet:
      input.direction === "AT_LEAST"
        ? actual.greaterThanOrEqualTo(target)
        : actual.lessThanOrEqualTo(target),
    isComparable: true,
    notComparableReason: null,
  };
}
