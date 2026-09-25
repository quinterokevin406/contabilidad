import "server-only";

import { dueDateFor } from "@/core/loans/accrual";
import { AGING_BUCKETS, resolveAgingBucket } from "@/core/loans/state";
import { Money } from "@/core/money/money";
import {
  addDays,
  fromPrismaDate,
  toPrismaDate,
  type CalendarDate,
} from "@/core/time/calendar-date";
import { describeDueDistance } from "@/core/time/format";
import { prisma } from "@/infra/db/client";
import { fromDb, rateFromDb } from "@/infra/db/money";
import { computePeriodInterest } from "@/core/loans/interest";

/**
 * Collections, calendar and overdue portfolio (points 20, 21, 22, 79).
 *
 * Two different questions live here, and they are answered from two different
 * places on purpose:
 *
 *   What is owed TODAY or EARLIER comes from materialized period rows. It is
 *   real, accrued debt.
 *
 *   What falls due TOMORROW or LATER is a PROJECTION, computed from each loan's
 *   frozen schedule. Those periods do not exist yet and must not be written —
 *   under interest-on-outstanding-balance a capital payment between now and then
 *   would change the figure.
 *
 * Mixing the two would either invent debt or hide upcoming work.
 */

export type CollectionStatus = "PAID" | "PENDING" | "OVERDUE";

export interface CollectionRow {
  key: string;
  loanId: string;
  loanCode: string;
  clientId: string;
  clientName: string;
  clientPhone: string | null;
  dueOn: CalendarDate;
  /** Interest owed for the period. */
  amount: Money;
  /** Still outstanding after payments. */
  outstanding: Money;
  status: CollectionStatus;
  daysOverdue: number;
  /** True when this is a forecast rather than an accrued obligation. */
  isProjection: boolean;
}

/**
 * Everything due on a specific date that has already accrued.
 *
 * Includes periods already settled that day, so "cobros de hoy" shows what was
 * collected as well as what is missing (point 20).
 */
export async function collectionsOn(
  organizationId: string,
  date: CalendarDate,
): Promise<CollectionRow[]> {
  const periods = await prisma.loanPeriod.findMany({
    where: {
      organizationId,
      dueOn: toPrismaDate(date),
      loan: { archivedAt: null },
    },
    orderBy: { dueOn: "asc" },
    select: {
      id: true,
      dueOn: true,
      interestAccrued: true,
      interestPaid: true,
      interestWaived: true,
      loan: {
        select: {
          id: true,
          code: true,
          daysOverdue: true,
          client: { select: { id: true, fullName: true, phone: true } },
        },
      },
    },
  });

  return periods.map((period) => {
    const accrued = fromDb(period.interestAccrued);
    const outstanding = accrued
      .minus(fromDb(period.interestPaid))
      .minus(fromDb(period.interestWaived));

    return {
      key: period.id,
      loanId: period.loan.id,
      loanCode: period.loan.code,
      clientId: period.loan.client.id,
      clientName: period.loan.client.fullName,
      clientPhone: period.loan.client.phone,
      dueOn: fromPrismaDate(period.dueOn),
      amount: accrued,
      outstanding,
      status: outstanding.isZero()
        ? "PAID"
        : period.loan.daysOverdue > 0
          ? "OVERDUE"
          : "PENDING",
      daysOverdue: period.loan.daysOverdue,
      isProjection: false,
    };
  });
}

/**
 * Everything accrued and still unpaid on or before a date.
 *
 * This is the real arrears list: periods that came due and were not settled.
 */
export async function overdueCollections(
  organizationId: string,
  asOf: CalendarDate,
): Promise<CollectionRow[]> {
  const periods = await prisma.loanPeriod.findMany({
    where: {
      organizationId,
      dueOn: { lte: toPrismaDate(asOf) },
      status: { in: ["PENDING", "PARTIALLY_PAID"] },
      loan: { archivedAt: null, lifecycle: "ACTIVE" },
    },
    orderBy: { dueOn: "asc" },
    select: {
      id: true,
      dueOn: true,
      interestAccrued: true,
      interestPaid: true,
      interestWaived: true,
      loan: {
        select: {
          id: true,
          code: true,
          daysOverdue: true,
          client: { select: { id: true, fullName: true, phone: true } },
        },
      },
    },
  });

  return periods
    .map((period) => {
      const accrued = fromDb(period.interestAccrued);
      const outstanding = accrued
        .minus(fromDb(period.interestPaid))
        .minus(fromDb(period.interestWaived));

      return {
        key: period.id,
        loanId: period.loan.id,
        loanCode: period.loan.code,
        clientId: period.loan.client.id,
        clientName: period.loan.client.fullName,
        clientPhone: period.loan.client.phone,
        dueOn: fromPrismaDate(period.dueOn),
        amount: accrued,
        outstanding,
        status: "OVERDUE" as const,
        daysOverdue: period.loan.daysOverdue,
        isProjection: false,
      };
    })
    .filter((row) => row.outstanding.isPositive());
}

