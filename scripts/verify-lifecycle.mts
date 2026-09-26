/**
 * Integration check for renewals and settlements.
 *
 * Runs the real services against the real database and rolls everything back.
 * Unit tests cover the engines; this covers the wiring — period closure, capital
 * movement, cash in BOTH directions, the schedule anchor surviving repeated
 * renewals, and a settlement actually landing the loan on zero.
 */

import { Money } from "@/core/money/money";
import { todayIn } from "@/core/time/calendar-date";
import { fromDb } from "@/infra/db/money";
import { createSystemClient } from "@/infra/db/system-client";
import { renewLoan } from "@/services/loans/renew";
import { quoteLoanSettlement, settleLoan } from "@/services/loans/settle";
import type { Tx } from "@/services/shared";

if (!process.env.DATABASE_URL) process.loadEnvFile(".env");

const prisma = createSystemClient();

const SETTINGS = { dueSoonLeadDays: 3, overdueGraceDays: 0 };

let failures = 0;

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
      { timeout: 60_000 },
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
  const actor = { userId: admin.id, email: admin.email };
  const today = todayIn("America/Bogota");

  // A loan with accrued unpaid interest, so a renewal has something to close.
  const target = await prisma.loan.findFirstOrThrow({
    where: {
      organizationId: org.id,
      lifecycle: "ACTIVE",
      compliance: "OVERDUE",
      archivedAt: null,
    },
    orderBy: { daysOverdue: "desc" },
    select: {
      id: true,
      code: true,
      outstandingPrincipal: true,
      renewalCount: true,
      client: { select: { fullName: true } },
    },
  });

  const owedInterest = (
    await prisma.loanPeriod.findMany({
      where: { loanId: target.id, status: { in: ["PENDING", "PARTIALLY_PAID"] } },
      select: { interestAccrued: true, interestPaid: true, interestWaived: true },
    })
  ).reduce(
    (acc, p) =>
      acc.plus(
        fromDb(p.interestAccrued)
          .minus(fromDb(p.interestPaid))
          .minus(fromDb(p.interestWaived)),
      ),
    Money.zero(),
  );

  const principal = fromDb(target.outstandingPrincipal);

  console.log(`\nPréstamo de prueba: ${target.code} (${target.client.fullName})`);
  console.log(`  capital  ${principal.toDatabaseString()}`);
  console.log(`  interés  ${owedInterest.toDatabaseString()}\n`);

  // --- 1. Renewal keeping the capital (point 13) ---------------------------

  console.log("Renovación con capital sin cambio:\n");

  await rolledBack(async (tx) => {
    const before = await tx.cashMovement.count({ where: { organizationId: org.id } });

    const result = await renewLoan(tx, {
      organizationId: org.id,
      loanId: target.id,
      interestPaid: owedInterest,
      capitalChange: { kind: "UNCHANGED" },
      effectiveOn: today,
      actor,
      settings: SETTINGS,
    });

    check(
      "el capital continúa igual",
      result.newPrincipalBase.equals(principal),
      result.newPrincipalBase.toDatabaseString(),
    );
    check("el contador de renovaciones subió", result.sequence === target.renewalCount + 1);

    const closed = await tx.loanPeriod.count({
      where: { loanId: target.id, closedByRenewalId: result.renewalId },
    });
    check("los períodos quedaron marcados como cerrados por la renovación", closed > 0, `${closed}`);

    const stillOpen = await tx.loanPeriod.count({
      where: { loanId: target.id, status: { in: ["PENDING", "PARTIALLY_PAID"] } },
    });
    check("no quedó interés pendiente", stillOpen === 0, `${stillOpen} abiertos`);

    const movements = await tx.cashMovement.findMany({
      where: { renewalId: result.renewalId },
      select: { financialClass: true, direction: true },
    });
    check(
      "entró el interés como clase INTEREST",
      movements.some(
        (m) => m.financialClass === "INTEREST" && m.direction === "IN",
      ),
    );
    check(
      "no se crearon movimientos de más",
      (await tx.cashMovement.count({ where: { organizationId: org.id } })) ===
        before + movements.length,
    );

    return null;
  });

  // --- 2. Renewal taking more capital (point 14) ---------------------------

  console.log("\nRenovación con capital adicional de 500.000:\n");

  await rolledBack(async (tx) => {
    const result = await renewLoan(tx, {
      organizationId: org.id,
      loanId: target.id,
      interestPaid: owedInterest,
      capitalChange: { kind: "INCREASE", additionalDisbursed: "500000" },
      effectiveOn: today,
      actor,
      settings: SETTINGS,
    });

    check(
      "el capital subió exactamente lo entregado",
      result.newPrincipalBase.equals(principal.plus("500000")),
      result.newPrincipalBase.toDatabaseString(),
    );

    const out = await tx.cashMovement.findFirst({
      where: { renewalId: result.renewalId, direction: "OUT" },
      select: { financialClass: true, amount: true },
    });
    check(
      "salió el capital adicional como clase PRINCIPAL",
      out?.financialClass === "PRINCIPAL" &&
        fromDb(out.amount).equals("500000"),
      out ? fromDb(out.amount).toDatabaseString() : "sin movimiento",
    );

    const loan = await tx.loan.findUniqueOrThrow({
      where: { id: target.id },
      select: { outstandingPrincipal: true },
    });
    check(
      "el préstamo refleja el capital nuevo",
      fromDb(loan.outstandingPrincipal).equals(principal.plus("500000")),
    );

    return null;
  });

  // --- 3. Two renewals in a row: the anchor bug -----------------------------

  console.log("\nDos renovaciones consecutivas (regresión del ancla):\n");

  await rolledBack(async (tx) => {
    const first = await renewLoan(tx, {
      organizationId: org.id,
      loanId: target.id,
      interestPaid: owedInterest,
      capitalChange: { kind: "UNCHANGED" },
      effectiveOn: today,
      actor,
      settings: SETTINGS,
    });

    // Push time forward far enough that the renewed period comes due.
    const laterDate = first.newDueOn;

    let secondFailed: string | null = null;
    try {
      const openInterest = await accrueAndOwed(tx, target.id, laterDate);
      await renewLoan(tx, {
        organizationId: org.id,
        loanId: target.id,
        interestPaid: openInterest,
        capitalChange: { kind: "UNCHANGED" },
        effectiveOn: laterDate,
        actor,
        settings: SETTINGS,
      });
    } catch (error: unknown) {
      secondFailed = error instanceof Error ? error.message : String(error);
    }

    check(
      "la segunda renovación no choca con los períodos de la primera",
      secondFailed === null,
      secondFailed ?? "",
    );

    const indices = await tx.loanPeriod.findMany({
      where: { loanId: target.id },
      select: { periodIndex: true },
      orderBy: { periodIndex: "asc" },
    });
    const unique = new Set(indices.map((p) => p.periodIndex));
    check(
      "los índices de período siguen siendo únicos y crecientes",
      unique.size === indices.length,
      `${indices.length} períodos, ${unique.size} índices`,
    );

    return null;
  });

  // --- 4. Settlement (point 16) --------------------------------------------

  console.log("\nLiquidación total:\n");

  await rolledBack(async (tx) => {
    const { quote } = await quoteLoanSettlement(tx, {
      organizationId: org.id,
      loanId: target.id,
      asOf: today,
    });

    check(
      "la cotización suma capital + interés + período en curso",
      quote.total.equals(
        quote.principalOutstanding
          .plus(quote.accruedInterestOutstanding)
          .plus(quote.openPeriodCharge),
      ),
      quote.total.toDatabaseString(),
    );

    const result = await settleLoan(tx, {
      organizationId: org.id,
      loanId: target.id,
      asOf: today,
      kind: "FULL_PAYMENT",
      amountReceived: quote.total,
      actor,
      settings: SETTINGS,
    });

    const loan = await tx.loan.findUniqueOrThrow({
      where: { id: target.id },
      select: { lifecycle: true, outstandingPrincipal: true, closedOn: true },
    });

    check("el préstamo quedó PAGADO", loan.lifecycle === "PAID", loan.lifecycle);
    check(
      "el capital quedó exactamente en cero",
      fromDb(loan.outstandingPrincipal).isZero(),
      fromDb(loan.outstandingPrincipal).toDatabaseString(),
    );
    check("quedó registrada la fecha de cierre", loan.closedOn !== null);

    const open = await tx.loanPeriod.count({
      where: { loanId: target.id, status: { in: ["PENDING", "PARTIALLY_PAID"] } },
    });
    check("no quedó ningún período abierto", open === 0, `${open}`);

    const allocations = await tx.paymentAllocation.findMany({
      where: { paymentId: result.paymentId! },
      select: { amount: true },
    });
    const allocSum = allocations.reduce(
      (acc, a) => acc.plus(fromDb(a.amount)),
      Money.zero(),
    );
    check(
      "las allocations suman exactamente lo recibido",
      allocSum.equals(quote.total),
      `${allocSum.toDatabaseString()} vs ${quote.total.toDatabaseString()}`,
    );

    const settlement = await tx.settlement.findUniqueOrThrow({
      where: { loanId: target.id },
      select: {
        kind: true,
        openPeriodPolicyApplied: true,
        openPeriodCharge: true,
        amountWrittenOff: true,
      },
    });
    check(
      "quedó registrada la política aplicada al período en curso",
      settlement.openPeriodPolicyApplied.length > 0,
      settlement.openPeriodPolicyApplied,
    );
    check(
      "no se castigó nada en una liquidación pagada",
      fromDb(settlement.amountWrittenOff).isZero(),
    );

    return null;
  });

  // --- 5. Write-off: a real loss that moves no cash -------------------------

  console.log("\nCastigo de cartera (recibiendo 0):\n");

  await rolledBack(async (tx) => {
    const { quote } = await quoteLoanSettlement(tx, {
      organizationId: org.id,
      loanId: target.id,
      asOf: today,
    });

    const result = await settleLoan(tx, {
      organizationId: org.id,
      loanId: target.id,
      asOf: today,
      kind: "WRITE_OFF",
      amountReceived: "0",
      reason: "Cliente ilocalizable desde hace seis meses",
      actor,
      settings: SETTINGS,
    });

    check(
      "no se creó recibo cuando no entró dinero",
      result.paymentId === null && result.receiptNumber === null,
    );
    check(
      "se castigó todo el capital pendiente",
      result.principalWrittenOff.equals(quote.principalOutstanding),
      result.principalWrittenOff.toDatabaseString(),
    );

    const loan = await tx.loan.findUniqueOrThrow({
      where: { id: target.id },
      select: { lifecycle: true, outstandingPrincipal: true },
    });
    check(
      "el préstamo quedó CANCELADO, no pagado",
      loan.lifecycle === "CANCELLED",
      loan.lifecycle,
    );
    check(
      "el capital quedó en cero",
      fromDb(loan.outstandingPrincipal).isZero(),
    );

    const open = await tx.loanPeriod.count({
      where: { loanId: target.id, status: { in: ["PENDING", "PARTIALLY_PAID"] } },
    });
    check("no quedó ningún período abierto", open === 0, `${open}`);

    const waived = await tx.loanPeriod.count({
      where: { loanId: target.id, status: "WAIVED" },
    });
    check("el interés no cobrado quedó condonado", waived > 0, `${waived} períodos`);

    const writeOff = await tx.cashMovement.findFirstOrThrow({
      where: { loanId: target.id, type: "PRINCIPAL_WRITE_OFF" },
      select: { financialClass: true, affectsCash: true, amount: true, note: true },
    });
    check(
      "el castigo quedó como gasto operativo",
      writeOff.financialClass === "OPERATING_EXPENSE",
      writeOff.financialClass,
    );
    check(
      "el castigo NO mueve la caja",
      writeOff.affectsCash === false,
    );
    check(
      "el monto del castigo es el capital perdido",
      fromDb(writeOff.amount).equals(quote.principalOutstanding),
      fromDb(writeOff.amount).toDatabaseString(),
    );
    check("el motivo quedó registrado", (writeOff.note ?? "").includes("ilocalizable"));

    const settlement = await tx.settlement.findUniqueOrThrow({
      where: { loanId: target.id },
      select: { kind: true, amountWrittenOff: true, reason: true },
    });
    check("la liquidación quedó marcada como castigo", settlement.kind === "WRITE_OFF");
    check(
      "se registró cuánto se castigó en total",
      fromDb(settlement.amountWrittenOff).isPositive(),
      fromDb(settlement.amountWrittenOff).toDatabaseString(),
    );

    return null;
  });

  console.log("\nCastigo sin motivo:\n");

  await rolledBack(async (tx) => {
    let rejected = false;
    try {
      await settleLoan(tx, {
        organizationId: org.id,
        loanId: target.id,
        asOf: today,
        kind: "WRITE_OFF",
        amountReceived: "0",
        reason: "",
        actor,
        settings: SETTINGS,
      });
    } catch {
      rejected = true;
    }
    check("un castigo sin motivo es rechazado", rejected);
    return null;
  });

  // --- 6. Nothing survived --------------------------------------------------

  console.log("\nVerificando que no quedó nada:\n");

  const loanAfter = await prisma.loan.findUniqueOrThrow({
    where: { id: target.id },
    select: { lifecycle: true, renewalCount: true, outstandingPrincipal: true },
  });
  check(
    "el préstamo sigue activo e intacto",
    loanAfter.lifecycle === "ACTIVE" &&
      loanAfter.renewalCount === target.renewalCount &&
      fromDb(loanAfter.outstandingPrincipal).equals(principal),
    `${loanAfter.lifecycle}, ${loanAfter.renewalCount} renovaciones`,
  );
  check(
    "no quedaron liquidaciones de prueba",
    (await prisma.settlement.count({ where: { loanId: target.id } })) === 0,
  );

  console.log(
    failures === 0
      ? "\nRenovaciones y liquidaciones funcionan de punta a punta.\n"
      : `\n${failures} verificaciones fallaron.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

async function accrueAndOwed(tx: Tx, loanId: string, date: string) {
  const { accrueLoan } = await import("@/services/loans/accrue");
  await accrueLoan(tx, loanId, date as never);

  const periods = await tx.loanPeriod.findMany({
    where: { loanId, status: { in: ["PENDING", "PARTIALLY_PAID"] } },
    select: { interestAccrued: true, interestPaid: true, interestWaived: true },
  });

  return periods.reduce(
    (acc, p) =>
      acc.plus(
        fromDb(p.interestAccrued)
          .minus(fromDb(p.interestPaid))
          .minus(fromDb(p.interestWaived)),
      ),
    Money.zero(),
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
