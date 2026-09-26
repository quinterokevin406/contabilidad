/**
 * Database seed.
 *
 * Two stages:
 *
 *   bootstrap  Everything a fresh install needs: organization, settings, the
 *              administrator, the till, payment methods and the default income
 *              and expense categories. Idempotent, and always runs.
 *
 *   demo       The sample portfolio from point 49. Only runs when
 *              SEED_DEMO_DATA=true, and refuses to run on a database that
 *              already holds clients, so it can never be dropped on top of real
 *              data.
 */


import { todayIn } from "@/core/time/calendar-date";
import { createSystemClient } from "@/infra/db/system-client";

import { bootstrap } from "./seed/bootstrap";
import { seedDemo } from "./seed/demo";

// Prisma does not load .env for a plain tsx script, and Node can do it natively.
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // Real environment variables (CI, container) are fine too.
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill it in before seeding.`,
    );
  }
  return value;
}

async function main(): Promise<void> {
  const databaseUrl = required("DATABASE_URL");

  const adminPassword = required("SEED_ADMIN_PASSWORD");
  if (adminPassword.length < 8) {
    throw new Error("SEED_ADMIN_PASSWORD must be at least 8 characters.");
  }

  // The seed creates the organization itself, so it runs with access across
  // every tenant. Nothing that serves a request may do this.
  const prisma = createSystemClient(databaseUrl);

  try {
    const timeZone = "America/Bogota";
    const today = todayIn(timeZone);
    const loadDemo = process.env.SEED_DEMO_DATA === "true";

    console.log(`\nCAPITAL CONTROL — seed`);
    console.log(`  fecha de referencia: ${today} (${timeZone})`);
    console.log(`  datos de demostración: ${loadDemo ? "sí" : "no"}\n`);

    const result = await prisma.$transaction(
      async (tx) => {
        const bootstrapped = await bootstrap(tx, {
          organizationName: process.env.SEED_ORG_NAME ?? "Mi Negocio",
          organizationSlug: process.env.SEED_ORG_SLUG ?? "mi-negocio",
          adminEmail: required("SEED_ADMIN_EMAIL"),
          adminPassword,
          adminName: process.env.SEED_ADMIN_NAME ?? "Administrador",
        });

        console.log("  ✓ organización, configuración, administrador y caja");
        console.log("  ✓ métodos de pago y categorías de ingresos/egresos");

        if (!loadDemo) return { bootstrapped, demo: null };

        const existingClients = await tx.client.count({
          where: { organizationId: bootstrapped.organizationId },
        });

        if (existingClients > 0) {
          console.log(
            `\n  ⚠ La base ya tiene ${existingClients} clientes. ` +
              "No se cargan datos de demostración sobre información existente.",
          );
          console.log("    Para empezar de cero: npm run db:reset\n");
          return { bootstrapped, demo: null };
        }

        const demo = await seedDemo(tx, bootstrapped, today);
        return { bootstrapped, demo };
      },
      {
        // The demo replays a whole portfolio through the real services, which is
        // a lot of round trips for one transaction.
        maxWait: 30_000,
        timeout: 300_000,
      },
    );

    if (result.demo) {
      console.log("\n  Datos de demostración cargados:");
      console.log(`    clientes:     ${result.demo.clients}`);
      console.log(`    préstamos:    ${result.demo.loans}`);
      console.log(`    pagos:        ${result.demo.payments}`);
      console.log(`    renovaciones: ${result.demo.renewals}`);
      console.log(`    gastos:       ${result.demo.expenses}`);
      console.log(`    otros ingresos: ${result.demo.incomes}`);
      console.log(`    cierres mensuales: ${result.demo.closedMonths}`);
    }

    console.log(`\n  Ingresá con: ${required("SEED_ADMIN_EMAIL")}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error("\nEl seed falló y no se escribió nada:\n");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
