import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient, type Prisma } from "@/generated/prisma";
import { getEnv } from "@/lib/env";

import { readRequestTenant } from "./request-tenant";
import { asDeclared, currentTenantSetting } from "./tenancy";

/**
 * The Prisma client.
 *
 * Prisma 7 requires an explicit driver adapter instead of reading a URL from the
 * schema, which is an improvement here: the connection pool is configured in
 * code where it can be reviewed, rather than hidden behind a query string.
 *
 * In development, Next.js hot-reloads modules on every edit. Without the global
 * cache below, each reload would open a fresh pool and the database would run out
 * of connections within a few minutes of work.
 */

const globalForPrisma = globalThis as unknown as {
  prismaBase?: PrismaClient;
};

function createBaseClient(): PrismaClient {
  const env = getEnv();

  // On a serverless host every invocation is its own short-lived process, and
  // a hundred of them each holding ten connections exhausts the database in
  // seconds. One connection per invocation is the shape that platform wants;
  // the pooler in front of the database is what actually does the pooling.
  const serverless = Boolean(process.env.NETLIFY || process.env.VERCEL);

  const adapter = new PrismaPg({
    connectionString: env.DATABASE_URL,
    // A long-running install serves one operator and a handful of collectors.
    // Ten connections is generous and keeps a cheap Postgres box comfortable.
    max: serverless ? 1 : 10,
    idleTimeoutMillis: serverless ? 10_000 : 30_000,
    connectionTimeoutMillis: 10_000,
  });

  return new PrismaClient({
    adapter,
    log:
      env.NODE_ENV === "development"
        ? [{ emit: "stdout", level: "warn" }, { emit: "stdout", level: "error" }]
        : [{ emit: "stdout", level: "error" }],
  });
}

const base: PrismaClient = globalForPrisma.prismaBase ?? createBaseClient();

if (getEnv().NODE_ENV !== "production") {
  globalForPrisma.prismaBase = base;
}

const DECLARE_TENANT = "SELECT set_config('app.organization_id', $1, true)";

/**
 * Which tenant the next statement belongs to.
 *
 * An explicit scope wins — that is how the seed, the verification scripts and
 * the pre-authentication lookup declare themselves. Everything else is a normal
 * request and takes its tenant from the verified session.
 *
 * When neither applies the answer is the empty string, which matches no
 * organization. Absence of context denies.
 */
async function resolveTenant(): Promise<string> {
  return currentTenantSetting() || (await readRequestTenant());
}

/** "LoanPeriod" -> "loanPeriod", the property name on the client. */
function clientProperty(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function runOn(
  client: unknown,
  model: string | undefined,
  operation: string,
  args: unknown,
): Promise<unknown> {
  const target = client as any;
  if (model) return target[clientProperty(model)][operation](args);
  // Raw operations take positional arguments rather than an options object.
  return target[operation](...(Array.isArray(args) ? args : [args]));
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Declares the tenant to PostgreSQL before every read.
 *
 * The setting has to be transaction-local — a session-wide one would outlive
 * the request and be inherited by whoever picks up that pooled connection next.
 * Transaction-local means the operation must run on the connection that
 * declared it, and Prisma's `query(args)` callback does NOT do that: it takes
 * its own connection from the pool, so the declaration would land on a
 * connection that never runs the query. The operation is therefore re-issued
 * against the transaction client.
 *
 * That was verified against a live database rather than assumed. Getting it
 * wrong produces a security control that silently protects nothing, which is
 * worse than having none at all.
 *
 * The transaction is opened on the UNEXTENDED client, so operations inside it
 * do not re-enter this extension and there is no recursion.
 */
const prismaExtended = base.$extends({
  query: {
    async $allOperations({ model, operation, args }) {
      const setting = await resolveTenant();

      return base.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(DECLARE_TENANT, setting);
        return asDeclared(() => runOn(tx, model, operation, args));
      });
    },
  },
});

export type TenantAwarePrisma = typeof prismaExtended;

export const prisma: TenantAwarePrisma = prismaExtended;

/**
 * Transaction client type.
 *
 * Every service that writes money takes one of these rather than the top-level
 * client, which makes it impossible to accidentally run half of a financial
 * operation outside the transaction (point 42).
 */
export type TransactionClient = Prisma.TransactionClient;

/**
 * Opens a transaction with the tenant already declared.
 *
 * Use this instead of `prisma.$transaction`. The plain version would leave the
 * first statement inside it without a declared tenant, and every policy would
 * deny — the failure is loud, but this is the one place where the context has
 * to be established by hand because a transaction is not itself an operation
 * the extension can intercept.
 */
export async function tenantTransaction<T>(
  fn: (tx: TransactionClient) => Promise<T>,
  options?: { timeout?: number; maxWait?: number },
): Promise<T> {
  const setting = await resolveTenant();

  return base.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(DECLARE_TENANT, setting);
    return asDeclared(() => fn(tx));
  }, options);
}
