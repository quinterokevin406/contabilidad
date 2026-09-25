import { defineConfig } from "prisma/config";

// Prisma 7 does not load .env on its own, and Node can do it natively.
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // No .env present (CI, container with real env vars). Fall through and let
    // the missing-URL check below report it.
  }
}

const url = process.env.DATABASE_URL;

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
