import "server-only";

import {
  computeOperatingResult,
  type FinancialClass,
  type LedgerEntry,
} from "@/core/cash/ledger";
import { Money } from "@/core/money/money";
import {
  fromPrismaDate,
  toPrismaDate,
  type CalendarDate,
} from "@/core/time/calendar-date";
import { endOfMonth, startOfMonth } from "@/core/time/calendar-date";
import type { CashMovementType } from "@/generated/prisma";
import { prisma, tenantTransaction } from "@/infra/db/client";
import { fromDb } from "@/infra/db/money";
import { currentCashPosition } from "@/services/cash/closure";

/**
 * Cash and result queries.
 *
 * Every aggregate runs through the core ledger functions rather than being
 * re-summed here, so the cash screen, the dashboard and the reports cannot
 * produce three different answers to the same question.
 */

export const MOVEMENT_LABEL: Record<CashMovementType, string> = {
  CAPITAL_CONTRIBUTION: "Aporte de capital",
  LOAN_DISBURSEMENT: "Desembolso de préstamo",
  PRINCIPAL_RECOVERY: "Recuperación de capital",
  INTEREST_COLLECTION: "Cobro de interés",
  FEE_COLLECTION: "Otros conceptos",
  EXTRAORDINARY_INCOME: "Ingreso extraordinario",
  EXPENSE: "Gasto",
  OWNER_WITHDRAWAL: "Retiro del propietario",
  ADJUSTMENT: "Ajuste de caja",
  PRINCIPAL_WRITE_OFF: "Castigo de cartera",
};

export interface MovementRow {
  id: string;
  occurredOn: CalendarDate;
  type: CashMovementType;
  typeLabel: string;
  direction: "IN" | "OUT";
  amount: Money;
  financialClass: FinancialClass;
  affectsCash: boolean;
  note: string | null;
  clientName: string | null;
  loanCode: string | null;
  loanId: string | null;
}

export interface CashOverview {
  accountId: string;
  accountName: string;
  balance: Money;
  todayIn: Money;
  todayOut: Money;
  lastClosure: { date: CalendarDate; difference: Money } | null;
  pendingSince: CalendarDate | null;
}

export async function getCashOverview(
  organizationId: string,
  asOf: CalendarDate,
): Promise<CashOverview | null> {
  const account = await prisma.cashAccount.findFirst({
    where: { organizationId, isActive: true, archivedAt: null },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { id: true, name: true },
  });

  if (!account) return null;

  const position = await tenantTransaction((tx) =>
    currentCashPosition(tx, organizationId, account.id, asOf),
  );

  return {
    accountId: account.id,
    accountName: account.name,
    ...position,
  };
}

export interface MovementFilters {
  from?: CalendarDate;
  to?: CalendarDate;
  type?: CashMovementType | "ALL";
  page?: number;
  pageSize?: number;
}

