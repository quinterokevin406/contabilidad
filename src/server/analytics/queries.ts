import "server-only";

import Decimal from "decimal.js";

import { measureGoal, type MetricKey } from "@/core/metrics/indicators";
import { Money } from "@/core/money/money";
import { fromPrismaDate, type CalendarDate } from "@/core/time/calendar-date";
import { formatMonthShort } from "@/core/time/format";
import type { GoalKind } from "@/generated/prisma";
import { prisma, tenantTransaction } from "@/infra/db/client";
import { fromDb } from "@/infra/db/money";
import { currentPeriodPreview } from "@/services/analytics/close-period";
import type { Observation } from "@/services/analytics/metrics";

/**
 * Growth and business-health queries (points 68 to 90).
 *
 * Historical figures come from CLOSED snapshots, never recomputed. The period in
 * progress is computed live and is clearly marked as such — a half-finished
 * month must never sit in a chart pretending to be a closed one.
 */

export interface SnapshotPoint {
  id: string;
  label: string;
  periodStart: CalendarDate;
  periodEnd: CalendarDate;
  isClosed: boolean;

  closingEquity: Money;
  openingEquity: Money;
  principalOutstanding: Money;
  cashAvailable: Money;
  ownerContributions: Money;
  ownerWithdrawals: Money;

  interestCollected: Money;
  otherIncome: Money;
  operatingExpenses: Money;
  netProfitCash: Money;

  portfolioOutstanding: Money;
  portfolioOverdue: Money;
  /** Percentage, or null when there is no portfolio to compare against. */
  delinquencyRatio: number | null;

  activeClients: number;
  activeLoans: number;
  newLoans: number;
  settledLoans: number;
  overdueLoans: number;
}

export interface MetricView {
  metricKey: MetricKey;
  label: string;
  /** Percentage value, or null when not comparable. */
  value: number | null;
  previousValue: number | null;
  /** Change in percentage POINTS, not a percent of a percent. */
  deltaPoints: number | null;
  isComparable: boolean;
  notComparableReason: string | null;
  numerator: Money;
  denominator: Money;
  /** Whether a rise is good news for this metric. */
  higherIsBetter: boolean;
}

const METRIC_LABEL: Record<MetricKey, string> = {
  net_margin: "Margen neto",
  expense_ratio: "Ratio de gastos",
  delinquency_ratio: "Índice de morosidad",
  recovery_ratio: "Tasa de recuperación",
  equity_growth: "Crecimiento del patrimonio",
  profit_growth: "Crecimiento de utilidad",
};

const HIGHER_IS_BETTER: Record<MetricKey, boolean> = {
  net_margin: true,
  expense_ratio: false,
  delinquency_ratio: false,
  recovery_ratio: true,
  equity_growth: true,
  profit_growth: true,
};

function toPoint(row: {
  id: string;
  periodYear: number;
  periodIndex: number;
  periodStart: Date;
  periodEnd: Date;
  status: string;
  closingEquity: unknown;
  openingEquity: unknown;
  principalOutstanding: unknown;
  cashAvailable: unknown;
  ownerContributions: unknown;
  ownerWithdrawals: unknown;
  interestCollected: unknown;
  otherIncome: unknown;
  operatingExpenses: unknown;
  netProfitCash: unknown;
  portfolioOutstanding: unknown;
  portfolioOverdue: unknown;
  activeClients: number;
  activeLoans: number;
  newLoans: number;
  settledLoans: number;
  overdueLoans: number;
}): SnapshotPoint {
  const portfolioOutstanding = fromDb(row.portfolioOutstanding as never);
  const portfolioOverdue = fromDb(row.portfolioOverdue as never);

  return {
    id: row.id,
    label: formatMonthShort(row.periodYear, row.periodIndex),
    periodStart: fromPrismaDate(row.periodStart),
    periodEnd: fromPrismaDate(row.periodEnd),
    isClosed: row.status === "CLOSED",
    closingEquity: fromDb(row.closingEquity as never),
    openingEquity: fromDb(row.openingEquity as never),
    principalOutstanding: fromDb(row.principalOutstanding as never),
    cashAvailable: fromDb(row.cashAvailable as never),
    ownerContributions: fromDb(row.ownerContributions as never),
    ownerWithdrawals: fromDb(row.ownerWithdrawals as never),
    interestCollected: fromDb(row.interestCollected as never),
    otherIncome: fromDb(row.otherIncome as never),
    operatingExpenses: fromDb(row.operatingExpenses as never),
    netProfitCash: fromDb(row.netProfitCash as never),
    portfolioOutstanding,
    portfolioOverdue,
    delinquencyRatio: portfolioOutstanding.isZero()
      ? null
      : Number(
          portfolioOverdue
            .toDecimal()
            .dividedBy(portfolioOutstanding.toDecimal())
            .times(100)
            .toFixed(2),
        ),
    activeClients: row.activeClients,
    activeLoans: row.activeLoans,
    newLoans: row.newLoans,
    settledLoans: row.settledLoans,
    overdueLoans: row.overdueLoans,
  };
}

