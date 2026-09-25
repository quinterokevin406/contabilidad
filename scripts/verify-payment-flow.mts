/**
 * Integration check for the payment path.
 *
 * Posts real payments through the real service against the real database, then
 * ROLLS EVERYTHING BACK. Unit tests already prove the allocation engine; this
 * proves the wiring around it — that allocations are written, periods updated,
 * the principal moved, cash movements created with the right financial classes,
 * the audit entry recorded, and idempotency actually enforced.
 *
 * Nothing survives this script. It aborts every transaction on purpose.
 */

import { PrismaPg } from "@prisma/adapter-pg";

import { Money } from "@/core/money/money";
import { todayIn } from "@/core/time/calendar-date";
import { PrismaClient } from "@/generated/prisma";
import { fromDb } from "@/infra/db/money";
import { postPayment } from "@/services/payments/post-payment";

if (!process.env.DATABASE_URL) process.loadEnvFile(".env");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const SETTINGS = { dueSoonLeadDays: 3, overdueGraceDays: 0 };

let failures = 0;

function check(label: string, pass: boolean, detail = "") {
  if (!pass) failures += 1;
  console.log(`  ${pass ? "OK  " : "FALLA"} ${label}${detail ? ` — ${detail}` : ""}`);
}

/** Aborts the surrounding transaction while carrying a value out of it. */
class Rollback<T> extends Error {
  constructor(readonly value: T) {
    super("rollback");
  }
}

