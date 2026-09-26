import { cache } from "react";

/**
 * The organization this request belongs to.
 *
 * `cache()` hands back the same object for the duration of one request and a
 * fresh one for the next, which is the property that matters: a tenant can
 * never survive into someone else's request the way a module-level variable or
 * a pooled connection setting could.
 *
 * The data access layer writes here once it has verified the session; the
 * Prisma extension reads it before every query. A page that somehow queries
 * before authenticating finds it empty, and an empty tenant denies — the screen
 * comes up blank, which is a bug someone reports, rather than showing another
 * lender's clients.
 */
const requestTenantRef = cache((): { organizationId: string | null } => ({
  organizationId: null,
}));

export function setRequestTenant(organizationId: string): void {
  requestTenantRef().organizationId = organizationId;
}

/**
 * Reads the current request's organization, or "" when there is none.
 *
 * Returns "" rather than throwing outside a request — scripts, the seed and the
 * verification suite have no React request context and declare their tenant
 * explicitly instead.
 */
export function readRequestTenant(): string {
  try {
    return requestTenantRef().organizationId ?? "";
  } catch {
    return "";
  }
}