const SNAPSHOT_SELECT = {
  id: true,
  periodYear: true,
  periodIndex: true,
  periodStart: true,
  periodEnd: true,
  status: true,
  closingEquity: true,
  openingEquity: true,
  principalOutstanding: true,
  cashAvailable: true,
  ownerContributions: true,
  ownerWithdrawals: true,
  interestCollected: true,
  otherIncome: true,
  operatingExpenses: true,
  netProfitCash: true,
  portfolioOutstanding: true,
  portfolioOverdue: true,
  activeClients: true,
  activeLoans: true,
  newLoans: true,
  settledLoans: true,
  overdueLoans: true,
} as const;

/** Closed monthly snapshots, oldest first, limited to a window. */
export async function getSnapshotSeries(
  organizationId: string,
  months: number,
): Promise<SnapshotPoint[]> {
  const rows = await prisma.periodSnapshot.findMany({
    where: { organizationId, kind: "MONTHLY", status: "CLOSED" },
    orderBy: { periodStart: "desc" },
    take: months,
    select: SNAPSHOT_SELECT,
  });

  return rows.map(toPoint).reverse();
}

/** The metrics stored beside a snapshot. */
export async function getSnapshotMetrics(
  snapshotId: string,
): Promise<MetricView[]> {
  const rows = await prisma.periodSnapshotMetric.findMany({
    where: { snapshotId },
    select: {
      metricKey: true,
      value: true,
      previousValue: true,
      isComparable: true,
      notComparableReason: true,
      numerator: true,
      denominator: true,
    },
  });

  const order: MetricKey[] = [
    "net_margin",
    "expense_ratio",
    "delinquency_ratio",
    "recovery_ratio",
    "equity_growth",
    "profit_growth",
  ];

  return rows
    .map((row): MetricView => {
      const key = row.metricKey as MetricKey;
      const value = row.value ? Number(row.value.toFixed()) : null;
      const previousValue = row.previousValue
        ? Number(row.previousValue.toFixed())
        : null;

      return {
        metricKey: key,
        label: METRIC_LABEL[key] ?? key,
        value,
        previousValue,
        // Point 71: a ratio's change is reported in percentage POINTS.
        deltaPoints:
          value !== null && previousValue !== null
            ? Number((value - previousValue).toFixed(2))
            : null,
        isComparable: row.isComparable,
        notComparableReason: row.notComparableReason,
        numerator: fromDb(row.numerator),
        denominator: fromDb(row.denominator),
        higherIsBetter: HIGHER_IS_BETTER[key] ?? true,
      };
    })
    .sort((a, b) => order.indexOf(a.metricKey) - order.indexOf(b.metricKey));
}

