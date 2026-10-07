import { defineConfig } from "prisma/config";

// Prisma 7 does not load .env on its own, and Node can do it natively.
if (!process.env.DATABASE_URL && !process.env.DIRECT_URL) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // No .env present (CI, container with real env vars). Fall through and let
    // the missing-URL check below report it.
  }
}

/**
 * Migrations need an UNPOOLED connection.
 *
 * A managed Postgres (Supabase, Neon) puts a connection pooler in front of the
 * database, and the application wants that: it is what makes a serverless
 * function safe to run a hundred copies of. But a pooler in transaction mode
 * cannot run the statements a migration needs — it hands out a different
 * backend per transaction, and schema changes care which backend they are on.
 *
 * So the app connects through DATABASE_URL (pooled) and the CLI connects
 * through DIRECT_URL (not). On a plain install where there is no pooler, the
 * two are the same string and DIRECT_URL can be left unset.
 */
const url = process.env.DIRECT_URL || process.env.DATABASE_URL;

if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env and fill it in.",
  );
}

export default defineConfig({
  // Multi-file schema: one file per domain under prisma/schema/.
  schema: "prisma/schema",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url,
  },
});
