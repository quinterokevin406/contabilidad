import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma";

/**
 * A database client for tooling that legitimately spans every tenant: the seed,
 * the verification suite, maintenance scripts.
 *
 * The tenant is declared as a connection parameter rather than per transaction,
 * which is safe here and would not be in the application. These are standalone
 * processes that serve exactly one purpose for their whole lifetime; the web
 * server is a long-lived process whose pooled connections are handed from one
 * lender's request to another's, and a session-level setting there would follow
 * the connection instead of the request.
 *
 * Nothing that serves an HTTP request may use this.
 */
export function createSystemClient(connectionString?: string): PrismaClient {
  const url = connectionString ?? process.env.DATABASE_URL;

  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and fill it in.",
    );
  }

  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: url,
      // libpq startup option: sets the setting for every connection in this
      // pool, so the row-level policies resolve to full access.
      options: "-c app.organization_id=*",
    }),
  });
}
