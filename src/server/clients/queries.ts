import "server-only";

import { Money } from "@/core/money/money";
import type { ClientStatus } from "@/generated/prisma";
import { prisma } from "@/infra/db/client";
import { fromDb } from "@/infra/db/money";

/**
 * Client list queries.
 *
 * The per-client totals are computed with SQL aggregates rather than by loading
 * every loan and summing in JavaScript. With ten demo clients either approach
 * looks fine; with two thousand, the second one stops loading. Getting this right
 * once, here, is cheaper than discovering it in production.
 */

export interface ClientListFilters {
  search?: string;
  status?: ClientStatus | "ALL";
  page?: number;
  pageSize?: number;
  /** Show the archived ones instead of the day-to-day list. */
  archived?: boolean;
}

export interface ClientListRow {
  id: string;
  code: string;
  fullName: string;
  documentNumber: string | null;
  phone: string | null;
  whatsappPhone: string | null;
  city: string | null;
  status: ClientStatus;
  activeLoans: number;
  overdueLoans: number;
  outstandingPrincipal: Money;
  outstandingInterest: Money;
  totalOutstanding: Money;
  maxDaysOverdue: number;
}

export interface ClientListResult {
  rows: ClientListRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface AggregateRow {
  clientId: string;
  activeLoans: bigint;
  overdueLoans: bigint;
  outstandingPrincipal: string | null;
  outstandingInterest: string | null;
  maxDaysOverdue: number | null;
}

export async function listClients(
  organizationId: string,
  filters: ClientListFilters = {},
): Promise<ClientListResult> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(100, Math.max(5, filters.pageSize ?? 25));
  const search = filters.search?.trim() ?? "";
  const status = filters.status && filters.status !== "ALL" ? filters.status : null;

  const where = {
    organizationId,
    archivedAt: filters.archived ? { not: null } : null,
    ...(status ? { status } : {}),
    ...(search
      ? {
          OR: [
            { fullName: { contains: search, mode: "insensitive" as const } },
            { documentNumber: { contains: search } },
            { phone: { contains: search } },
            { code: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [total, clients] = await Promise.all([
    prisma.client.count({ where }),
    prisma.client.findMany({
      where,
      orderBy: [{ fullName: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        code: true,
        fullName: true,
        documentNumber: true,
        phone: true,
        whatsappPhone: true,
        city: true,
        status: true,
      },
    }),
  ]);

  const ids = clients.map((c) => c.id);
  const aggregates = new Map<string, AggregateRow>();

  if (ids.length > 0) {
    // One round trip for every total on the page. Outstanding interest comes
    // from the period rows, which are the single source of truth for interest.
    const rows = await prisma.$queryRaw<AggregateRow[]>`
      SELECT
        l."clientId"                                              AS "clientId",
        COUNT(*) FILTER (WHERE l.lifecycle = 'ACTIVE')            AS "activeLoans",
        COUNT(*) FILTER (WHERE l.lifecycle = 'ACTIVE'
                           AND l.compliance = 'OVERDUE')          AS "overdueLoans",
        COALESCE(SUM(l."outstandingPrincipal")
                 FILTER (WHERE l.lifecycle = 'ACTIVE'), 0)::text  AS "outstandingPrincipal",
        COALESCE((
          SELECT SUM(p."interestAccrued" - p."interestPaid" - p."interestWaived")
          FROM loan_periods p
          JOIN loans l2 ON l2.id = p."loanId"
          WHERE l2."clientId" = l."clientId"
            AND l2.lifecycle = 'ACTIVE'
            AND p.status IN ('PENDING', 'PARTIALLY_PAID')
        ), 0)::text                                               AS "outstandingInterest",
        MAX(l."daysOverdue") FILTER (WHERE l.lifecycle = 'ACTIVE') AS "maxDaysOverdue"
      FROM loans l
      WHERE l."organizationId" = ${organizationId}
        AND l."clientId" = ANY(${ids}::text[])
        AND l."archivedAt" IS NULL
      GROUP BY l."clientId"
    `;

    for (const row of rows) aggregates.set(row.clientId, row);
  }

  return {
    rows: clients.map((client) => {
      const agg = aggregates.get(client.id);
      const principal = fromDb(agg?.outstandingPrincipal ?? "0");
      const interest = fromDb(agg?.outstandingInterest ?? "0");

      return {
        ...client,
        activeLoans: Number(agg?.activeLoans ?? 0),
        overdueLoans: Number(agg?.overdueLoans ?? 0),
        outstandingPrincipal: principal,
        outstandingInterest: interest,
        totalOutstanding: principal.plus(interest),
        maxDaysOverdue: agg?.maxDaysOverdue ?? 0,
      };
    }),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** Headline counters for the clients page. */
export async function clientSummary(organizationId: string) {
  const [active, inactive, blocked] = await Promise.all([
    prisma.client.count({
      where: { organizationId, archivedAt: null, status: "ACTIVE" },
    }),
    prisma.client.count({
      where: { organizationId, archivedAt: null, status: "INACTIVE" },
    }),
    prisma.client.count({
      where: { organizationId, archivedAt: null, status: "BLOCKED" },
    }),
  ]);

  return { active, inactive, blocked, total: active + inactive + blocked };
}