/** The month in progress, computed live and flagged as open. */
export async function getCurrentPeriod(
  organizationId: string,
  today: CalendarDate,
): Promise<{
  point: SnapshotPoint;
  observations: Observation[];
  isClosed: boolean;
}> {
  const preview = await tenantTransaction((tx) =>
    currentPeriodPreview(tx, organizationId, "MONTHLY", today),
  );
  const f = preview.figures;

  return {
    point: {
      id: "current",
      label: formatMonthShort(f.periodYear, f.periodIndex),
      periodStart: f.periodStart,
      periodEnd: f.periodEnd,
      isClosed: preview.isClosed,
      closingEquity: f.closingEquity,
      openingEquity: f.openingEquity,
      principalOutstanding: f.principalOutstanding,
      cashAvailable: f.cashAvailable,
      ownerContributions: f.ownerContributions,
      ownerWithdrawals: f.ownerWithdrawals,
      interestCollected: f.interestCollected,
      otherIncome: f.otherIncome,
      operatingExpenses: f.operatingExpenses,
      netProfitCash: f.netProfitCash,
      portfolioOutstanding: f.portfolioOutstanding,
      portfolioOverdue: f.portfolioOverdue,
      delinquencyRatio: f.portfolioOutstanding.isZero()
        ? null
        : Number(
            f.portfolioOverdue
              .toDecimal()
              .dividedBy(f.portfolioOutstanding.toDecimal())
              .times(100)
              .toFixed(2),
          ),
      activeClients: f.activeClients,
      activeLoans: f.activeLoans,
      newLoans: f.newLoans,
      settledLoans: f.settledLoans,
      overdueLoans: f.overdueLoans,
    },
    observations: preview.observations,
    isClosed: preview.isClosed,
  };
}

/** Goal progress (point 85). */
export interface GoalView {
  id: string;
  kind: GoalKind;
  label: string;
  target: Money;
  actual: Money;
  percent: number | null;
  isMet: boolean;
  notComparableReason: string | null;
  unit: "money" | "percent";
}

const RATIO_GOALS: ReadonlySet<GoalKind> = new Set([
  "MAX_DELINQUENCY_RATIO",
  "RECOVERY_RATIO",
]);

export async function getGoals(
  organizationId: string,
  current: SnapshotPoint,
): Promise<GoalView[]> {
  const goals = await prisma.goal.findMany({
    where: { organizationId, isActive: true },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      kind: true,
      direction: true,
      label: true,
      targetValue: true,
    },
  });

  return goals.map((goal): GoalView => {
    const actual = actualForGoal(goal.kind, current);
    const target = fromDb(goal.targetValue.toFixed());

    const progress = measureGoal({
      target,
      actual,
      direction: goal.direction,
    });

    return {
      id: goal.id,
      kind: goal.kind,
      label: goal.label,
      target,
      actual,
      percent: progress.percent ? Number(progress.percent.toFixed(1)) : null,
      isMet: progress.isMet,
      notComparableReason: progress.notComparableReason,
      unit: RATIO_GOALS.has(goal.kind) ? "percent" : "money",
    };
  });
}

function actualForGoal(kind: GoalKind, current: SnapshotPoint): Money {
  switch (kind) {
    case "EQUITY_TARGET":
      return current.closingEquity;
    case "MONTHLY_PROFIT":
      return current.netProfitCash;
    case "MAX_DELINQUENCY_RATIO":
      return current.delinquencyRatio === null
        ? Money.zero()
        : Money.of(new Decimal(current.delinquencyRatio).toFixed(2));
    case "MAX_MONTHLY_EXPENSE":
      return current.operatingExpenses;
    case "INTEREST_COLLECTED":
      return current.interestCollected;
    case "RECOVERY_RATIO":
      return Money.zero();
  }
}

/** Reads the frozen observations off a closed snapshot. */
export async function getSnapshotObservations(
  snapshotId: string,
): Promise<Observation[]> {
  const row = await prisma.periodSnapshot.findUnique({
    where: { id: snapshotId },
    select: { executiveNotes: true },
  });

  if (!row?.executiveNotes || !Array.isArray(row.executiveNotes)) return [];
  return row.executiveNotes as unknown as Observation[];
}

/** Every closed monthly snapshot, newest first (point 83). */
export async function listClosedPeriods(
  organizationId: string,
): Promise<SnapshotPoint[]> {
  const rows = await prisma.periodSnapshot.findMany({
    where: { organizationId, kind: "MONTHLY", status: "CLOSED" },
    orderBy: { periodStart: "desc" },
    select: SNAPSHOT_SELECT,
  });
  return rows.map(toPoint);
}
