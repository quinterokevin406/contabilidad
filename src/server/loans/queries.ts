import "server-only";

import Decimal from "decimal.js";

import { projectPeriod } from "@/core/loans/accrual";
import { describeLoanState } from "@/core/loans/state";
import { quoteSettlement } from "@/core/loans/settlement";
import { Money } from "@/core/money/money";
import {
  fromPrismaDate,
  toPrismaDate,
  type CalendarDate,
} from "@/core/time/calendar-date";
import { describeDueDistance } from "@/core/time/format";
import type {
  ComplianceStatus,
  LoanLifecycle,
  Periodicity,
} from "@/generated/prisma";
import { prisma } from "@/infra/db/client";
import { fromDb, rateFromDb } from "@/infra/db/money";

/**
 * Loan queries.
 *
 * Interest figures always come from the period rows, which are the single source
 * of truth. Nothing here recomputes interest from the loan's rate — that would
 * be a second implementation of the rule, free to drift from the first.
 */

export interface LoanListFilters {
  search?: string;
  lifecycle?: LoanLifecycle | "ALL";
  compliance?: ComplianceStatus | "ALL";
  clientId?: string;
  page?: number;
  pageSize?: number;
}

export interface LoanListRow {
  id: string;
  code: string;
  clientId: string;
  clientName: string;
  clientPhone: string | null;
  originalPrincipal: Money;
  outstandingPrincipal: Money;
  outstandingInterest: Money;
  totalOutstanding: Money;
  ratePercent: string;
  periodicity: Periodicity;
  customPeriodDays: number | null;
  nextDueOn: CalendarDate | null;
  daysOverdue: number;
  renewalCount: number;
  state: ReturnType<typeof describeLoanState>;
}

export interface LoanListResult {
  rows: LoanListRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  totals: {
    outstandingPrincipal: Money;
    outstandingInterest: Money;
    overdueCount: number;
  };
}

interface InterestRow {
  loanId: string;
  outstandingInterest: string | null;
}

export async function listLoans(
  organizationId: string,
  filters: LoanListFilters = {},
): Promise<LoanListResult> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(5, filters.pageSize ?? 25));
  const search = filters.search?.trim() ?? "";

  const where = {
    organizationId,
    archivedAt: null,
    ...(filters.lifecycle && filters.lifecycle !== "ALL"
      ? { lifecycle: filters.lifecycle }
      : {}),
    ...(filters.compliance && filters.compliance !== "ALL"
      ? { compliance: filters.compliance, lifecycle: "ACTIVE" as const }
      : {}),
    ...(filters.clientId ? { clientId: filters.clientId } : {}),
    ...(search
      ? {
          OR: [
            { code: { contains: search, mode: "insensitive" as const } },
            {
              client: {
                fullName: { contains: search, mode: "insensitive" as const },
              },
            },
            { client: { documentNumber: { contains: search } } },
          ],
        }
      : {}),
  };

  const [total, loans, aggregate, overdueCount] = await Promise.all([
    prisma.loan.count({ where }),
    prisma.loan.findMany({
      where,
      orderBy: [{ compliance: "desc" }, { nextDueOn: "asc" }, { code: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        code: true,
        clientId: true,
        originalPrincipal: true,
        outstandingPrincipal: true,
        ratePercent: true,
        periodicity: true,
        customPeriodDays: true,
        nextDueOn: true,
        daysOverdue: true,
        renewalCount: true,
        lifecycle: true,
        compliance: true,
        client: { select: { fullName: true, phone: true } },
      },
    }),
    prisma.loan.aggregate({
      where: { ...where, lifecycle: "ACTIVE" },
      _sum: { outstandingPrincipal: true },
    }),
    prisma.loan.count({
      where: { organizationId, archivedAt: null, lifecycle: "ACTIVE", compliance: "OVERDUE" },
    }),
  ]);

  const interestByLoan = new Map<string, Money>();
  const ids = loans.map((l) => l.id);

  if (ids.length > 0) {
    const rows = await prisma.$queryRaw<InterestRow[]>`
      SELECT
        p."loanId" AS "loanId",
        COALESCE(SUM(p."interestAccrued" - p."interestPaid" - p."interestWaived"), 0)::text
          AS "outstandingInterest"
      FROM loan_periods p
      WHERE p."loanId" = ANY(${ids}::text[])
        AND p.status IN ('PENDING', 'PARTIALLY_PAID')
      GROUP BY p."loanId"
    `;
    for (const row of rows) {
      interestByLoan.set(row.loanId, fromDb(row.outstandingInterest ?? "0"));
    }
  }

  // Organization-wide outstanding interest, independent of the current page.
  const [globalInterest] = await prisma.$queryRaw<{ total: string | null }[]>`
    SELECT COALESCE(SUM(p."interestAccrued" - p."interestPaid" - p."interestWaived"), 0)::text
             AS total
    FROM loan_periods p
    JOIN loans l ON l.id = p."loanId"
    WHERE l."organizationId" = ${organizationId}
      AND l.lifecycle = 'ACTIVE'
      AND l."archivedAt" IS NULL
      AND p.status IN ('PENDING', 'PARTIALLY_PAID')
  `;

  return {
    rows: loans.map((loan) => {
      const outstandingPrincipal = fromDb(loan.outstandingPrincipal);
      const outstandingInterest =
        interestByLoan.get(loan.id) ?? Money.zero();

      return {
        id: loan.id,
        code: loan.code,
        clientId: loan.clientId,
        clientName: loan.client.fullName,
        clientPhone: loan.client.phone,
        originalPrincipal: fromDb(loan.originalPrincipal),
        outstandingPrincipal,
        outstandingInterest,
        totalOutstanding: outstandingPrincipal.plus(outstandingInterest),
        ratePercent: loan.ratePercent.toFixed(),
        periodicity: loan.periodicity,
        customPeriodDays: loan.customPeriodDays,
        nextDueOn: loan.nextDueOn ? fromPrismaDate(loan.nextDueOn) : null,
        daysOverdue: loan.daysOverdue,
        renewalCount: loan.renewalCount,
        state: describeLoanState({
          lifecycle: loan.lifecycle,
          compliance: loan.compliance,
          debt: { outstandingPrincipal, outstandingInterest },
          daysOverdue: loan.daysOverdue,
        }),
      };
    }),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    totals: {
      outstandingPrincipal: fromDb(
        aggregate._sum.outstandingPrincipal?.toFixed() ?? "0",
      ),
      outstandingInterest: fromDb(globalInterest?.total ?? "0"),
      overdueCount,
    },
  };
}

