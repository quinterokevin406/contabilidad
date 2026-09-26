/**
 * Integration check for reversals (points 33-34).
 *
 * A reversal is the only way to correct a financial mistake in this system, so
 * it has to be exactly as trustworthy as the payment it undoes. This proves,
 * against the real database, that:
 *
 *   - the loan goes back to the balance it had before the payment;
 *   - the interest the payment had settled is owed again;
 *   - the cash that came in goes back out, class by class;
 *   - the original payment is still there, flagged, never deleted;
 *   - a reversed payment cannot be reversed a second time.
 *
 * Nothing survives this script. Every transaction is aborted on purpose.
 */

import { PrismaPg } from "@prisma/adapter-pg";

import { Money } from "@/core/money/money";
import { todayIn } from "@/core/time/calendar-date";
import { PrismaClient } from "@/generated/prisma";
import { fromDb } from "@/infra/db/money";
import { createSystemClient } from "@/infra/db/system-client";
import { postPayment } from "@/services/payments/post-payment";
import { reversePayment } from "@/services/reversals/reverse-payment";

if (!process.env.DATABASE_URL) process.loadEnvFile(".env");

const prisma = createSystemClient();

const SETTINGS = { dueSoonLeadDays: 3, overdueGraceDays: 0 };

/** Big enough to settle the overdue interest AND reach principal, so the
 *  reversal has to compensate two financial classes, not one. */
const PAYMENT_AMOUNT = Money.of("1500000");

let failures = 0;

function check(label: string, pass: boolean, detail = "") {
  if (!pass) failures += 1;
  console.log(
    `  ${pass ? "OK  " : "FALLA"} ${label}${detail ? ` — ${detail}` : ""}`,
  );
}

class Rollback<T> extends Error {
  constructor(readonly value: T) {
    super("rollback");
  }
}

async function inRolledBackTx<T>(fn: (tx: any) => Promise<T>): Promise<T> {
  return prisma
    .$transaction(
      async (tx) => {
        const value = await fn(tx);
        throw new Rollback(value);
      },
      { timeout: 30_000 },
    )
    .catch((error: unknown) => {
      if (error instanceof Rollback) return error.value as T;
      throw error;
    });
}

