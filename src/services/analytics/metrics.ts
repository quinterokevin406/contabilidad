import type Decimal from "decimal.js";

import {
  delinquencyRatio,
  equityGrowth,
  expenseRatio,
  netMargin,
  profitGrowth,
  recoveryRatio,
  type MetricKey,
  type Ratio,
} from "@/core/metrics/indicators";
import { Money } from "@/core/money/money";
import { toPrismaDate, type CalendarDate } from "@/core/time/calendar-date";
import { fromDb } from "@/infra/db/money";

import type { Tx } from "../shared";
import type { SnapshotFigures, SnapshotKind } from "./snapshot";

/**
 * The six metrics of point 73, computed for a snapshot and stored beside it.
 *
 * Each row keeps its numerator and denominator, so any percentage in the UI can
 * show the arithmetic that produced it. A zero denominator stores value = null
 * and a human reason rather than Infinity, NaN or a misleading 0%.
 */

export interface MetricInput {
  figures: SnapshotFigures;
  /** The immediately preceding CLOSED snapshot, when one exists. */
  previous: {
    netProfitCash: Money;
    metrics: Map<MetricKey, Decimal | null>;
  } | null;
  /**
   * Capital contractually due back inside the period.
   *
   * On a revolving interest-only loan no capital is ever scheduled, so this is
   * legitimately zero and the recovery ratio reports "N/D" rather than a 0%
   * that would read as a total failure to collect.
   */
  principalScheduled: Money;
}

export function computeMetrics(input: MetricInput): Ratio[] {
  const { figures } = input;
  const operatingIncome = figures.interestCollected.plus(figures.otherIncome);

  return [
    netMargin({
      netProfit: figures.netProfitCash,
      operatingIncome,
    }),
    expenseRatio({
      operatingExpenses: figures.operatingExpenses,
      operatingIncome,
    }),
    delinquencyRatio({
      portfolioOverdue: figures.portfolioOverdue,
      portfolioOutstanding: figures.portfolioOutstanding,
    }),
    recoveryRatio({
      principalRecovered: figures.principalRecovered,
      principalScheduled: input.principalScheduled,
    }),
    equityGrowth({
      openingEquity: figures.openingEquity,
      closingEquity: figures.closingEquity,
    }),
    profitGrowth({
      currentProfit: figures.netProfitCash,
      previousProfit: input.previous?.netProfitCash ?? Money.zero(),
    }),
  ];
}

/**
 * Capital contractually due back inside a window.
 *
 * Only loans with a stated maturity date owe principal on a schedule. A
 * revolving loan renewed month after month never does, and counting it here
 * would invent an obligation the contract never created.
 */
export async function principalScheduledOver(
  tx: Tx,
  organizationId: string,
  from: CalendarDate,
  to: CalendarDate,
): Promise<Money> {
  const loans = await tx.loan.findMany({
    where: {
      organizationId,
      maturityOn: { gte: toPrismaDate(from), lte: toPrismaDate(to) },
    },
    select: { originalPrincipal: true },
  });

  return Money.sum(loans.map((l) => fromDb(l.originalPrincipal)));
}

/** Persists the metric rows for a snapshot, replacing any previous computation. */
export async function storeMetrics(
  tx: Tx,
  organizationId: string,
  snapshotId: string,
  metrics: Ratio[],
  previous: Map<MetricKey, Decimal | null> | null,
): Promise<void> {
  await tx.periodSnapshotMetric.deleteMany({ where: { snapshotId } });

  for (const metric of metrics) {
    const previousValue = previous?.get(metric.metricKey) ?? null;

    await tx.periodSnapshotMetric.create({
      data: {
        organizationId,
        snapshotId,
        metricKey: metric.metricKey,
        numerator: metric.numerator.toFixed(2),
        denominator: metric.denominator.toFixed(2),
        value: metric.value ? metric.value.toFixed(4) : null,
        isComparable: metric.isComparable,
        notComparableReason: metric.notComparableReason,
        previousValue: previousValue ? previousValue.toFixed(4) : null,
      },
    });
  }
}

/** Loads the closed snapshot immediately before a period, with its metrics. */
export async function loadPreviousSnapshot(
  tx: Tx,
  organizationId: string,
  kind: SnapshotKind,
  periodStart: CalendarDate,
): Promise<MetricInput["previous"]> {
  const previous = await tx.periodSnapshot.findFirst({
    where: {
      organizationId,
      kind,
      status: "CLOSED",
      periodStart: { lt: toPrismaDate(periodStart) },
    },
    orderBy: { periodStart: "desc" },
    select: {
      netProfitCash: true,
      metrics: { select: { metricKey: true, value: true } },
    },
  });

  if (!previous) return null;

  const metrics = new Map<MetricKey, Decimal | null>();
  for (const metric of previous.metrics) {
    metrics.set(
      metric.metricKey as MetricKey,
      metric.value ? (metric.value as unknown as Decimal) : null,
    );
  }

  return {
    netProfitCash: fromDb(previous.netProfitCash),
    metrics,
  };
}

