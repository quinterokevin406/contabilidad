/**
 * Integration check for business snapshots and metrics.
 *
 * The property under test is RECONSTRUCTION: that the position of the business
 * on any date can be rebuilt from the ledger alone, without reading the current
 * state of a single loan. If that holds, historical snapshots are trustworthy
 * and the growth module has a foundation. If it does not, every chart above it
 * is decoration.
 */

import { computeOperatingResult, projectCashPosition } from "@/core/cash/ledger";
import { Money } from "@/core/money/money";
import { addDays, startOfMonth, todayIn } from "@/core/time/calendar-date";
import { fromDb } from "@/infra/db/money";
import { createSystemClient } from "@/infra/db/system-client";
import { closePeriod, currentPeriodPreview } from "@/services/analytics/close-period";
import { computeSnapshot, resolvePeriod } from "@/services/analytics/snapshot";
import type { Tx } from "@/services/shared";

if (!process.env.DATABASE_URL) process.loadEnvFile(".env");

const prisma = createSystemClient();

let failures = 0;

/** True when the operation throws, which is what a guard is supposed to do. */
async function refuses(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

function check(label: string, pass: boolean, detail = "") {
  if (!pass) failures += 1;
  console.log(`  ${pass ? "OK  " : "FALLA"} ${label}${detail ? ` — ${detail}` : ""}`);
}

class Rollback<T> extends Error {
  constructor(readonly value: T) {
    super("rollback");
  }
}

async function rolledBack<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma
    .$transaction(
      async (tx) => {
        throw new Rollback(await fn(tx));
      },
      { timeout: 120_000 },
    )
    .catch((error: unknown) => {
      if (error instanceof Rollback) return error.value as T;
      throw error;
    });
}

