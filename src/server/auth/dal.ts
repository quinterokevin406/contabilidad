import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";

import type { UserRole } from "@/generated/prisma";
import { prisma } from "@/infra/db/client";

import { readSession } from "./session";

/**
 * Data access layer for authentication and authorization.
 *
 * The proxy performs an optimistic redirect so an unauthenticated visitor never
 * sees a protected shell flash. It is NOT the authorization boundary — the Next
 * documentation is explicit about that, and a cookie's mere presence proves
 * nothing. Every server component and every server action that touches data
 * calls through here, and here the session is re-verified against the database.
 *
 * `cache()` memoizes the result for one render pass, so a page with a dozen
 * components performing auth checks still makes one query.
 */

export interface CurrentUser {
  id: string;
  organizationId: string;
  email: string;
  name: string;
  role: UserRole;
}

/**
 * Resolves the signed-in user, or null.
 *
 * The database is consulted on every request on purpose: it is what makes
 * `sessionVersion` an instant revocation lever, and what stops a token issued to
 * a since-suspended user from continuing to work for the rest of its lifetime.
 * For a product that handles other people's money, that round trip is worth it.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const claims = await readSession();
  if (!claims) return null;

  const user = await prisma.user.findFirst({
    where: {
      id: claims.userId,
      organizationId: claims.organizationId,
      archivedAt: null,
    },
    select: {
      id: true,
      organizationId: true,
      email: true,
      name: true,
      role: true,
      status: true,
      sessionVersion: true,
      organization: { select: { status: true } },
    },
  });

  if (!user) return null;
  if (user.status !== "ACTIVE") return null;
  if (user.organization.status !== "ACTIVE") return null;
  // A bumped version invalidates every token issued before it.
  if (user.sessionVersion !== claims.sessionVersion) return null;

  return {
    id: user.id,
    organizationId: user.organizationId,
    email: user.email,
    name: user.name,
    role: user.role,
  };
});

/**
 * Requires a signed-in user, redirecting to the login page otherwise.
 *
 * Every protected page and server action starts with this.
 */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** Roles that may change financial data. */
const WRITE_ROLES: readonly UserRole[] = ["ADMIN", "COLLECTOR"];

/**
 * Requires a role that can write.
 *
 * The VIEWER role is read-only by design (point 46), and enforcing that on the
 * server rather than by hiding buttons is what makes it real.
 */
export async function requireWriteAccess(): Promise<CurrentUser> {
  const user = await requireUser();
  if (!WRITE_ROLES.includes(user.role)) {
    throw new Error(
      "Tu rol es de solo consulta y no puede registrar operaciones.",
    );
  }
  return user;
}

/** Requires the administrator role. */
export async function requireAdmin(): Promise<CurrentUser> {
  const user = await requireUser();
  if (user.role !== "ADMIN") {
    throw new Error("Esta operación requiere permisos de administrador.");
  }
  return user;
}

/** Convenience: the organization settings for the signed-in user. */
export const getOrganizationSettings = cache(async () => {
  const user = await requireUser();

  const settings = await prisma.organizationSettings.findUnique({
    where: { organizationId: user.organizationId },
  });

  if (!settings) {
    throw new Error(
      "La organización no tiene configuración. Ejecutá el seed antes de usar la aplicación.",
    );
  }

  return settings;
});
