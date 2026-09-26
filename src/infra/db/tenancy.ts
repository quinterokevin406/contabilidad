import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Tenant context for Row-Level Security.
 *
 * Every database operation runs inside a transaction that first declares which
 * organization it belongs to. PostgreSQL then filters the rows; the queries in
 * this codebase also filter by hand, and that redundancy is the point — the
 * database is the layer that still holds when a query forgets.
 *
 * The context travels through async calls rather than being passed as an
 * argument, because otherwise every one of the 163 call sites would have to
 * remember to thread it, and "remember to" is exactly what we are protecting
 * against.
 */

interface TenantStore {
  /** The organization's id, or SYSTEM for cross-tenant tooling. */
  setting: string;
  /**
   * True once a transaction has already declared the context, so nested
   * operations do not try to open a second one.
   */
  declared: boolean;
}

const storage = new AsyncLocalStorage<TenantStore>();

/**
 * Reserved value granting access across every tenant.
 *
 * Migrations, the seed and backups legitimately need it. Application code must
 * never reach for it: the whole protection collapses if a request handler can
 * decide it is exempt.
 */
export const SYSTEM_ACCESS = "*";

/**
 * What a request without context resolves to.
 *
 * It matches no organization, so the failure mode is an empty result rather
 * than someone else's data. Fail closed, always.
 */
const NO_CONTEXT = "";

export function currentTenantSetting(): string {
  return storage.getStore()?.setting ?? NO_CONTEXT;
}

export function hasDeclaredContext(): boolean {
  return storage.getStore()?.declared ?? false;
}

/**
 * Runs `fn` with every query scoped to one organization.
 *
 * Note that `fn` is called from inside an async wrapper rather than returned
 * directly. Prisma's promises are lazy: the operation does not start when you
 * call it, it starts when something awaits it. Handing the promise straight
 * back would let that happen after this scope has closed — the context would
 * read as empty and, because empty denies, every query would quietly return
 * nothing. Resolving it here keeps the operation inside the scope however the
 * caller writes their arrow function.
 */
export function withOrganization<T>(
  organizationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run({ setting: organizationId, declared: false }, async () =>
    fn(),
  );
}

/**
 * Runs `fn` with access to every tenant.
 *
 * Only three callers are legitimate: authenticating a request before its
 * organization is known, the seed, and maintenance scripts. Anything else is a
 * bug.
 */
export function withSystemAccess<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run({ setting: SYSTEM_ACCESS, declared: false }, async () =>
    fn(),
  );
}

/**
 * Marks the context as already declared to the database.
 *
 * Used by the Prisma extension once it has opened a transaction and set the
 * value, so operations nested inside it do not open another.
 */
export function asDeclared<T>(fn: () => Promise<T>): Promise<T> {
  const store = storage.getStore();
  return storage.run(
    { setting: store?.setting ?? NO_CONTEXT, declared: true },
    async () => fn(),
  );
}

/**
 * Pins the tenant for the rest of THIS PROCESS's execution.
 *
 * For scripts only: a verification run or a maintenance job is a single-purpose
 * process acting for one organization from start to finish, and threading a
 * scope through every line of it would add noise without adding safety.
 *
 * NEVER call this from anything that serves an HTTP request. A web server
 * handles many lenders' requests in the same process, and a tenant pinned this
 * way would outlive the request that set it — which is the exact failure this
 * whole mechanism exists to prevent. Request code uses `setRequestTenant`,
 * which is bound to React's per-request lifetime.
 */
export function enterOrganizationForProcess(organizationId: string): void {
  storage.enterWith({ setting: organizationId, declared: false });
}