/**
 * Data-only observations for the executive summary (point 82).
 *
 * Every sentence states what the data shows and stops there. The specification
 * is explicit that the system must not invent causal explanations, so nothing
 * here says WHY anything moved — only that it did, by how much, and in which
 * direction.
 */
export interface Observation {
  text: string;
  meaning: "FAVORABLE" | "UNFAVORABLE" | "NEUTRAL";
}

export function buildObservations(
  figures: SnapshotFigures,
  previous: {
    netProfitCash: Money;
    operatingExpenses: Money;
    interestCollected: Money;
    otherIncome: Money;
    portfolioOverdue: Money;
    portfolioOutstanding: Money;
  } | null,
): Observation[] {
  const observations: Observation[] = [];

  observations.push({
    text:
      `La utilidad neta del período fue ${figures.netProfitCash.toDatabaseString()}, ` +
      `con ${figures.interestCollected.toDatabaseString()} de intereses cobrados y ` +
      `${figures.operatingExpenses.toDatabaseString()} de gastos operativos.`,
    meaning: figures.netProfitCash.isNegative() ? "UNFAVORABLE" : "NEUTRAL",
  });

  if (!previous) {
    observations.push({
      text: "No hay un período anterior cerrado con el cual comparar.",
      meaning: "NEUTRAL",
    });
    return observations;
  }

  const profitDelta = figures.netProfitCash.minus(previous.netProfitCash);
  if (!profitDelta.isZero()) {
    observations.push({
      text:
        `La utilidad neta ${profitDelta.isPositive() ? "aumentó" : "disminuyó"} ` +
        `${profitDelta.abs().toDatabaseString()} frente al período anterior.`,
      meaning: profitDelta.isPositive() ? "FAVORABLE" : "UNFAVORABLE",
    });
  }

  // Point 71: rising expenses are judged against income, never on their own.
  const currentIncome = figures.interestCollected.plus(figures.otherIncome);
  const previousIncome = previous.interestCollected.plus(previous.otherIncome);

  if (previousIncome.isPositive() && previous.operatingExpenses.isPositive()) {
    const expenseGrowth = figures.operatingExpenses
      .minus(previous.operatingExpenses)
      .toDecimal()
      .dividedBy(previous.operatingExpenses.toDecimal())
      .times(100);
    const incomeGrowth = currentIncome
      .minus(previousIncome)
      .toDecimal()
      .dividedBy(previousIncome.toDecimal())
      .times(100);

    observations.push({
      text:
        `Los gastos variaron ${expenseGrowth.toFixed(1)}% y los ingresos ` +
        `operativos ${incomeGrowth.toFixed(1)}%.` +
        (expenseGrowth.greaterThan(incomeGrowth)
          ? " El crecimiento del gasto fue superior al de los ingresos en este período."
          : expenseGrowth.lessThan(incomeGrowth)
            ? " El crecimiento del gasto fue inferior al de los ingresos en este período."
            : " Ambos variaron en la misma proporción."),
      meaning: expenseGrowth.greaterThan(incomeGrowth)
        ? "UNFAVORABLE"
        : expenseGrowth.lessThan(incomeGrowth)
          ? "FAVORABLE"
          : "NEUTRAL",
    });
  }

  if (
    figures.portfolioOutstanding.isPositive() &&
    previous.portfolioOutstanding.isPositive()
  ) {
    const current = figures.portfolioOverdue
      .toDecimal()
      .dividedBy(figures.portfolioOutstanding.toDecimal())
      .times(100);
    const before = previous.portfolioOverdue
      .toDecimal()
      .dividedBy(previous.portfolioOutstanding.toDecimal())
      .times(100);
    const delta = current.minus(before);

    if (!delta.isZero()) {
      observations.push({
        text:
          `La cartera vencida pasó de ${before.toFixed(1)}% a ${current.toFixed(1)}%, ` +
          `una variación de ${delta.abs().toFixed(1)} puntos porcentuales.`,
        meaning: delta.greaterThan(0) ? "UNFAVORABLE" : "FAVORABLE",
      });
    }
  }

  // Growth from operations versus growth from fresh owner money (point 80).
  const growthFromOperations = figures.netProfitCash;
  const growthFromContributions = figures.ownerContributions.minus(
    figures.ownerWithdrawals,
  );

  if (growthFromContributions.isPositive()) {
    observations.push({
      text:
        `Del cambio en el patrimonio, ${growthFromOperations.toDatabaseString()} ` +
        `proviene de la operación y ${growthFromContributions.toDatabaseString()} ` +
        "de aportes netos del propietario.",
      meaning: "NEUTRAL",
    });
  }

  return observations;
}
