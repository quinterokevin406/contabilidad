import "server-only";

import { prisma } from "@/infra/db/client";
import { withSystemAccess } from "@/infra/db/tenancy";

/**
 * The platform operator's view of the businesses running on this deployment.
 *
 * This is the ONLY place in the application that deliberately crosses tenants,
 * and it is deliberately starved: names, status, dates and counts. No balance,
 * no client name, no payment, no peso. Whoever operates the servers could read
 * all of that straight from the database anyway — the point is that routine
 * administration does not, and that a stolen session of this screen exposes a
 * customer list rather than a customer's books.
 *
 * If you ever find yourself adding an amount to this file, stop and ask what
 * billing decision actually needs it.
 */

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  status: "ACTIVE" | "SUSPENDED";
  createdAt: Date;
  users: number;
  clients: number;
  loans: number;
  /** Most recent sign-in by anyone in the organization. */
  lastActivityAt: Date | null;
}

export async function listOrganizations(): Promise<OrganizationSummary[]> {
  return withSystemAccess(async () => {
    const organizations = await prisma.organization.findMany({
      orderBy: [{ status: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        createdAt: true,
        _count: { select: { users: true, clients: true, loans: true } },
        users: {
          where: { lastLoginAt: { not: null } },
          orderBy: { lastLoginAt: "desc" },
          take: 1,
          select: { lastLoginAt: true },
        },
      },
    });

    return organizations.map((organization) => ({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      status: organization.status,
      createdAt: organization.createdAt,
      users: organization._count.users,
      clients: organization._count.clients,
      loans: organization._count.loans,
      lastActivityAt: organization.users[0]?.lastLoginAt ?? null,
    }));
  });
}

/** Suspensions and reactivations, newest first. */
export interface StatusChange {
  id: string;
  organizationName: string;
  summary: string | null;
  reason: string | null;
  actorEmail: string | null;
  createdAt: Date;
}

export async function listStatusChanges(limit = 30): Promise<StatusChange[]> {
  return withSystemAccess(async () => {
    const rows = await prisma.auditLog.findMany({
      where: { entity: "Organization", action: "SETTINGS_CHANGE" },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        summary: true,
        reason: true,
        actorEmail: true,
        createdAt: true,
        organization: { select: { name: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      organizationName: row.organization.name,
      summary: row.summary,
      reason: row.reason,
      actorEmail: row.actorEmail,
      createdAt: row.createdAt,
    }));
  });
}