// --- Detail -----------------------------------------------------------------

export interface LoanPeriodRow {
  id: string;
  periodIndex: number;
  startsOn: CalendarDate;
  dueOn: CalendarDate;
  principalBasis: Money;
  rateApplied: string;
  interestAccrued: Money;
  interestPaid: Money;
  interestOutstanding: Money;
  status: string;
}

export interface LoanPaymentRow {
  id: string;
  receiptNumber: string;
  paidOn: CalendarDate;
  amount: Money;
  interest: Money;
  principal: Money;
  fees: Money;
  methodName: string | null;
  status: string;
}

export interface LoanDetail {
  id: string;
  code: string;
  clientId: string;
  clientName: string;
  clientPhone: string | null;
  clientWhatsapp: string | null;

  originalPrincipal: Money;
  currentPrincipalBase: Money;
  outstandingPrincipal: Money;
  outstandingInterest: Money;
  totalOutstanding: Money;

  ratePercent: string;
  periodicity: Periodicity;
  customPeriodDays: number | null;
  interestMethod: string;
  allocationStrategy: string;
  openPeriodPolicy: string;

  disbursedOn: CalendarDate;
  nextDueOn: CalendarDate | null;
  dueDistance: ReturnType<typeof describeDueDistance> | null;
  daysOverdue: number;
  renewalCount: number;
  notes: string | null;

  state: ReturnType<typeof describeLoanState>;
  lifecycle: LoanLifecycle;

  periods: LoanPeriodRow[];
  payments: LoanPaymentRow[];

  /** What the client would pay to close the loan today. */
  settlementQuote: ReturnType<typeof quoteSettlement> | null;
  /** Interest the period in progress will owe at its due date. */
  upcomingInterest: Money | null;
}

