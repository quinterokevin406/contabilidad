/**
 * Integration check for subscription billing.
 *
 * Two things have to be true and they pull in opposite directions: somebody who
 * has not paid must actually lose access, and somebody who pays must get it
 * back instantly and without losing a single record. This exercises both
 * against the real database and then rolls everything back.
 *
 * The unit tests already prove the date arithmetic. This proves the wiring —
 * that a payment writes its row, moves paidThrough, reactivates the business,
 * and that the enforcement job cuts off exactly the right people.
 */

import { Money } from "@/core/money/money";
import { addDays, todayIn, toPrismaDate } from "@/core/time/calendar-date";
import { createSystemClient } from "@/infra/db/system-client";
import {
  enforceSubscriptions,
  recordSubscriptionPayment,
} from "@/services/billing/record-payment";

const prisma = createSystemClient();
const TZ = "America/Bogota";

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

const actor = { userId: null, email: "verificacion@plataforma" };

async function main() {
  const today = todayIn(TZ);
  const org = await prisma.organization.findFirstOrThrow({
    select: { id: true, name: true },
  });

  console.log(`\nNegocio de prueba: ${org.name}  (hoy ${today})\n`);

  // --- A subscription that ran out twenty days ago -----------------------

  console.log("1. El corte automático");

  const enforcement = await inRolledBackTx(async (tx) => {
    await tx.subscription.deleteMany({ where: { organizationId: org.id } });
    await tx.subscription.create({
      data: {
        organizationId: org.id,
        price: "20.00",
        currencyCode: "USD",
        billingDay: 1,
        graceDays: 5,
        renewalBasis: "PREVIOUS_DUE_DATE",
        // Ran out twenty days ago: well past five days of grace.
        paidThrough: toPrismaDate(addDays(today, -20)),
        startedAt: toPrismaDate(addDays(today, -120)),
        status: "ACTIVE",
      },
    });

    const dry = await enforceSubscriptions(tx, {
      timeZone: TZ,
      actor,
      dryRun: true,
    });

    const afterDry = await tx.organization.findUniqueOrThrow({
      where: { id: org.id },
      select: { status: true },
    });

    const real = await enforceSubscriptions(tx, { timeZone: TZ, actor });

    const afterReal = await tx.organization.findUniqueOrThrow({
      where: { id: org.id },
      select: { status: true },
    });

    return { dry, afterDry, real, afterReal };
  });

  check(
    "la simulación lo detecta",
    enforcement.dry.suspended.some((s: any) => s.organizationId === org.id),
    `${enforcement.dry.suspended.length} detectados`,
  );
  check(
    "la simulación NO cambia nada",
    enforcement.afterDry.status === "ACTIVE",
    enforcement.afterDry.status,
  );
  check(
    "la corrida real suspende",
    enforcement.afterReal.status === "SUSPENDED",
    enforcement.afterReal.status,
  );

  // --- Inside the grace window, nobody is cut off ------------------------

  console.log("\n2. Dentro de la gracia no se corta a nadie");

  const grace = await inRolledBackTx(async (tx) => {
    await tx.subscription.deleteMany({ where: { organizationId: org.id } });
    await tx.subscription.create({
      data: {
        organizationId: org.id,
        price: "20.00",
        currencyCode: "USD",
        billingDay: 1,
        graceDays: 5,
        renewalBasis: "PREVIOUS_DUE_DATE",
        // Two days late, five days of grace.
        paidThrough: toPrismaDate(addDays(today, -2)),
        startedAt: toPrismaDate(addDays(today, -60)),
        status: "ACTIVE",
      },
    });

    const result = await enforceSubscriptions(tx, { timeZone: TZ, actor });
    const org2 = await tx.organization.findUniqueOrThrow({
      where: { id: org.id },
      select: { status: true },
    });
    const sub = await tx.subscription.findUniqueOrThrow({
      where: { organizationId: org.id },
      select: { status: true },
    });
    return { result, orgStatus: org2.status, subStatus: sub.status };
  });

  check(
    "sigue con acceso",
    grace.orgStatus === "ACTIVE",
    grace.orgStatus,
  );
  check(
    "pero queda marcado como vencido",
    grace.subStatus === "PAST_DUE",
    grace.subStatus,
  );

  // --- A trial is never touched ------------------------------------------

  console.log("\n3. Una prueba sin pagos nunca se corta sola");

  const trial = await inRolledBackTx(async (tx) => {
    await tx.subscription.deleteMany({ where: { organizationId: org.id } });
    await tx.subscription.create({
      data: {
        organizationId: org.id,
        price: "20.00",
        currencyCode: "USD",
        billingDay: 1,
        graceDays: 5,
        renewalBasis: "PREVIOUS_DUE_DATE",
        paidThrough: null,
        startedAt: toPrismaDate(addDays(today, -365)),
        status: "TRIAL",
      },
    });
    await enforceSubscriptions(tx, { timeZone: TZ, actor });
    return tx.organization.findUniqueOrThrow({
      where: { id: org.id },
      select: { status: true },
    });
  });

  check("sigue activa después de un año", trial.status === "ACTIVE");

  // --- Paying gets you back in, immediately ------------------------------

  console.log("\n4. Pagar devuelve el acceso en el acto");

  const payment = await inRolledBackTx(async (tx) => {
    const before = await financialFootprint(tx, org.id);

    await tx.subscription.deleteMany({ where: { organizationId: org.id } });
    await tx.subscription.create({
      data: {
        organizationId: org.id,
        price: "20.00",
        currencyCode: "USD",
        billingDay: 1,
        graceDays: 5,
        renewalBasis: "PREVIOUS_DUE_DATE",
        paidThrough: toPrismaDate(addDays(today, -20)),
        startedAt: toPrismaDate(addDays(today, -120)),
        status: "ACTIVE",
      },
    });

    await enforceSubscriptions(tx, { timeZone: TZ, actor });

    const suspended = await tx.organization.findUniqueOrThrow({
      where: { id: org.id },
      select: { status: true },
    });

    const result = await recordSubscriptionPayment(tx, {
      organizationId: org.id,
      amount: Money.of("20.00"),
      paidOn: today,
      method: "Transferencia",
      reference: "VERIF-001",
      periods: 1,
      actor,
      timeZone: TZ,
    });

    const after = await tx.organization.findUniqueOrThrow({
      where: { id: org.id },
      select: { status: true },
    });

    const sub = await tx.subscription.findUniqueOrThrow({
      where: { organizationId: org.id },
      select: { paidThrough: true, status: true },
    });

    const row = await tx.subscriptionPayment.findUniqueOrThrow({
      where: { id: result.paymentId },
      select: { amount: true, method: true, reference: true, coversFrom: true },
    });

    const footprint = await financialFootprint(tx, org.id);

    return { before, suspended, result, after, sub, row, footprint };
  });

  check(
    "estaba suspendido antes del pago",
    payment.suspended.status === "SUSPENDED",
  );
  check(
    "el pago lo reactiva",
    payment.after.status === "ACTIVE" && payment.result.reactivated,
  );
  check(
    "la cobertura arranca donde terminó la anterior",
    payment.result.coversFrom === addDays(today, -19),
    `${payment.result.coversFrom} (atrasarse no regala días)`,
  );
  check(
    "quedó el registro del pago con su referencia",
    payment.row.reference === "VERIF-001" &&
      payment.row.method === "Transferencia",
  );
  check(
    "la suscripción queda al día",
    payment.sub.status === "ACTIVE",
    payment.sub.status,
  );
  check(
    "no se tocó ni una fila financiera del prestamista",
    JSON.stringify(payment.before) === JSON.stringify(payment.footprint),
    `${payment.before.payments} pagos, ${payment.before.movements} movimientos`,
  );

  // --- Nothing leaked -----------------------------------------------------

  console.log("\n5. Nada quedó escrito");

  const leaked = await prisma.subscriptionPayment.count({
    where: { reference: "VERIF-001" },
  });
  check("no quedó ningún pago de prueba", leaked === 0);

  console.log(
    failures === 0
      ? "\nTodo en orden.\n"
      : `\n${failures} comprobación(es) fallaron.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

/** The lender's own books, which billing must never touch. */
async function financialFootprint(tx: any, organizationId: string) {
  const [clients, loans, payments, movements] = await Promise.all([
    tx.client.count({ where: { organizationId } }),
    tx.loan.count({ where: { organizationId } }),
    tx.payment.count({ where: { organizationId } }),
    tx.cashMovement.count({ where: { organizationId } }),
  ]);
  return { clients, loans, payments, movements };
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