export async function listMovements(
  organizationId: string,
  filters: MovementFilters = {},
) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(200, Math.max(10, filters.pageSize ?? 50));

  const where = {
    organizationId,
    reversedAt: null,
    ...(filters.type && filters.type !== "ALL" ? { type: filters.type } : {}),
    ...(filters.from || filters.to
      ? {
          occurredOn: {
            ...(filters.from ? { gte: toPrismaDate(filters.from) } : {}),
            ...(filters.to ? { lte: toPrismaDate(filters.to) } : {}),
          },
        }
      : {}),
  };

  const [total, movements] = await Promise.all([
    prisma.cashMovement.count({ where }),
    prisma.cashMovement.findMany({
      where,
      orderBy: [{ occurredOn: "desc" }, { postedAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        occurredOn: true,
        type: true,
        direction: true,
        amount: true,
        financialClass: true,
        affectsCash: true,
        note: true,
        client: { select: { fullName: true } },
        loan: { select: { id: true, code: true } },
      },
    }),
  ]);

  const rows: MovementRow[] = movements.map((m) => ({
    id: m.id,
    occurredOn: fromPrismaDate(m.occurredOn),
    type: m.type,
    typeLabel: MOVEMENT_LABEL[m.type],
    direction: m.direction,
    amount: fromDb(m.amount),
    financialClass: m.financialClass,
    affectsCash: m.affectsCash,
    note: m.note,
    clientName: m.client?.fullName ?? null,
    loanCode: m.loan?.code ?? null,
    loanId: m.loan?.id ?? null,
  }));

  return {
    rows,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** Profit and loss over a window, plus the balance-sheet figures kept apart. */
export async function getResultForPeriod(
  organizationId: string,
  from: CalendarDate,
  to: CalendarDate,
) {
  const movements = await prisma.cashMovement.findMany({
    where: {
      organizationId,
      reversedAt: null,
      occurredOn: { gte: toPrismaDate(from), lte: toPrismaDate(to) },
    },
    select: {
      direction: true,
      amount: true,
      financialClass: true,
      affectsCash: true,
      type: true,
    },
  });

  const entries: LedgerEntry[] = movements.map((m) => ({
    direction: m.direction,
    amount: fromDb(m.amount),
    financialClass: m.financialClass,
    affectsCash: m.affectsCash,
    isWriteOff: m.type === "PRINCIPAL_WRITE_OFF",
  }));

  return computeOperatingResult(entries);
}

/** Expense totals by category for the period (points 74 and 76). */
export async function getExpenseBreakdown(
  organizationId: string,
  from: CalendarDate,
  to: CalendarDate,
) {
  const grouped = await prisma.expenseEntry.groupBy({
    by: ["categoryId"],
    where: {
      organizationId,
      reversedAt: null,
      occurredOn: { gte: toPrismaDate(from), lte: toPrismaDate(to) },
    },
    _sum: { amount: true },
    _count: true,
  });

  if (grouped.length === 0) return { rows: [], total: Money.zero() };

  const categories = await prisma.transactionCategory.findMany({
    where: { id: { in: grouped.map((g) => g.categoryId) } },
    select: { id: true, name: true },
  });
  const nameById = new Map(categories.map((c) => [c.id, c.name]));

  const rows = grouped
    .map((g) => ({
      categoryId: g.categoryId,
      name: nameById.get(g.categoryId) ?? "Sin categoría",
      amount: fromDb(g._sum.amount?.toFixed() ?? "0"),
      count: g._count,
    }))
    .sort((a, b) => (a.amount.greaterThan(b.amount) ? -1 : 1));

  return { rows, total: Money.sum(rows.map((r) => r.amount)) };
}

/** Active categories for the registration forms. */
export async function getCategories(organizationId: string) {
  const categories = await prisma.transactionCategory.findMany({
    where: { organizationId, isActive: true, archivedAt: null },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      financialClass: true,
      isSystem: true,
    },
  });

  return {
    // System categories are fed by the loan engine and are never selectable in
    // a manual form (point 75).
    expense: categories.filter(
      (c) => c.financialClass === "OPERATING_EXPENSE" && !c.isSystem,
    ),
    income: categories.filter(
      (c) => c.financialClass === "OPERATING_INCOME" && !c.isSystem,
    ),
  };
}

export async function listClosures(organizationId: string, limit = 30) {
  const closures = await prisma.cashClosure.findMany({
    where: { organizationId },
    orderBy: { closureDate: "desc" },
    take: limit,
    select: {
      id: true,
      closureDate: true,
      expectedBalance: true,
      countedBalance: true,
      difference: true,
      totalIn: true,
      totalOut: true,
      notes: true,
      closedAt: true,
      closedBy: { select: { name: true } },
    },
  });

  return closures.map((c) => ({
    id: c.id,
    closureDate: fromPrismaDate(c.closureDate),
    expectedBalance: fromDb(c.expectedBalance),
    countedBalance: fromDb(c.countedBalance),
    difference: fromDb(c.difference),
    totalIn: fromDb(c.totalIn),
    totalOut: fromDb(c.totalOut),
    notes: c.notes,
    closedAt: c.closedAt,
    closedByName: c.closedBy?.name ?? null,
  }));
}

/** The current month window, in the organization time zone. */
export function monthWindow(today: CalendarDate): {
  from: CalendarDate;
  to: CalendarDate;
} {
  return { from: startOfMonth(today), to: endOfMonth(today) };
}