export async function getLoanDetail(
  organizationId: string,
  loanId: string,
  today: CalendarDate,
  settings: { dueSoonLeadDays: number },
): Promise<LoanDetail | null> {
  const loan = await prisma.loan.findFirst({
    where: { id: loanId, organizationId, archivedAt: null },
    select: {
      id: true,
      code: true,
      clientId: true,
      originalPrincipal: true,
      currentPrincipalBase: true,
      outstandingPrincipal: true,
      ratePercent: true,
      periodicity: true,
      customPeriodDays: true,
      interestMethod: true,
      allocationStrategy: true,
      periodAnchor: true,
      roundingMode: true,
      moneyQuantum: true,
      openPeriodPolicy: true,
      scheduleAnchorOn: true,
      scheduleAnchorIndex: true,
      lastPeriodIndex: true,
      disbursedOn: true,
      nextDueOn: true,
      daysOverdue: true,
      renewalCount: true,
      notes: true,
      lifecycle: true,
      compliance: true,
      client: {
        select: { fullName: true, phone: true, whatsappPhone: true },
      },
      periods: {
        orderBy: { periodIndex: "desc" },
        select: {
          id: true,
          periodIndex: true,
          startsOn: true,
          dueOn: true,
          principalBasis: true,
          rateApplied: true,
          interestAccrued: true,
          interestPaid: true,
          interestWaived: true,
          status: true,
        },
      },
      payments: {
        orderBy: { paidOn: "desc" },
        select: {
          id: true,
          receiptNumber: true,
          paidOn: true,
          amount: true,
          status: true,
          paymentMethod: { select: { name: true } },
          allocations: { select: { kind: true, amount: true } },
        },
      },
    },
  });

  if (!loan) return null;

  const periods: LoanPeriodRow[] = loan.periods.map((period) => {
    const accrued = fromDb(period.interestAccrued);
    const paid = fromDb(period.interestPaid);
    const waived = fromDb(period.interestWaived);
    return {
      id: period.id,
      periodIndex: period.periodIndex,
      startsOn: fromPrismaDate(period.startsOn),
      dueOn: fromPrismaDate(period.dueOn),
      principalBasis: fromDb(period.principalBasis),
      rateApplied: period.rateApplied.toFixed(),
      interestAccrued: accrued,
      interestPaid: paid,
      interestOutstanding: accrued.minus(paid).minus(waived),
      status: period.status,
    };
  });

  const outstandingInterest = periods.reduce(
    (acc, p) => (p.interestOutstanding.isPositive() ? acc.plus(p.interestOutstanding) : acc),
    Money.zero(),
  );

  const outstandingPrincipal = fromDb(loan.outstandingPrincipal);

  const payments: LoanPaymentRow[] = loan.payments.map((payment) => {
    let interest = Money.zero();
    let principal = Money.zero();
    let fees = Money.zero();
    for (const allocation of payment.allocations) {
      const value = fromDb(allocation.amount);
      if (allocation.kind === "INTEREST") interest = interest.plus(value);
      else if (allocation.kind === "PRINCIPAL") principal = principal.plus(value);
      else fees = fees.plus(value);
    }
    return {
      id: payment.id,
      receiptNumber: payment.receiptNumber,
      paidOn: fromPrismaDate(payment.paidOn),
      amount: fromDb(payment.amount),
      interest,
      principal,
      fees,
      methodName: payment.paymentMethod?.name ?? null,
      status: payment.status,
    };
  });

  const nextDueOn = loan.nextDueOn ? fromPrismaDate(loan.nextDueOn) : null;

  // The period in progress: a projection, never a stored row.
  let upcomingInterest: Money | null = null;
  let settlementQuote: LoanDetail["settlementQuote"] = null;

  if (loan.lifecycle === "ACTIVE" && nextDueOn) {
    const projection = projectPeriod(
      {
        anchorDueOn: fromPrismaDate(loan.scheduleAnchorOn),
        anchorIndex: loan.scheduleAnchorIndex,
        lastPeriodIndex: loan.lastPeriodIndex,
        schedule: {
          periodicity: loan.periodicity,
          anchor: loan.periodAnchor,
          customPeriodDays: loan.customPeriodDays,
        },
        interestMethod: loan.interestMethod,
        ratePercent: rateFromDb(loan.ratePercent),
        money: {
          roundingMode: loan.roundingMode,
          moneyQuantum: fromDb(loan.moneyQuantum),
        },
        principal: {
          currentPrincipalBase: fromDb(loan.currentPrincipalBase),
          outstandingPrincipal,
        },
      },
      loan.lastPeriodIndex + 1,
    );

    upcomingInterest = projection.interest;

    settlementQuote = quoteSettlement({
      principalOutstanding: outstandingPrincipal,
      accruedInterestOutstanding: outstandingInterest,
      openPeriod: {
        startsOn: projection.startsOn,
        dueOn: projection.dueOn,
        fullPeriodInterest: projection.interest,
      },
      // The policy frozen on the loan, not the current organization default.
      openPeriodPolicy: loan.openPeriodPolicy,
      asOf: today,
      money: {
        roundingMode: loan.roundingMode,
        moneyQuantum: fromDb(loan.moneyQuantum),
      },
    });
  }

  return {
    id: loan.id,
    code: loan.code,
    clientId: loan.clientId,
    clientName: loan.client.fullName,
    clientPhone: loan.client.phone,
    clientWhatsapp: loan.client.whatsappPhone,
    originalPrincipal: fromDb(loan.originalPrincipal),
    currentPrincipalBase: fromDb(loan.currentPrincipalBase),
    outstandingPrincipal,
    outstandingInterest,
    totalOutstanding: outstandingPrincipal.plus(outstandingInterest),
    ratePercent: loan.ratePercent.toFixed(),
    periodicity: loan.periodicity,
    customPeriodDays: loan.customPeriodDays,
    interestMethod: loan.interestMethod,
    allocationStrategy: loan.allocationStrategy,
    openPeriodPolicy: loan.openPeriodPolicy,
    disbursedOn: fromPrismaDate(loan.disbursedOn),
    nextDueOn,
    dueDistance: nextDueOn
      ? describeDueDistance(nextDueOn, today, {
          dueSoonLeadDays: settings.dueSoonLeadDays,
        })
      : null,
    daysOverdue: loan.daysOverdue,
    renewalCount: loan.renewalCount,
    notes: loan.notes,
    state: describeLoanState({
      lifecycle: loan.lifecycle,
      compliance: loan.compliance,
      debt: { outstandingPrincipal, outstandingInterest },
      daysOverdue: loan.daysOverdue,
    }),
    lifecycle: loan.lifecycle,
    periods,
    payments,
    settlementQuote,
    upcomingInterest,
  };
}