/**
 * Upcoming due dates, projected from each loan's frozen schedule.
 *
 * Nothing here is written. These periods have not accrued, and under
 * SIMPLE_ON_OUTSTANDING_PRINCIPAL a capital payment before the due date would
 * change the amount — which is exactly why a forecast must stay a forecast.
 */
export async function projectedCollections(
  organizationId: string,
  from: CalendarDate,
  to: CalendarDate,
): Promise<CollectionRow[]> {
  if (to < from) return [];

  const loans = await prisma.loan.findMany({
    where: {
      organizationId,
      lifecycle: "ACTIVE",
      archivedAt: null,
      nextDueOn: { gte: toPrismaDate(from), lte: toPrismaDate(to) },
    },
    select: {
      id: true,
      code: true,
      currentPrincipalBase: true,
      outstandingPrincipal: true,
      ratePercent: true,
      interestMethod: true,
      roundingMode: true,
      moneyQuantum: true,
      periodicity: true,
      periodAnchor: true,
      customPeriodDays: true,
      scheduleAnchorOn: true,
      scheduleAnchorIndex: true,
      lastPeriodIndex: true,
      client: { select: { id: true, fullName: true, phone: true } },
    },
  });

  const rows: CollectionRow[] = [];

  for (const loan of loans) {
    const schedule = {
      anchorDueOn: fromPrismaDate(loan.scheduleAnchorOn),
      anchorIndex: loan.scheduleAnchorIndex,
      schedule: {
        periodicity: loan.periodicity,
        anchor: loan.periodAnchor,
        customPeriodDays: loan.customPeriodDays,
      },
    };

    // Walk forward until the horizon. A daily loan inside a month window
    // produces many rows, which is correct: that IS the collection work.
    for (let index = loan.lastPeriodIndex + 1; ; index += 1) {
      const dueOn = dueDateFor(schedule, index);
      if (dueOn > to) break;
      if (dueOn < from) continue;

      const { interest } = computePeriodInterest({
        method: loan.interestMethod,
        principal: {
          currentPrincipalBase: fromDb(loan.currentPrincipalBase),
          outstandingPrincipal: fromDb(loan.outstandingPrincipal),
        },
        ratePercent: rateFromDb(loan.ratePercent),
        money: {
          roundingMode: loan.roundingMode,
          moneyQuantum: fromDb(loan.moneyQuantum),
        },
      });

      rows.push({
        key: `${loan.id}-${index}`,
        loanId: loan.id,
        loanCode: loan.code,
        clientId: loan.client.id,
        clientName: loan.client.fullName,
        clientPhone: loan.client.phone,
        dueOn,
        amount: interest,
        outstanding: interest,
        status: "PENDING",
        daysOverdue: 0,
        isProjection: true,
      });

      // One page of a calendar should never become an unbounded walk.
      if (rows.length > 500) break;
    }
  }

  return rows.sort((a, b) => (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0));
}

export interface CollectionsSummary {
  today: CollectionRow[];
  tomorrow: CollectionRow[];
  overdue: CollectionRow[];
  week: CollectionRow[];
  totals: {
    todayExpected: Money;
    todayCollected: Money;
    todayPending: Money;
    tomorrow: Money;
    overdue: Money;
    week: Money;
  };
}

/** Everything the collections screen needs (point 20 and point 1). */
export async function getCollectionsSummary(
  organizationId: string,
  today: CalendarDate,
): Promise<CollectionsSummary> {
  const tomorrow = addDays(today, 1);
  const weekEnd = addDays(today, 6);

  const [todayRows, overdue, upcoming] = await Promise.all([
    collectionsOn(organizationId, today),
    overdueCollections(organizationId, addDays(today, -1)),
    projectedCollections(organizationId, tomorrow, weekEnd),
  ]);

  const tomorrowRows = upcoming.filter((row) => row.dueOn === tomorrow);

  const todayCollected = Money.sum(
    todayRows.map((row) => row.amount.minus(row.outstanding)),
  );

  return {
    today: todayRows,
    tomorrow: tomorrowRows,
    overdue,
    week: upcoming,
    totals: {
      todayExpected: Money.sum(todayRows.map((r) => r.amount)),
      todayCollected,
      todayPending: Money.sum(todayRows.map((r) => r.outstanding)),
      tomorrow: Money.sum(tomorrowRows.map((r) => r.outstanding)),
      overdue: Money.sum(overdue.map((r) => r.outstanding)),
      // Today's arrears plus the coming week's forecast: the real workload.
      week: Money.sum(upcoming.map((r) => r.outstanding)).plus(
        Money.sum(todayRows.map((r) => r.outstanding)),
      ),
    },
  };
}

