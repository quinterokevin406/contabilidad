/**
 * Closes every business period that has already ended and is not yet closed.
 *
 * Useful on a fresh install that already carries history, and after importing
 * past operations. Safe to re-run: a period that is already CLOSED is skipped,
 * never recomputed — point 70 requires that a frozen snapshot stay frozen.
 *
 * Destroys nothing. Every figure is derived from the ledger.
 */

import { PrismaPg } from "@prisma/adapter-pg";

import {
  addMonths,
  startOfMonth,
  toParts,
  toPrismaDate,
  todayIn,
  type CalendarDate,
} from "@/core/time/calendar-date";
import { formatMonthShort } from "@/core/time/format";
import { PrismaClient } from "@/generated/prisma";
import { closePeriod } from "@/services/analytics/close-period";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

async function main() {
  const org = await prisma.organization.findFirstOrThrow({
    select: { id: true, name: true },
  });
  const settings = await prisma.organizationSettings.findUniqueOrThrow({
    where: { organizationId: org.id },
    select: { timeZone: true },
  });
  const admin = await prisma.user.findFirstOrThrow({
    where: { organizationId: org.id, role: "ADMIN" },
    select: { id: true, email: true },
  });

  const today = todayIn(settings.timeZone);
  const currentMonthStart = startOfMonth(today);

  // Start from the first month that has any movement at all.
  const earliest = await prisma.cashMovement.findFirst({
    where: { organizationId: org.id },
    orderBy: { occurredOn: "asc" },
    select: { occurredOn: true },
  });

  if (!earliest) {
    console.log("\nNo hay movimientos registrados. Nada que cerrar.\n");
    return;
  }

  const first = startOfMonth(
    `${earliest.occurredOn.toISOString().slice(0, 10)}` as CalendarDate,
  );

  console.log(`\n${org.name} — cierres mensuales`);
  console.log(`  desde ${first} hasta el mes anterior a ${currentMonthStart}\n`);

  let closed = 0;
  let skipped = 0;

  for (
    let month = first;
    month < currentMonthStart;
    month = addMonths(month, 1)
  ) {
    const { year, month: monthNumber } = toParts(month);
    const label = formatMonthShort(year, monthNumber);

    const existing = await prisma.periodSnapshot.findUnique({
      where: {
        organizationId_kind_periodStart: {
          organizationId: org.id,
          kind: "MONTHLY",
          periodStart: toPrismaDate(month),
        },
      },
      select: { status: true },
    });

    if (existing?.status === "CLOSED") {
      console.log(`  · ${label} ya estaba cerrado`);
      skipped += 1;
      continue;
    }

    const result = await prisma.$transaction(
      (tx) =>
        closePeriod(tx, {
          organizationId: org.id,
          kind: "MONTHLY",
          anyDateInside: month,
          today,
          actor: { userId: admin.id, email: admin.email },
        }),
      { timeout: 120_000 },
    );

    console.log(
      `  ✓ ${label}  utilidad ${result.figures.netProfitCash.toDatabaseString().padStart(14)}` +
        `  patrimonio ${result.figures.closingEquity.toDatabaseString().padStart(14)}`,
    );
    closed += 1;
  }

  console.log(
    `\n  ${closed} ${closed === 1 ? "período cerrado" : "períodos cerrados"}` +
      (skipped > 0 ? `, ${skipped} ya estaban cerrados` : "") +
      ".\n",
  );
}

main()
  .catch((error: unknown) => {
    console.error("\nEl cierre falló:\n");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