/** Everything the payment dialog needs to show the debt being settled. */
export async function getPaymentContext(
  organizationId: string,
  loanId: string,
) {
  const loan = await prisma.loan.findFirst({
    where: { id: loanId, organizationId, archivedAt: null, lifecycle: "ACTIVE" },
    select: {
      id: true,
      code: true,
      allocationStrategy: true,
      outstandingPrincipal: true,
      client: { select: { fullName: true } },
      periods: {
        where: { status: { in: ["PENDING", "PARTIALLY_PAID"] } },
        orderBy: { periodIndex: "asc" },
        select: {
          id: true,
          periodIndex: true,
          dueOn: true,
          interestAccrued: true,
          interestPaid: true,
          interestWaived: true,
        },
      },
    },
  });

  if (!loan) return null;

  const methods = await prisma.paymentMethod.findMany({
    where: { organizationId, isActive: true, archivedAt: null },
    orderBy: { sortOrder: "asc" },
    select: { id: true, name: true },
  });

  const openPeriods = loan.periods
    .map((p) => ({
      id: p.id,
      periodIndex: p.periodIndex,
      dueOn: fromPrismaDate(p.dueOn),
      outstanding: fromDb(p.interestAccrued)
        .minus(fromDb(p.interestPaid))
        .minus(fromDb(p.interestWaived)),
    }))
    .filter((p) => p.outstanding.isPositive());

  return {
    loanId: loan.id,
    loanCode: loan.code,
    clientName: loan.client.fullName,
    allocationStrategy: loan.allocationStrategy,
    outstandingPrincipal: fromDb(loan.outstandingPrincipal),
    outstandingInterest: Money.sum(openPeriods.map((p) => p.outstanding)),
    openPeriods,
    methods,
  };
}

/** Today's collections (point 20). */
export async function collectionsForDate(
  organizationId: string,
  date: CalendarDate,
) {
  const periods = await prisma.loanPeriod.findMany({
    where: {
      organizationId,
      dueOn: toPrismaDate(date),
      status: { in: ["PENDING", "PARTIALLY_PAID", "PAID"] },
      loan: { archivedAt: null },
    },
    orderBy: { dueOn: "asc" },
    select: {
      id: true,
      dueOn: true,
      status: true,
      interestAccrued: true,
      interestPaid: true,
      interestWaived: true,
      loan: {
        select: {
          id: true,
          code: true,
          compliance: true,
          lifecycle: true,
          client: { select: { id: true, fullName: true, phone: true } },
        },
      },
    },
  });

  return periods.map((period) => {
    const accrued = fromDb(period.interestAccrued);
    const paid = fromDb(period.interestPaid);
    const outstanding = accrued.minus(paid).minus(fromDb(period.interestWaived));

    return {
      periodId: period.id,
      loanId: period.loan.id,
      loanCode: period.loan.code,
      clientId: period.loan.client.id,
      clientName: period.loan.client.fullName,
      clientPhone: period.loan.client.phone,
      amount: accrued,
      outstanding,
      status: outstanding.isZero()
        ? ("PAID" as const)
        : period.loan.compliance === "OVERDUE"
          ? ("OVERDUE" as const)
          : ("PENDING" as const),
    };
  });
}

/** Rate helper for display, keeping Decimal out of the page components. */
export function formatRateValue(value: Decimal | string): string {
  return new Decimal(value.toString()).toFixed();
}
