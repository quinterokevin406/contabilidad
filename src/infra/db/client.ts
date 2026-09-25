import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma";
import { getEnv } from "@/lib/env";

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
  prisma?: PrismaClient;
};

function createClient(): PrismaClient {
  const env = getEnv();

  const adapter = new PrismaPg({
    connectionString: env.DATABASE_URL,
    // A single-tenant install serves one operator and a handful of collectors.
    // Ten connections is generous and keeps a cheap Postgres box comfortable.
    max: 10,
    idleTimeoutMillis: 30_000,
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

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (getEnv().NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * Transaction client type.
 *
 * Every service that writes money takes one of these rather than the top-level
 * client, which makes it impossible to accidentally run half of a financial
 * operation outside the transaction (point 42).
 */
export type TransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
>;
