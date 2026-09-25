import "server-only";

import { fromPrismaDate, toPrismaDate, type CalendarDate } from "@/core/time/calendar-date";
import type { AuditAction } from "@/generated/prisma";
import { prisma } from "@/infra/db/client";

/**
 * Audit history (point 33).
 *
 * Read-only by construction: there is no update or delete path for an audit row
 * anywhere in the codebase. A trail that can be edited is not a trail.
 */

export const ACTION_LABEL: Record<AuditAction, string> = {
  CREATE: "Creación",
  UPDATE: "Modificación",
  REVERSE: "Anulación",
  ARCHIVE: "Archivado",
  LOGIN: "Inicio de sesión",
  LOGIN_FAILED: "Intento fallido",
  LOGOUT: "Cierre de sesión",
  EXPORT: "Exportación",
  SETTINGS_CHANGE: "Cambio de configuración",
};

export const ENTITY_LABEL: Record<string, string> = {
  Loan: "Préstamo",
  Payment: "Pago",
  Client: "Cliente",
  ExpenseEntry: "Gasto",
  IncomeEntry: "Ingreso",
  CapitalEvent: "Capital",
  CashMovement: "Movimiento de caja",
  CashClosure: "Cierre de caja",
  PeriodSnapshot: "Cierre de período",
  Report: "Reporte",
  User: "Usuario",
  OrganizationSettings: "Configuración",
};

export interface AuditFilters {
  from?: CalendarDate;
  to?: CalendarDate;
  action?: AuditAction | "ALL";
  entity?: string;
  actorId?: string;
  page?: number;
  pageSize?: number;
}

export interface AuditRow {
  id: string;
  action: AuditAction;
  actionLabel: string;
  entity: string;
  entityLabel: string;
  entityId: string | null;
  summary: string | null;
  reason: string | null;
  actorName: string | null;
  actorEmail: string | null;
  ipAddress: string | null;
  createdAt: Date;
  beforeValues: unknown;
  afterValues: unknown;
}

export async function listAudit(
  organizationId: string,
  filters: AuditFilters = {},
) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(200, Math.max(10, filters.pageSize ?? 50));

  const where = {
    organizationId,
    ...(filters.action && filters.action !== "ALL"
      ? { action: filters.action }
      : {}),
    ...(filters.entity ? { entity: filters.entity } : {}),
    ...(filters.actorId ? { actorId: filters.actorId } : {}),
    ...(filters.from || filters.to
      ? {
          createdAt: {
            ...(filters.from ? { gte: toPrismaDate(filters.from) } : {}),
            // The window is inclusive of the whole closing day.
            ...(filters.to
              ? {
                  lt: new Date(
                    toPrismaDate(filters.to).getTime() + 86_400_000,
                  ),
                }
              : {}),
          },
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        action: true,
        entity: true,
        entityId: true,
        summary: true,
        reason: true,
        actorEmail: true,
        ipAddress: true,
        createdAt: true,
        beforeValues: true,
        afterValues: true,
        actor: { select: { name: true } },
      },
    }),
  ]);

  return {
    rows: rows.map(
      (row): AuditRow => ({
        id: row.id,
        action: row.action,
        actionLabel: ACTION_LABEL[row.action],
        entity: row.entity,
        entityLabel: ENTITY_LABEL[row.entity] ?? row.entity,
        entityId: row.entityId,
        summary: row.summary,
        reason: row.reason,
        actorName: row.actor?.name ?? null,
        actorEmail: row.actorEmail,
        ipAddress: row.ipAddress,
        createdAt: row.createdAt,
        beforeValues: row.beforeValues,
        afterValues: row.afterValues,
      }),
    ),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** Distinct entities present in the trail, for the filter dropdown. */
export async function auditEntities(organizationId: string) {
  const rows = await prisma.auditLog.groupBy({
    by: ["entity"],
    where: { organizationId },
    _count: true,
    orderBy: { entity: "asc" },
  });

  return rows.map((row) => ({
    value: row.entity,
    label: ENTITY_LABEL[row.entity] ?? row.entity,
    count: row._count,
  }));
}

/** Reversals, with what they undid (point 34). */
export async function listReversals(organizationId: string, limit = 50) {
  const reversals = await prisma.reversal.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      targetType: true,
      targetId: true,
      reason: true,
      originalSnapshot: true,
      createdAt: true,
      reversedBy: { select: { name: true } },
    },
  });

  return reversals.map((reversal) => ({
    id: reversal.id,
    targetType: reversal.targetType,
    targetId: reversal.targetId,
    reason: reversal.reason,
    snapshot: reversal.originalSnapshot as Record<string, unknown>,
    createdAt: reversal.createdAt,
    userName: reversal.reversedBy?.name ?? null,
  }));
}

/** Payments that can still be reversed, for the correction screen. */
export async function reversiblePayments(
  organizationId: string,
  limit = 40,
) {
  const payments = await prisma.payment.findMany({
    where: { organizationId, status: "POSTED", renewal: null },
    orderBy: { paidOn: "desc" },
    take: limit,
    select: {
      id: true,
      receiptNumber: true,
      amount: true,
      paidOn: true,
      client: { select: { fullName: true } },
      loan: { select: { code: true } },
    },
  });

  return payments.map((payment) => ({
    id: payment.id,
    receiptNumber: payment.receiptNumber,
    amount: payment.amount.toFixed(),
    paidOn: fromPrismaDate(payment.paidOn),
    clientName: payment.client.fullName,
    loanCode: payment.loan.code,
  }));
}
