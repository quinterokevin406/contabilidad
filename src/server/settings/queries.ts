import "server-only";

import { prisma } from "@/infra/db/client";

/**
 * Read model for the configuration screen (point 48).
 *
 * Counts travel with each category and payment method so the screen can say
 * what archiving would affect before the operator commits to it.
 */

export interface CategoryRow {
  id: string;
  name: string;
  financialClass: "OPERATING_EXPENSE" | "OPERATING_INCOME";
  isSystem: boolean;
  isArchived: boolean;
  movements: number;
}

export interface MethodRow {
  id: string;
  name: string;
  isSystem: boolean;
  isArchived: boolean;
  payments: number;
}

export interface GoalRow {
  id: string;
  kind: string;
  label: string;
  targetValue: string;
  direction: "AT_LEAST" | "AT_MOST";
}

export interface AlertRow {
  id: string;
  metric: string;
  comparator: string;
  threshold: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  label: string;
  isActive: boolean;
}

export async function listCategories(
  organizationId: string,
): Promise<CategoryRow[]> {
  const rows = await prisma.transactionCategory.findMany({
    where: {
      organizationId,
      financialClass: { in: ["OPERATING_EXPENSE", "OPERATING_INCOME"] },
    },
    orderBy: [{ financialClass: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      financialClass: true,
      isSystem: true,
      archivedAt: true,
      _count: { select: { expenseEntries: true, incomeEntries: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    financialClass: row.financialClass as CategoryRow["financialClass"],
    isSystem: row.isSystem,
    isArchived: row.archivedAt !== null,
    movements: row._count.expenseEntries + row._count.incomeEntries,
  }));
}

export async function listMethods(
  organizationId: string,
): Promise<MethodRow[]> {
  const rows = await prisma.paymentMethod.findMany({
    where: { organizationId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      systemKey: true,
      archivedAt: true,
      _count: { select: { payments: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    isSystem: row.systemKey !== null,
    isArchived: row.archivedAt !== null,
    payments: row._count.payments,
  }));
}

export async function listGoals(organizationId: string): Promise<GoalRow[]> {
  const rows = await prisma.goal.findMany({
    where: { organizationId, isActive: true },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      kind: true,
      label: true,
      targetValue: true,
      direction: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    label: row.label,
    targetValue: row.targetValue.toString(),
    direction: row.direction,
  }));
}

export async function listAlertRules(
  organizationId: string,
): Promise<AlertRow[]> {
  const rows = await prisma.alertRule.findMany({
    where: { organizationId },
    orderBy: [{ severity: "desc" }, { createdAt: "asc" }],
    select: {
      id: true,
      metric: true,
      comparator: true,
      threshold: true,
      severity: true,
      label: true,
      isActive: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    metric: row.metric,
    comparator: row.comparator,
    threshold: row.threshold.toString(),
    severity: row.severity,
    label: row.label,
    isActive: row.isActive,
  }));
}

/**
 * How much history the current configuration is standing on. Shown on the
 * screen so nobody changes a default thinking it is a fresh install.
 */
export async function configurationFootprint(organizationId: string): Promise<{
  loans: number;
  payments: number;
  movements: number;
}> {
  const [loans, payments, movements] = await Promise.all([
    prisma.loan.count({ where: { organizationId } }),
    prisma.payment.count({ where: { organizationId } }),
    prisma.cashMovement.count({ where: { organizationId } }),
  ]);

  return { loans, payments, movements };
}
