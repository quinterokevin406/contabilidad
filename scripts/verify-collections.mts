/**
 * Integration check for collections, calendar and overdue portfolio.
 *
 * The critical property here is that a PROJECTION writes nothing. The calendar
 * and the "what do I collect tomorrow" figures walk each loan's frozen schedule
 * to compute periods that have not accrued. If any of that leaked into the
 * database it would freeze a principal basis that a later capital payment would
 * invalidate — the exact bug the accrual design exists to prevent.
 */

import { PrismaPg } from "@prisma/adapter-pg";

import { Money } from "@/core/money/money";
import { addDays, todayIn } from "@/core/time/calendar-date";
import { PrismaClient } from "@/generated/prisma";
import { fromDb } from "@/infra/db/money";
import {
  collectionsOn,
  getCalendarDays,
  getCollectionsSummary,
  getOverduePortfolio,
  overdueCollections,
  projectedCollections,
} from "@/server/collections/queries";

if (!process.env.DATABASE_URL) process.loadEnvFile(".env");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let failures = 0;

function check(label: string, pass: boolean, detail = "") {
  if (!pass) failures += 1;
  console.log(`  ${pass ? "OK  " : "FALLA"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const org = await prisma.organization.findFirstOrThrow({ select: { id: true } });
  const today = todayIn("America/Bogota");

  // --- Projections must write nothing --------------------------------------

  console.log("\nProyecciones (lo más importante):\n");

  const periodsBefore = await prisma.loanPeriod.count({
    where: { organizationId: org.id },
  });

  const projected = await projectedCollections(
    org.id,
    addDays(today, 1),
    addDays(today, 60),
  );

  await getCalendarDays(org.id, today, addDays(today, 60), today);
  await getCollectionsSummary(org.id, today);

  const periodsAfter = await prisma.loanPeriod.count({
    where: { organizationId: org.id },
  });

  check(
    "proyectar NO crea filas de período",
    periodsBefore === periodsAfter,
    `${periodsBefore} → ${periodsAfter}`,
  );
  check(
    "toda fila proyectada está marcada como proyección",
    projected.every((row) => row.isProjection),
    `${projected.length} filas`,
  );
  check(
    "ninguna proyección cae en el pasado",
    projected.every((row) => row.dueOn > today),
  );

  // --- Today's collections --------------------------------------------------

  console.log("\nCobros de hoy:\n");

  const todayRows = await collectionsOn(org.id, today);
  const todayPeriods = await prisma.loanPeriod.count({
    where: {
      organizationId: org.id,
      dueOn: new Date(`${today}T00:00:00Z`),
      loan: { archivedAt: null },
    },
  });

  check(
    "los cobros de hoy salen de períodos reales",
    todayRows.length === todayPeriods,
    `${todayRows.length} filas / ${todayPeriods} períodos`,
  );
  check(
    "ningún cobro de hoy es una proyección",
    todayRows.every((row) => !row.isProjection),
  );
  check(
    "un período saldado aparece como PAGADO",
    todayRows.every(
      (row) => row.outstanding.isZero() === (row.status === "PAID"),
    ),
  );

  // --- Overdue --------------------------------------------------------------

  console.log("\nCartera vencida:\n");

  const overdue = await overdueCollections(org.id, addDays(today, -1));
  const overdueSum = Money.sum(overdue.map((r) => r.outstanding));

  check(
    "todo lo vencido tiene saldo positivo",
    overdue.every((row) => row.outstanding.isPositive()),
    `${overdue.length} períodos`,
  );
  check(
    "ningún vencido cae en el futuro",
    overdue.every((row) => row.dueOn < today),
  );

  const report = await getOverduePortfolio(org.id, today);

  const bucketSum = Money.sum(report.buckets.map((b) => b.amount));
  check(
    "los rangos de antigüedad suman el total vencido",
    bucketSum.equals(report.totals.overdueTotal),
    `${bucketSum.toDatabaseString()} vs ${report.totals.overdueTotal.toDatabaseString()}`,
  );

  const bucketLoans = report.buckets.reduce((acc, b) => acc + b.loanCount, 0);
  check(
    "cada préstamo vencido cae en exactamente un rango",
    bucketLoans === report.totals.overdueLoans,
    `${bucketLoans} vs ${report.totals.overdueLoans}`,
  );

  const rowSum = Money.sum(report.rows.map((r) => r.totalOutstanding));
  check(
    "las filas suman el total vencido",
    rowSum.equals(report.totals.overdueTotal),
    rowSum.toDatabaseString(),
  );

  // The portfolio total must match the same figures the loan list reports.
  const principalAll = await prisma.loan.aggregate({
    where: { organizationId: org.id, lifecycle: "ACTIVE", archivedAt: null },
    _sum: { outstandingPrincipal: true },
  });
  const interestAll = (
    await prisma.loanPeriod.findMany({
      where: {
        organizationId: org.id,
        status: { in: ["PENDING", "PARTIALLY_PAID"] },
        loan: { lifecycle: "ACTIVE", archivedAt: null },
      },
      select: { interestAccrued: true, interestPaid: true, interestWaived: true },
    })
  ).reduce((acc, p) => {
    const owed = fromDb(p.interestAccrued)
      .minus(fromDb(p.interestPaid))
      .minus(fromDb(p.interestWaived));
    return owed.isPositive() ? acc.plus(owed) : acc;
  }, Money.zero());

  const expectedPortfolio = fromDb(
    principalAll._sum.outstandingPrincipal?.toFixed() ?? "0",
  ).plus(interestAll);

  check(
    "la cartera total coincide con préstamos + períodos",
    report.totals.portfolioTotal.equals(expectedPortfolio),
    `${report.totals.portfolioTotal.toDatabaseString()} vs ${expectedPortfolio.toDatabaseString()}`,
  );

  const ratio = report.totals.delinquencyRatio;
  check(
    "el índice de morosidad está entre 0 y 100, o es N/D",
    ratio === null || (ratio >= 0 && ratio <= 100),
    ratio === null ? "N/D" : `${ratio}%`,
  );

  console.log(
    `\n  cartera total   ${report.totals.portfolioTotal.toDatabaseString()}`,
  );
  console.log(
    `  cartera vencida ${report.totals.overdueTotal.toDatabaseString()}`,
  );
  console.log(`  morosidad       ${ratio === null ? "N/D" : `${ratio}%`}`);
  console.log(`  atraso promedio ${report.totals.averageOverdueDays} días`);

  // --- Summary consistency --------------------------------------------------

  console.log("\nConsistencia del resumen:\n");

  const summary = await getCollectionsSummary(org.id, today);

  check(
    "el vencido del resumen coincide con la consulta directa",
    summary.totals.overdue.equals(overdueSum),
    `${summary.totals.overdue.toDatabaseString()} vs ${overdueSum.toDatabaseString()}`,
  );
  check(
    "cobrado + pendiente de hoy = esperado de hoy",
    summary.totals.todayCollected
      .plus(summary.totals.todayPending)
      .equals(summary.totals.todayExpected),
    `${summary.totals.todayCollected.toDatabaseString()} + ${summary.totals.todayPending.toDatabaseString()}`,
  );
  check(
    "los cobros de mañana son todos proyecciones",
    summary.tomorrow.every((row) => row.isProjection),
    `${summary.tomorrow.length} filas`,
  );

  console.log(
    failures === 0
      ? "\nCobros, calendario y cartera funcionan de punta a punta.\n"
      : `\n${failures} verificaciones fallaron.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