// --- Overdue portfolio (points 22 and 79) -----------------------------------

export interface PortfolioRow {
  loanId: string;
  loanCode: string;
  clientId: string;
  clientName: string;
  clientPhone: string | null;
  clientWhatsapp: string | null;
  principalOutstanding: Money;
  interestOutstanding: Money;
  totalOutstanding: Money;
  oldestDueOn: CalendarDate | null;
  daysOverdue: number;
  lastPaymentOn: CalendarDate | null;
  nextDueOn: CalendarDate | null;
  bucketLabel: string;
}

export interface AgingBucketRow {
  label: string;
  fromDays: number;
  toDays: number | null;
  loanCount: number;
  clientCount: number;
  amount: Money;
}

export interface PortfolioReport {
  rows: PortfolioRow[];
  buckets: AgingBucketRow[];
  totals: {
    portfolioTotal: Money;
    overdueTotal: Money;
    overdueLoans: number;
    overdueClients: number;
    averageOverdueDays: number;
    delinquencyRatio: number | null;
  };
}

export type PortfolioSort = "days" | "amount" | "oldest";

export async function getOverduePortfolio(
  organizationId: string,
  today: CalendarDate,
  sort: PortfolioSort = "days",
): Promise<PortfolioReport> {
  const loans = await prisma.loan.findMany({
    where: {
      organizationId,
      archivedAt: null,
      lifecycle: "ACTIVE",
      compliance: "OVERDUE",
    },
    select: {
      id: true,
      code: true,
      outstandingPrincipal: true,
      daysOverdue: true,
      nextDueOn: true,
      client: {
        select: { id: true, fullName: true, phone: true, whatsappPhone: true },
      },
      periods: {
        where: { status: { in: ["PENDING", "PARTIALLY_PAID"] } },
        orderBy: { dueOn: "asc" },
        select: {
          dueOn: true,
          interestAccrued: true,
          interestPaid: true,
          interestWaived: true,
        },
      },
      payments: {
        where: { status: "POSTED" },
        orderBy: { paidOn: "desc" },
        take: 1,
        select: { paidOn: true },
      },
    },
  });

  const rows: PortfolioRow[] = loans.map((loan) => {
    let interestOutstanding = Money.zero();
    let oldestDueOn: CalendarDate | null = null;

    for (const period of loan.periods) {
      const owed = fromDb(period.interestAccrued)
        .minus(fromDb(period.interestPaid))
        .minus(fromDb(period.interestWaived));
      if (!owed.isPositive()) continue;
      interestOutstanding = interestOutstanding.plus(owed);
      if (!oldestDueOn) oldestDueOn = fromPrismaDate(period.dueOn);
    }

    const principalOutstanding = fromDb(loan.outstandingPrincipal);
    const bucket = resolveAgingBucket(loan.daysOverdue);

    return {
      loanId: loan.id,
      loanCode: loan.code,
      clientId: loan.client.id,
      clientName: loan.client.fullName,
      clientPhone: loan.client.phone,
      clientWhatsapp: loan.client.whatsappPhone,
      principalOutstanding,
      interestOutstanding,
      totalOutstanding: principalOutstanding.plus(interestOutstanding),
      oldestDueOn,
      daysOverdue: loan.daysOverdue,
      lastPaymentOn: loan.payments[0]
        ? fromPrismaDate(loan.payments[0].paidOn)
        : null,
      nextDueOn: loan.nextDueOn ? fromPrismaDate(loan.nextDueOn) : null,
      bucketLabel: bucket?.label ?? "Sin clasificar",
    };
  });

  rows.sort((a, b) => {
    if (sort === "amount") {
      return a.totalOutstanding.greaterThan(b.totalOutstanding) ? -1 : 1;
    }
    if (sort === "oldest") {
      if (!a.oldestDueOn) return 1;
      if (!b.oldestDueOn) return -1;
      return a.oldestDueOn < b.oldestDueOn ? -1 : 1;
    }
    return b.daysOverdue - a.daysOverdue;
  });

  // Buckets declared as data in the core, so the report, the chart and the
  // tests all read from one definition.
  const buckets: AgingBucketRow[] = AGING_BUCKETS.map((bucket) => {
    const inBucket = rows.filter(
      (row) =>
        row.daysOverdue >= bucket.fromDays &&
        (bucket.toDays === null || row.daysOverdue <= bucket.toDays),
    );
    return {
      label: bucket.label,
      fromDays: bucket.fromDays,
      toDays: bucket.toDays,
      loanCount: inBucket.length,
      clientCount: new Set(inBucket.map((r) => r.clientId)).size,
      amount: Money.sum(inBucket.map((r) => r.totalOutstanding)),
    };
  });

  const overdueTotal = Money.sum(rows.map((r) => r.totalOutstanding));

  // Whole portfolio, for the delinquency ratio denominator.
  const [principalAll, interestAll] = await Promise.all([
    prisma.loan.aggregate({
      where: { organizationId, lifecycle: "ACTIVE", archivedAt: null },
      _sum: { outstandingPrincipal: true },
    }),
    prisma.$queryRaw<{ total: string | null }[]>`
      SELECT COALESCE(SUM(p."interestAccrued" - p."interestPaid" - p."interestWaived"), 0)::text
               AS total
      FROM loan_periods p
      JOIN loans l ON l.id = p."loanId"
      WHERE l."organizationId" = ${organizationId}
        AND l.lifecycle = 'ACTIVE'
        AND l."archivedAt" IS NULL
        AND p.status IN ('PENDING', 'PARTIALLY_PAID')
    `,
  ]);

  const portfolioTotal = fromDb(
    principalAll._sum.outstandingPrincipal?.toFixed() ?? "0",
  ).plus(fromDb(interestAll[0]?.total ?? "0"));

  const averageOverdueDays =
    rows.length === 0
      ? 0
      : Math.round(
          rows.reduce((acc, r) => acc + r.daysOverdue, 0) / rows.length,
        );

  return {
    rows,
    buckets,
    totals: {
      portfolioTotal,
      overdueTotal,
      overdueLoans: rows.length,
      overdueClients: new Set(rows.map((r) => r.clientId)).size,
      averageOverdueDays,
      // Point 73: a zero denominator is not a zero ratio.
      delinquencyRatio: portfolioTotal.isZero()
        ? null
        : Number(
            overdueTotal
              .toDecimal()
              .dividedBy(portfolioTotal.toDecimal())
              .times(100)
              .toFixed(2),
          ),
    },
  };
}