async function inRolledBackTx<T>(fn: (tx: any) => Promise<T>): Promise<T> {
  return prisma
    .$transaction(async (tx) => {
      const value = await fn(tx);
      throw new Rollback(value);
    }, { timeout: 30_000 })
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

  // A loan carrying unpaid interest, so both destinations get exercised.
  const target = await prisma.loan.findFirstOrThrow({
    where: {
      organizationId: org.id,
      lifecycle: "ACTIVE",
      compliance: "OVERDUE",
      archivedAt: null,
    },
    select: {
      id: true,
      code: true,
      outstandingPrincipal: true,
      client: { select: { fullName: true } },
    },
    orderBy: { daysOverdue: "desc" },
  });

  const openInterest = await prisma.loanPeriod.findMany({
    where: { loanId: target.id, status: { in: ["PENDING", "PARTIALLY_PAID"] } },
    select: { interestAccrued: true, interestPaid: true, interestWaived: true },
  });
  const owedInterest = openInterest.reduce(
    (acc, p) =>
      acc.plus(
        fromDb(p.interestAccrued)
          .minus(fromDb(p.interestPaid))
          .minus(fromDb(p.interestWaived)),
      ),
    Money.zero(),
  );

  console.log(
    `\nPréstamo de prueba: ${target.code} (${target.client.fullName})`,
  );
  console.log(`  capital  ${fromDb(target.outstandingPrincipal).toDatabaseString()}`);
  console.log(`  interés  ${owedInterest.toDatabaseString()}\n`);

  // --- 1. Payment that covers interest and spills into principal ----------

  const amount = owedInterest.plus("100000");

  console.log(`Pago automático de ${amount.toDatabaseString()}:\n`);

  await inRolledBackTx(async (tx) => {
    const before = await tx.cashMovement.count({ where: { organizationId: org.id } });

    const result = await postPayment(tx, {
      organizationId: org.id,
      loanId: target.id,
      amount,
      paidOn: today,
      actor: { userId: admin.id, email: admin.email },
      settings: SETTINGS,
    });

    check(
      "el pago se aplicó primero a interés",
      result.plan.interestTotal.equals(owedInterest),
      `${result.plan.interestTotal.toDatabaseString()} de ${owedInterest.toDatabaseString()}`,
    );
    check(
      "el excedente fue a capital",
      result.plan.principalTotal.equals("100000"),
      result.plan.principalTotal.toDatabaseString(),
    );

    const allocations = await tx.paymentAllocation.findMany({
      where: { paymentId: result.paymentId },
      select: { kind: true, amount: true, loanPeriodId: true },
    });
    const allocSum = allocations.reduce(
      (acc: Money, a: { amount: unknown }) => acc.plus(fromDb(a.amount as never)),
      Money.zero(),
    );
    check(
      "las allocations suman exactamente el pago",
      allocSum.equals(amount),
      `${allocSum.toDatabaseString()} vs ${amount.toDatabaseString()}`,
    );
    check(
      "toda allocation de interés apunta a un período",
      allocations
        .filter((a: { kind: string }) => a.kind === "INTEREST")
        .every((a: { loanPeriodId: string | null }) => a.loanPeriodId !== null),
    );

    const movements = await tx.cashMovement.findMany({
      where: { paymentId: result.paymentId },
      select: { financialClass: true, direction: true, amount: true },
    });
    check(
      "se crearon movimientos de caja separados por clase",
      movements.length === 2 &&
        movements.some((m: { financialClass: string }) => m.financialClass === "INTEREST") &&
        movements.some((m: { financialClass: string }) => m.financialClass === "PRINCIPAL"),
      movements.map((m: { financialClass: string }) => m.financialClass).join(" + "),
    );
    check(
      "todos los movimientos son positivos y entrantes",
      movements.every(
        (m: { direction: string; amount: unknown }) =>
          m.direction === "IN" && fromDb(m.amount as never).isPositive(),
      ),
    );
    check(
      "no se crearon movimientos de más",
      (await tx.cashMovement.count({ where: { organizationId: org.id } })) ===
        before + 2,
    );

    const loanAfter = await tx.loan.findUniqueOrThrow({
      where: { id: target.id },
      select: { outstandingPrincipal: true },
    });
    check(
      "el capital del préstamo bajó exactamente lo aplicado",
      fromDb(loanAfter.outstandingPrincipal).equals(
        fromDb(target.outstandingPrincipal).minus("100000"),
      ),
      fromDb(loanAfter.outstandingPrincipal).toDatabaseString(),
    );

    const audit = await tx.auditLog.findFirst({
      where: { entity: "Payment", entityId: result.paymentId },
      select: { action: true, actorEmail: true },
    });
    check("quedó registro de auditoría", audit?.action === "CREATE", audit?.actorEmail ?? "");

    const periods = await tx.loanPeriod.findMany({
      where: { loanId: target.id },
      select: { status: true, interestAccrued: true, interestPaid: true },
    });
    check(
      "ningún período quedó con más pagado que causado",
      periods.every(
        (p: { interestAccrued: unknown; interestPaid: unknown }) =>
          !fromDb(p.interestPaid as never).greaterThan(
            fromDb(p.interestAccrued as never),
          ),
      ),
    );

    return null;
  });

  // --- 2. Partial payment leaves the period open --------------------------

  console.log(`\nPago parcial de 50.000:\n`);

  await inRolledBackTx(async (tx) => {
    const result = await postPayment(tx, {
      organizationId: org.id,
      loanId: target.id,
      amount: "50000",
      paidOn: today,
      actor: { userId: admin.id, email: admin.email },
      settings: SETTINGS,
    });

    check(
      "todo fue a interés, nada a capital",
      result.plan.interestTotal.equals("50000") &&
        result.plan.principalTotal.isZero(),
    );

    const touched = result.plan.periodOutcomes.filter((o) =>
      o.interestApplied.isPositive(),
    );
    check(
      "el período quedó PARCIAL, no pagado",
      touched.length === 1 && touched[0]!.fullySettled === false,
    );

    const period = await tx.loanPeriod.findFirstOrThrow({
      where: { id: touched[0]!.periodId },
      select: { status: true, settledAt: true },
    });
    check(
      "la fila del período refleja el estado parcial",
      period.status === "PARTIALLY_PAID" && period.settledAt === null,
      period.status,
    );

    return null;
  });

  // --- 3. Idempotency ------------------------------------------------------

  console.log(`\nIdempotencia (doble envío con la misma clave):\n`);

  await inRolledBackTx(async (tx) => {
    const key = `test_${Date.now()}`;

    await postPayment(tx, {
      organizationId: org.id,
      loanId: target.id,
      amount: "50000",
      paidOn: today,
      actor: { userId: admin.id, email: admin.email },
      idempotencyKey: key,
      settings: SETTINGS,
    });

    let secondRejected = false;
    try {
      await postPayment(tx, {
        organizationId: org.id,
        loanId: target.id,
        amount: "50000",
        paidOn: today,
        actor: { userId: admin.id, email: admin.email },
        idempotencyKey: key,
        settings: SETTINGS,
      });
    } catch {
      secondRejected = true;
    }

    check("el segundo envío fue rechazado", secondRejected);
    check(
      "solo se registró un pago",
      (await tx.payment.count({ where: { loanId: target.id, amount: "50000" } })) === 1,
    );

    return null;
  });

  // --- 4. Nothing survived -------------------------------------------------

  console.log(`\nVerificando que no quedó nada:\n`);

  const leftovers = await prisma.payment.count({
    where: { organizationId: org.id, paidOn: new Date(`${today}T00:00:00Z`) },
  });
  check("no quedaron pagos de prueba en la base", leftovers === 0, `${leftovers}`);

  console.log(
    failures === 0
      ? "\nEl flujo de pago funciona de punta a punta.\n"
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
