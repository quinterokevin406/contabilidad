import { Money } from "@/core/money/money";
import type { Prisma } from "@/generated/prisma";
import type { CalendarDate } from "@/core/time/calendar-date";
import { fromDb } from "@/infra/db/money";

import { recordAudit, type Actor, type Tx } from "../shared";
import {
  buildObservations,
  computeMetrics,
  loadPreviousSnapshot,
  principalScheduledOver,
  storeMetrics,
  type Observation,
} from "./metrics";
import {
  closeSnapshot,
  computeSnapshot,
  resolvePeriod,
  type SnapshotFigures,
  type SnapshotKind,
} from "./snapshot";

/**
 * Closing a business period, end to end (points 70, 82, 89).
 *
 * One transaction freezes the figures, computes and stores the six metrics with
 * their arithmetic, and writes the executive observations. Once closed, the
 * period is permanent: every growth chart reads these rows instead of
 * recomputing the past under whatever configuration happens to be current.
 */

export interface ClosePeriodInput {
  organizationId: string;
  kind: SnapshotKind;
  anyDateInside: CalendarDate;
  today: CalendarDate;
  actor: Actor;
  allowOpenPeriod?: boolean;
}

export interface ClosePeriodResult {
  snapshotId: string;
  figures: SnapshotFigures;
  observations: Observation[];
}

export async function closePeriod(
  tx: Tx,
  input: ClosePeriodInput,
): Promise<ClosePeriodResult> {
  const period = resolvePeriod(input.kind, input.anyDateInside);

  const previous = await loadPreviousSnapshot(
    tx,
    input.organizationId,
    input.kind,
    period.periodStart,
  );

  const { snapshotId, figures } = await closeSnapshot(tx, {
    organizationId: input.organizationId,
    kind: input.kind,
    anyDateInside: input.anyDateInside,
    today: input.today,
    closedById: input.actor.userId,
    allowOpenPeriod: input.allowOpenPeriod,
  });

  const principalScheduled = await principalScheduledOver(
    tx,
    input.organizationId,
    figures.periodStart,
    figures.periodEnd,
  );

  const metrics = computeMetrics({ figures, previous, principalScheduled });

  await storeMetrics(
    tx,
    input.organizationId,
    snapshotId,
    metrics,
    previous?.metrics ?? null,
  );

  // The previous period's raw figures, for the observations that compare.
  const previousFigures = await tx.periodSnapshot.findFirst({
    where: {
      organizationId: input.organizationId,
      kind: input.kind,
      status: "CLOSED",
      periodStart: { lt: new Date(`${figures.periodStart}T00:00:00Z`) },
    },
    orderBy: { periodStart: "desc" },
    select: {
      netProfitCash: true,
      operatingExpenses: true,
      interestCollected: true,
      otherIncome: true,
      portfolioOverdue: true,
      portfolioOutstanding: true,
    },
  });

  const observations = buildObservations(
    figures,
    previousFigures
      ? {
          netProfitCash: fromDb(previousFigures.netProfitCash),
          operatingExpenses: fromDb(previousFigures.operatingExpenses),
          interestCollected: fromDb(previousFigures.interestCollected),
          otherIncome: fromDb(previousFigures.otherIncome),
          portfolioOverdue: fromDb(previousFigures.portfolioOverdue),
          portfolioOutstanding: fromDb(previousFigures.portfolioOutstanding),
        }
      : null,
  );

  await tx.periodSnapshot.update({
    where: { id: snapshotId },
    data: {
      // Prisma's Json input type does not accept a bare interface array; the
      // shape is fixed and round-trips through readObservations().
      executiveNotes: observations as unknown as Prisma.InputJsonValue,
    },
  });

  await recordAudit(tx, {
    organizationId: input.organizationId,
    action: "CREATE",
    entity: "PeriodSnapshot",
    entityId: snapshotId,
    afterValues: {
      kind: input.kind,
      periodStart: figures.periodStart,
      periodEnd: figures.periodEnd,
      closingEquity: figures.closingEquity.toDatabaseString(),
      netProfitCash: figures.netProfitCash.toDatabaseString(),
    },
    summary:
      `Cierre ${input.kind === "MONTHLY" ? "mensual" : "semanal"} ` +
      `${figures.periodStart} a ${figures.periodEnd}: utilidad ` +
      figures.netProfitCash.toDatabaseString(),
    actor: input.actor,
  });

  return { snapshotId, figures, observations };
}

/**
 * The period in progress, computed live.
 *
 * Never written. The executive dashboard needs to show the current month before
 * it can be closed, and that figure must be recomputed on every view rather than
 * cached as a half-finished snapshot pretending to be a real one.
 */
export async function currentPeriodPreview(
  tx: Tx,
  organizationId: string,
  kind: SnapshotKind,
  today: CalendarDate,
): Promise<{
  figures: SnapshotFigures;
  observations: Observation[];
  isClosed: boolean;
}> {
  const figures = await computeSnapshot(tx, organizationId, kind, today);
  const period = resolvePeriod(kind, today);

  const [closed, previousFigures] = await Promise.all([
    tx.periodSnapshot.findUnique({
      where: {
        organizationId_kind_periodStart: {
          organizationId,
          kind,
          periodStart: new Date(`${period.periodStart}T00:00:00Z`),
        },
      },
      select: { status: true },
    }),
    tx.periodSnapshot.findFirst({
      where: {
        organizationId,
        kind,
        status: "CLOSED",
        periodStart: { lt: new Date(`${period.periodStart}T00:00:00Z`) },
      },
      orderBy: { periodStart: "desc" },
      select: {
        netProfitCash: true,
        operatingExpenses: true,
        interestCollected: true,
        otherIncome: true,
        portfolioOverdue: true,
        portfolioOutstanding: true,
      },
    }),
  ]);

  return {
    figures,
    observations: buildObservations(
      figures,
      previousFigures
        ? {
            netProfitCash: fromDb(previousFigures.netProfitCash),
            operatingExpenses: fromDb(previousFigures.operatingExpenses),
            interestCollected: fromDb(previousFigures.interestCollected),
            otherIncome: fromDb(previousFigures.otherIncome),
            portfolioOverdue: fromDb(previousFigures.portfolioOverdue),
            portfolioOutstanding: fromDb(previousFigures.portfolioOutstanding),
          }
        : null,
    ),
    isClosed: closed?.status === "CLOSED",
  };
}

/** Sum helper kept here so callers do not reimplement it. */
export function totalEquityChange(figures: SnapshotFigures): {
  fromOperations: Money;
  fromContributions: Money;
  total: Money;
} {
  const fromOperations = figures.netProfitCash;
  const fromContributions = figures.ownerContributions.minus(
    figures.ownerWithdrawals,
  );
  return {
    fromOperations,
    fromContributions,
    total: fromOperations.plus(fromContributions),
  };
}