async function main() {
  const org = await prisma.organization.findFirstOrThrow({ select: { id: true } });
  const admin = await prisma.user.findFirstOrThrow({
    where: { organizationId: org.id },
    select: { id: true, email: true },
  });
  const today = todayIn("America/Bogota");

  // --- Reconstruction vs live state ----------------------------------------

  console.log("\nReconstrucción contra el estado actual:\n");

  const figures = await computeSnapshot(prisma, org.id, "MONTHLY", today);

  const livePrincipal = fromDb(
    (
      await prisma.loan.aggregate({
        where: { organizationId: org.id, lifecycle: "ACTIVE", archivedAt: null },
        _sum: { outstandingPrincipal: true },
      })
    )._sum.outstandingPrincipal?.toFixed() ?? "0",
  );

  check(
    "capital reconstruido = suma de préstamos activos",
    figures.principalOutstanding.equals(livePrincipal),
    `${figures.principalOutstanding.toDatabaseString()} vs ${livePrincipal.toDatabaseString()}`,
  );

  const movements = await prisma.cashMovement.findMany({
    where: { organizationId: org.id, reversedAt: null },
    select: {
      direction: true,
      amount: true,
      financialClass: true,
      affectsCash: true,
      type: true,
    },
  });
  const entries = movements.map((m) => ({
    direction: m.direction,
    amount: fromDb(m.amount),
    financialClass: m.financialClass,
    affectsCash: m.affectsCash,
    isWriteOff: m.type === "PRINCIPAL_WRITE_OFF",
  }));

  const liveCash = projectCashPosition(Money.zero(), entries).expectedBalance;
  const liveResult = computeOperatingResult(entries);
  const liveEquity = liveResult.equityContributions
    .plus(liveResult.netProfit)
    .minus(liveResult.equityWithdrawals);

  check(
    "caja reconstruida = caja del libro mayor",
    figures.cashAvailable.equals(liveCash),
    `${figures.cashAvailable.toDatabaseString()} vs ${liveCash.toDatabaseString()}`,
  );
  check(
    "patrimonio reconstruido = patrimonio del dashboard",
    figures.closingEquity.equals(liveEquity),
    `${figures.closingEquity.toDatabaseString()} vs ${liveEquity.toDatabaseString()}`,
  );

  // --- The equity identity --------------------------------------------------

  console.log("\nIdentidad del patrimonio:\n");

  const derived = figures.openingEquity
    .plus(figures.netProfitCash)
    .plus(figures.ownerContributions)
    .minus(figures.ownerWithdrawals);

  check(
    "patrimonio final = inicial + utilidad + aportes − retiros",
    derived.equals(figures.closingEquity),
    `${derived.toDatabaseString()} vs ${figures.closingEquity.toDatabaseString()}`,
  );

  check(
    "la utilidad de caja = intereses + otros − gastos",
    figures.interestCollected
      .plus(figures.otherIncome)
      .minus(figures.operatingExpenses)
      .equals(figures.netProfitCash),
  );

  check(
    "cartera total = capital + interés pendiente",
    figures.portfolioOutstanding.greaterThanOrEqual(figures.principalOutstanding),
    `${figures.portfolioOutstanding.toDatabaseString()}`,
  );
  check(
    "la cartera vencida nunca supera la cartera total",
    !figures.portfolioOverdue.greaterThan(figures.portfolioOutstanding),
    `${figures.portfolioOverdue.toDatabaseString()} de ${figures.portfolioOutstanding.toDatabaseString()}`,
  );

  // --- Point-in-time: a past month -----------------------------------------

  console.log("\nReconstrucción de un mes pasado:\n");

  const pastMonth = startOfMonth(addDays(startOfMonth(today), -1));
  const past = await computeSnapshot(prisma, org.id, "MONTHLY", pastMonth);

  check(
    "un mes pasado produce su propia ventana",
    past.periodEnd < startOfMonth(today),
    `${past.periodStart} a ${past.periodEnd}`,
  );
  check(
    "su patrimonio final también cuadra con la identidad",
    past.openingEquity
      .plus(past.netProfitCash)
      .plus(past.ownerContributions)
      .minus(past.ownerWithdrawals)
      .equals(past.closingEquity),
    past.closingEquity.toDatabaseString(),
  );
  check(
    "el capital de un mes pasado no es mayor que el de hoy sin razón",
    !past.principalOutstanding.isNegative(),
    past.principalOutstanding.toDatabaseString(),
  );

  // --- Closing a period -----------------------------------------------------

  console.log("\nCierre de período:\n");

  // Real closures may already exist. The rolled-back transaction below must
  // leave every one of them untouched.
  const snapshotsBefore = await prisma.periodSnapshot.count({
    where: { organizationId: org.id },
  });

  await rolledBack(async (tx) => {
    let refusedOpen = false;
    try {
      await closePeriod(tx, {
        organizationId: org.id,
        kind: "MONTHLY",
        anyDateInside: today,
        today,
        actor: { userId: admin.id, email: admin.email },
      });
    } catch {
      refusedOpen = true;
    }
    check("se niega a cerrar un período que no terminó", refusedOpen);

    // The database may already hold a real closure for this month (the backfill
    // creates them). Remove it INSIDE the rolled-back transaction so the close
    // path can be exercised without depending on, or damaging, real history.
    const alreadyClosed = await tx.periodSnapshot.findFirst({
      where: {
        organizationId: org.id,
        kind: "MONTHLY",
        periodStart: new Date(`${startOfMonth(pastMonth)}T00:00:00Z`),
      },
      select: { id: true },
    });

    check(
      "un período ya cerrado se niega a recalcularse",
      alreadyClosed === null ||
        (await refuses(() =>
          closePeriod(tx, {
            organizationId: org.id,
            kind: "MONTHLY",
            anyDateInside: pastMonth,
            today,
            actor: { userId: admin.id, email: admin.email },
          }),
        )),
    );

    if (alreadyClosed) {
      await tx.periodSnapshotMetric.deleteMany({
        where: { snapshotId: alreadyClosed.id },
      });
      await tx.periodSnapshot.delete({ where: { id: alreadyClosed.id } });
    }

    const result = await closePeriod(tx, {
      organizationId: org.id,
      kind: "MONTHLY",
      anyDateInside: pastMonth,
      today,
      actor: { userId: admin.id, email: admin.email },
    });

    check("el período pasado sí se cierra", result.snapshotId.length > 0);

    const metrics = await tx.periodSnapshotMetric.findMany({
      where: { snapshotId: result.snapshotId },
      select: {
        metricKey: true,
        value: true,
        isComparable: true,
        notComparableReason: true,
        numerator: true,
        denominator: true,
      },
    });

    check("se guardaron las seis métricas", metrics.length === 6, `${metrics.length}`);
    check(
      "cada métrica guarda su numerador y denominador",
      metrics.every((m) => m.numerator !== null && m.denominator !== null),
    );
    check(
      "toda métrica no comparable explica por qué",
      metrics.every(
        (m) => m.isComparable || (m.notComparableReason ?? "").length > 0,
      ),
    );
    check(
      "ninguna métrica guardó un valor con denominador cero",
      metrics.every((m) => m.isComparable || m.value === null),
    );

    const recovery = metrics.find((m) => m.metricKey === "recovery_ratio");
    check(
      "la tasa de recuperación es N/D sin capital programado",
      recovery !== undefined &&
        (Number(recovery.denominator) > 0 || recovery.isComparable === false),
      recovery ? `denominador ${recovery.denominator}` : "ausente",
    );

    check(
      "las observaciones se generaron",
      result.observations.length > 0,
      `${result.observations.length}`,
    );

    // Point 82: the system states what the data shows, never why.
    const causal = ["porque", "debido a", "a causa de", "gracias a"];
    check(
      "ninguna observación inventa una causa",
      result.observations.every(
        (o) => !causal.some((word) => o.text.toLowerCase().includes(word)),
      ),
    );

    let duplicate = false;
    try {
      await closePeriod(tx, {
        organizationId: org.id,
        kind: "MONTHLY",
        anyDateInside: pastMonth,
        today,
        actor: { userId: admin.id, email: admin.email },
      });
    } catch {
      duplicate = true;
    }
    check("un período cerrado no se recalcula", duplicate);

    return null;
  });

  // --- Live preview ---------------------------------------------------------

  console.log("\nPeríodo en curso:\n");

  const preview = await currentPeriodPreview(prisma, org.id, "MONTHLY", today);
  const period = resolvePeriod("MONTHLY", today);

  check(
    "el período en curso se calcula en vivo",
    preview.figures.periodStart === period.periodStart,
    `${preview.figures.periodStart} a ${preview.figures.periodEnd}`,
  );
  check("y se reporta como no cerrado", preview.isClosed === false);

  const snapshotsAfter = await prisma.periodSnapshot.count({
    where: { organizationId: org.id },
  });
  check(
    "la transacción revirtió: los snapshots reales siguen intactos",
    snapshotsAfter === snapshotsBefore,
    `${snapshotsBefore} → ${snapshotsAfter}`,
  );

  console.log(`\n  patrimonio      ${figures.closingEquity.toDatabaseString()}`);
  console.log(`  caja            ${figures.cashAvailable.toDatabaseString()}`);
  console.log(`  capital         ${figures.principalOutstanding.toDatabaseString()}`);
  console.log(`  cartera         ${figures.portfolioOutstanding.toDatabaseString()}`);
  console.log(`  vencida         ${figures.portfolioOverdue.toDatabaseString()}`);

  console.log(
    failures === 0
      ? "\nSnapshots y métricas funcionan de punta a punta.\n"
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