async function main() {
  const org = await prisma.organization.findFirstOrThrow({
    select: { id: true },
  });
  const admin = await prisma.user.findFirstOrThrow({
    where: { organizationId: org.id },
    select: { id: true, email: true },
  });
  const today = todayIn("America/Bogota");

  const target = await prisma.loan.findFirstOrThrow({
    where: {
      organizationId: org.id,
      lifecycle: "ACTIVE",
      compliance: "OVERDUE",
      archivedAt: null,
    },
    select: { id: true, code: true, clientId: true },
  });

  const actor = { userId: admin.id, email: admin.email };

  console.log(`\nPréstamo de prueba: ${target.code}\n`);

  // --- 1. A payment, then its reversal, inside one rolled-back transaction ---

  console.log("1. Un pago y su anulación");

  const roundTrip = await inRolledBackTx(async (tx) => {
    const before = await snapshotLoan(tx, target.id);

    const payment = await postPayment(tx, {
      organizationId: org.id,
      loanId: target.id,
      amount: PAYMENT_AMOUNT,
      paidOn: today,
      actor,
      settings: SETTINGS,
      idempotencyKey: `verify_rev_${crypto.randomUUID()}`,
    });

    const afterPayment = await snapshotLoan(tx, target.id);

    const reversal = await reversePayment(tx, {
      organizationId: org.id,
      paymentId: payment.paymentId,
      reason: "Verificación automática de anulaciones",
      reversedOn: today,
      actor,
      settings: SETTINGS,
    });

    const afterReversal = await snapshotLoan(tx, target.id);

    const original = await tx.payment.findUniqueOrThrow({
      where: { id: payment.paymentId },
      select: {
        status: true,
        amount: true,
        receiptNumber: true,
        allocations: { select: { id: true } },
      },
    });

    const mirrored = await tx.cashMovement.findMany({
      where: { reversesMovementId: { not: null } },
      select: {
        amount: true,
        direction: true,
        financialClass: true,
        reversesMovementId: true,
      },
    });

    // Reversing the same payment twice would double every compensation.
    let refusedTwice = false;
    try {
      await reversePayment(tx, {
        organizationId: org.id,
        paymentId: payment.paymentId,
        reason: "Intento de anulación repetida",
        reversedOn: today,
        actor,
        settings: SETTINGS,
      });
    } catch {
      refusedTwice = true;
    }

    return {
      before,
      afterPayment,
      afterReversal,
      original,
      mirrored,
      refusedTwice,
      reversal,
      paymentAmount: PAYMENT_AMOUNT,
    };
  });

  check(
    "el pago movió el saldo del préstamo",
    !roundTrip.afterPayment.total.equals(roundTrip.before.total),
    `${roundTrip.before.total.toString()} → ${roundTrip.afterPayment.total.toString()}`,
  );

  check(
    "la anulación devuelve el capital exactamente a donde estaba",
    roundTrip.afterReversal.principal.equals(roundTrip.before.principal),
    `${roundTrip.afterReversal.principal.toString()} vs ${roundTrip.before.principal.toString()}`,
  );

  check(
    "la anulación vuelve a dejar debiendo los intereses",
    roundTrip.afterReversal.interest.equals(roundTrip.before.interest),
    `${roundTrip.afterReversal.interest.toString()} vs ${roundTrip.before.interest.toString()}`,
  );

  check(
    "el saldo total queda idéntico al de antes del pago",
    roundTrip.afterReversal.total.equals(roundTrip.before.total),
    roundTrip.afterReversal.total.toString(),
  );

  // --- 2. Nothing is deleted ------------------------------------------------

  console.log("\n2. El pago original sigue existiendo");

  check(
    "el pago quedó marcado REVERSED, no borrado",
    roundTrip.original.status === "REVERSED",
    roundTrip.original.status,
  );

  check(
    "conserva su número de recibo",
    roundTrip.original.receiptNumber === roundTrip.reversal.receiptNumber,
    roundTrip.original.receiptNumber,
  );

  check(
    "conserva sus asignaciones",
    roundTrip.original.allocations.length > 0,
    `${roundTrip.original.allocations.length} asignaciones`,
  );

  check(
    "conserva su valor original",
    fromDb(roundTrip.original.amount).equals(roundTrip.paymentAmount),
    fromDb(roundTrip.original.amount).toString(),
  );

  // --- 3. Cash goes back out, class by class --------------------------------

  console.log("\n3. La caja se compensa espejo");

  check(
    "se crearon movimientos de caja enlazados al original",
    roundTrip.mirrored.length > 0,
    `${roundTrip.mirrored.length} movimientos`,
  );

  const allOut = roundTrip.mirrored.every((m: any) => m.direction === "OUT");
  check("todos salen de la caja", allOut);

  const mirroredTotal = roundTrip.mirrored.reduce(
    (sum: Money, m: any) => sum.plus(fromDb(m.amount)),
    Money.zero(),
  );
  check(
    "la caja devuelve exactamente lo que había recibido",
    mirroredTotal.equals(roundTrip.reversal.cashReturned),
    `${mirroredTotal.toString()} vs ${roundTrip.reversal.cashReturned.toString()}`,
  );

  const classes = new Set<string>(
    roundTrip.mirrored.map((m: any) => m.financialClass as string),
  );
  check(
    "los intereses y el capital se devuelven por separado",
    classes.has("INTEREST") && classes.has("PRINCIPAL"),
    `clases: ${[...classes].sort().join(", ")}`,
  );
  // Recovered capital is not profit. If a reversal booked either half as
  // operating income, the profit report would move when it must not.
  check(
    "nada se devuelve como ingreso operativo",
    !classes.has("OPERATING_INCOME") && !classes.has("OPERATING_EXPENSE"),
  );

  // --- 4. It cannot happen twice --------------------------------------------

  console.log("\n4. No se puede anular dos veces");

  check("el segundo intento fue rechazado", roundTrip.refusedTwice);

  // --- 5. Nothing leaked ----------------------------------------------------

  console.log("\n5. Nada quedó escrito");

  const leaked = await prisma.reversal.count({
    where: { reason: "Verificación automática de anulaciones" },
  });
  check("no quedó ninguna anulación de prueba en la base", leaked === 0);

  console.log(
    failures === 0
      ? "\nTodo en orden.\n"
      : `\n${failures} comprobación(es) fallaron.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

/** Loan balance as the database holds it right now. */
async function snapshotLoan(tx: any, loanId: string) {
  const loan = await tx.loan.findUniqueOrThrow({
    where: { id: loanId },
    select: { outstandingPrincipal: true, lifecycle: true },
  });

  const periods = await tx.loanPeriod.findMany({
    where: { loanId },
    select: {
      interestAccrued: true,
      interestPaid: true,
      interestWaived: true,
    },
  });

  const interest = periods.reduce(
    (sum: Money, p: any) =>
      sum.plus(
        fromDb(p.interestAccrued)
          .minus(fromDb(p.interestPaid))
          .minus(fromDb(p.interestWaived)),
      ),
    Money.zero(),
  );
  const principal = fromDb(loan.outstandingPrincipal);

  return {
    principal,
    interest,
    total: principal.plus(interest),
    lifecycle: loan.lifecycle,
  };
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