/** Day-by-day totals for the calendar (point 21). */
export async function getCalendarDays(
  organizationId: string,
  from: CalendarDate,
  to: CalendarDate,
  today: CalendarDate,
): Promise<
  {
    date: CalendarDate;
    expected: Money;
    outstanding: Money;
    count: number;
    hasOverdue: boolean;
    isProjection: boolean;
  }[]
> {
  const accrued = await prisma.loanPeriod.findMany({
    where: {
      organizationId,
      dueOn: { gte: toPrismaDate(from), lte: toPrismaDate(to) },
      loan: { archivedAt: null },
    },
    select: {
      dueOn: true,
      interestAccrued: true,
      interestPaid: true,
      interestWaived: true,
      loan: { select: { daysOverdue: true } },
    },
  });

  const projected =
    to > today
      ? await projectedCollections(
          organizationId,
          addDays(today, 1) > from ? addDays(today, 1) : from,
          to,
        )
      : [];

  const byDate = new Map<
    CalendarDate,
    {
      expected: Money;
      outstanding: Money;
      count: number;
      hasOverdue: boolean;
      isProjection: boolean;
    }
  >();

  function bump(
    date: CalendarDate,
    expected: Money,
    outstanding: Money,
    overdue: boolean,
    projection: boolean,
  ) {
    const current = byDate.get(date) ?? {
      expected: Money.zero(),
      outstanding: Money.zero(),
      count: 0,
      hasOverdue: false,
      isProjection: projection,
    };
    byDate.set(date, {
      expected: current.expected.plus(expected),
      outstanding: current.outstanding.plus(outstanding),
      count: current.count + 1,
      hasOverdue: current.hasOverdue || overdue,
      isProjection: current.isProjection && projection,
    });
  }

  for (const period of accrued) {
    const expected = fromDb(period.interestAccrued);
    const outstanding = expected
      .minus(fromDb(period.interestPaid))
      .minus(fromDb(period.interestWaived));
    bump(
      fromPrismaDate(period.dueOn),
      expected,
      outstanding.isPositive() ? outstanding : Money.zero(),
      outstanding.isPositive() && period.loan.daysOverdue > 0,
      false,
    );
  }

  for (const row of projected) {
    bump(row.dueOn, row.amount, row.outstanding, false, true);
  }

  return [...byDate.entries()]
    .map(([date, value]) => ({ date, ...value }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Re-exported so pages can label a due date without importing the core. */
export { describeDueDistance };
