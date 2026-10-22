/**
 * Integration check for fixed-instalment loans (points 4, 9 and 16).
 *
 * The lender's own case, end to end against the real database:
 *
 *     a million at 16%, six months, interest and capital together,
 *     six instalments of 326.700
 *
 * The unit tests already prove the arithmetic. What this proves is everything
 * around it — that the schedule reaches the database as agreed, that accrual
 * charges one instalment at a time and not the whole term, that a payment
 * splits where the schedule says it splits, that paying the capital off early
 * does NOT quietly close a loan that still owes four instalments, and that
 * cancelling early costs the capital still owed plus the period in progress,
 * with the instalments the client never reached written down as waived rather
 * than vanishing.
 *
 * Nothing survives this script. Every transaction is aborted on purpose.
 */

import { PrismaPg } from "@prisma/adapter-pg";

import { planFixedInstallments } from "@/core/loans/fixed-installment";
import { Money } from "@/core/money/money";
import { addDays, todayIn, toPrismaDate } from "@/core/time/calendar-date";
import { PrismaClient } from "@/generated/prisma";
import { fromDb } from "@/infra/db/money";
import { createSystemClient } from "@/infra/db/system-client";
import { createClient } from "@/services/clients/create-client";
import { accrueLoan, refreshLoanState } from "@/services/loans/accrue";
import { createLoan } from "@/services/loans/create-loan";
import { quoteLoanSettlement, settleLoan } from "@/services/loans/settle";
import { postPayment } from "@/services/payments/post-payment";

if (!process.env.DATABASE_URL) process.loadEnvFile(".env");

const prisma = createSystemClient();
const TZ = "America/Bogota";
const SETTINGS = { dueSoonLeadDays: 3, overdueGraceDays: 0 };

/** The lender's own numbers, as they were described. */
const PRINCIPAL = "1000000";
const RATE = "16";
const TERM = 6;
/** A lender quotes to the hundred: 326.700, never 326.666,67. */
const INSTALLMENT_QUANTUM = "100";

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
      { timeout: 60_000 },
    )
    .catch((error: unknown) => {
      if (error instanceof Rollback) return error.value as T;
      throw error;
    });
}

/**
 * A fresh client and a fixed-instalment loan, disbursed today, first instalment
 * due in 30 days.
 */
async function makeLoan(tx: any, organizationId: string, actor: any) {
  const today = todayIn(TZ);

  const client = await createClient(tx, {
    organizationId,
    fullName: "Cuota Fija De Prueba",
    documentNumber: `F${Date.now()}`.slice(0, 12),
    actor,
  });

  const loan = await createLoan(tx, {
    organizationId,
    clientId: client.clientId,
    principal: PRINCIPAL,
    ratePercent: RATE,
    periodicity: "MONTHLY",
    interestMethod: "SIMPLE_ON_ORIGINAL_PRINCIPAL",
    allocationStrategy: "INTEREST_FIRST",
    periodAnchor: "CALENDAR",
    roundingMode: "HALF_UP",
    moneyQuantum: "1",
    // The lender's answer to "what does an early payoff cost": the capital
    // still owed plus the period in progress. Nothing for the months after it.
    openPeriodPolicy: "FULL_PERIOD",
    renewalDueBasis: "PREVIOUS_DUE_DATE",
    repaymentPlan: "FIXED_INSTALLMENTS",
    termPeriods: TERM,
    installmentQuantum: INSTALLMENT_QUANTUM,
    disbursedOn: today,
    firstDueOn: addDays(today, 30),
    actor,
    idempotencyKey: `verify_fix_${crypto.randomUUID()}`,
  });

  return { client, loan, today };
}

/** Every period row of a loan, in schedule order. */
async function scheduleOf(tx: any, loanId: string) {
  return tx.loanPeriod.findMany({
    where: { loanId },
    orderBy: { periodIndex: "asc" },
    select: {
      id: true,
      periodIndex: true,
      dueOn: true,
      status: true,
      interestAccrued: true,
      interestPaid: true,
      interestWaived: true,
      principalDue: true,
    },
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
  const actor = { userId: admin.id, email: admin.email };

  // The demo portfolio deliberately holds fixed-instalment loans of its own —
  // that is what makes the ledger reconciliation run against a book containing
  // agreed-but-not-yet-due interest. So "nothing leaked" cannot mean "there are
  // none"; it means the count did not move.
  const fixedLoansBefore = await prisma.loan.count({
    where: { organizationId: org.id, repaymentPlan: "FIXED_INSTALLMENTS" },
  });

  // The figures every assertion below is measured against, straight from the
  // engine. If the engine and the database ever disagree, that is the bug.
  const plan = planFixedInstallments({
    principal: PRINCIPAL,
    ratePercent: RATE,
    periods: TERM,
    installmentQuantum: INSTALLMENT_QUANTUM,
    roundingMode: "HALF_UP",
  });

  console.log(
    `\n${PRINCIPAL} al ${RATE}% — ${TERM} cuotas de ` +
      `${plan.installment.toString()}\n`,
  );

  // --- 1. The agreed schedule reaches the database ------------------------

  console.log("1. El plan queda escrito tal como se acordó");

  const created = await inRolledBackTx(async (tx) => {
    const { loan, today } = await makeLoan(tx, org.id, actor);

    const row = await tx.loan.findUniqueOrThrow({
      where: { id: loan.loanId },
      select: {
        repaymentPlan: true,
        termPeriods: true,
        installmentAmount: true,
        agreedTotal: true,
        maturityOn: true,
        outstandingPrincipal: true,
        lastPeriodIndex: true,
        lifecycle: true,
      },
    });

    return { row, periods: await scheduleOf(tx, loan.loanId), today };
  });

  check(
    "quedó marcado como préstamo de cuota fija",
    created.row.repaymentPlan === "FIXED_INSTALLMENTS",
    created.row.repaymentPlan,
  );
  check(
    `se escribieron las ${TERM} cuotas`,
    created.periods.length === TERM,
    `${created.periods.length} períodos`,
  );
  check(
    "todas nacen agendadas, ninguna cobrada todavía",
    created.periods.every((p: any) => p.status === "SCHEDULED"),
    [...new Set(created.periods.map((p: any) => p.status))].join(", "),
  );
  check(
    "la cuota guardada es la que se le dijo al cliente",
    fromDb(created.row.installmentAmount).equals(plan.installment),
    fromDb(created.row.installmentAmount).toString(),
  );
  check(
    "el total acordado es la cuota por el plazo",
    fromDb(created.row.agreedTotal).equals(plan.totalRepaid),
    `${fromDb(created.row.agreedTotal).toString()} vs ${plan.totalRepaid.toString()}`,
  );

  // Capital is the one column that has to come back exactly. A rounding rule
  // that recovered 1.000.002 would be wrong on the first day and wrong forever.
  const scheduledCapital = created.periods.reduce(
    (sum: Money, p: any) => sum.plus(fromDb(p.principalDue)),
    Money.zero(),
  );
  check(
    "el capital agendado devuelve EXACTAMENTE lo prestado",
    scheduledCapital.equals(Money.of(PRINCIPAL)),
    `${scheduledCapital.toString()} vs ${PRINCIPAL}`,
  );

  const scheduledInterest = created.periods.reduce(
    (sum: Money, p: any) => sum.plus(fromDb(p.interestAccrued)),
    Money.zero(),
  );
  check(
    "y el interés agendado es el del plan",
    scheduledInterest.equals(plan.totalInterest),
    `${scheduledInterest.toString()} vs ${plan.totalInterest.toString()}`,
  );
  check(
    "capital + interés agendados son el total acordado",
    scheduledCapital.plus(scheduledInterest).equals(plan.totalRepaid),
    scheduledCapital.plus(scheduledInterest).toString(),
  );

  const lastDue = created.periods.at(-1)!.dueOn;
  check(
    "el préstamo tiene fecha de fin, y es la última cuota",
    created.row.maturityOn?.getTime() === lastDue.getTime(),
    created.row.maturityOn?.toISOString().slice(0, 10) ?? "ninguna",
  );

  // --- 2. Accrual charges one instalment at a time ------------------------

  console.log("\n2. Se cobra cuota por cuota, no el plazo entero");

  const accrued = await inRolledBackTx(async (tx) => {
    const { loan, today } = await makeLoan(tx, org.id, actor);

    // Nothing has fallen due yet on the day of disbursement.
    await accrueLoan(tx, loan.loanId, today);
    const onDayOne = await scheduleOf(tx, loan.loanId);

    // The day the first instalment falls due.
    const firstDue = await tx.loanPeriod.findFirstOrThrow({
      where: { loanId: loan.loanId, periodIndex: 1 },
      select: { dueOn: true },
    });
    const dueDay = todayIn(TZ);
    const dueDate = firstDue.dueOn.toISOString().slice(0, 10) as any;

    await accrueLoan(tx, loan.loanId, dueDate);
    const afterFirst = await scheduleOf(tx, loan.loanId);

    // Running it again the same day must change nothing.
    await accrueLoan(tx, loan.loanId, dueDate);
    const afterTwice = await scheduleOf(tx, loan.loanId);

    return { onDayOne, afterFirst, afterTwice, dueDate, loan, dueDay };
  });

  check(
    "el día del desembolso no se cobra nada",
    accrued.onDayOne.every((p: any) => p.status === "SCHEDULED"),
    [...new Set(accrued.onDayOne.map((p: any) => p.status))].join(", "),
  );

  const pendingAfterFirst = accrued.afterFirst.filter(
    (p: any) => p.status === "PENDING",
  );
  check(
    "al vencer la primera, se cobra solo esa",
    pendingAfterFirst.length === 1 && pendingAfterFirst[0].periodIndex === 1,
    `${pendingAfterFirst.length} cuota(s) exigible(s)`,
  );
  check(
    "las otras cinco siguen agendadas",
    accrued.afterFirst.filter((p: any) => p.status === "SCHEDULED").length ===
      TERM - 1,
  );
  check(
    "correrlo dos veces el mismo día no cobra de nuevo",
    accrued.afterTwice.filter((p: any) => p.status === "PENDING").length === 1,
  );

  // --- 3. A payment splits where the schedule says ------------------------

  console.log("\n3. La cuota se parte donde dice el plan");

  const paid = await inRolledBackTx(async (tx) => {
    const { loan } = await makeLoan(tx, org.id, actor);

    const first = await tx.loanPeriod.findFirstOrThrow({
      where: { loanId: loan.loanId, periodIndex: 1 },
      select: { dueOn: true, interestAccrued: true, principalDue: true },
    });
    const dueDate = first.dueOn.toISOString().slice(0, 10) as any;

    const payment = await postPayment(tx, {
      organizationId: org.id,
      loanId: loan.loanId,
      amount: plan.installment,
      paidOn: dueDate,
      actor,
      settings: SETTINGS,
      idempotencyKey: `verify_fix_pay_${crypto.randomUUID()}`,
    });

    const after = await tx.loan.findUniqueOrThrow({
      where: { id: loan.loanId },
      select: { outstandingPrincipal: true, lifecycle: true },
    });

    return {
      plan: payment.plan,
      expectedInterest: fromDb(first.interestAccrued),
      expectedCapital: fromDb(first.principalDue),
      after,
      periods: await scheduleOf(tx, loan.loanId),
    };
  });

  check(
    "el interés cobrado es el de la cuota",
    paid.plan.interestTotal.equals(paid.expectedInterest),
    `${paid.plan.interestTotal.toString()} vs ${paid.expectedInterest.toString()}`,
  );
  check(
    "el capital recuperado es el de la cuota",
    paid.plan.principalTotal.equals(paid.expectedCapital),
    `${paid.plan.principalTotal.toString()} vs ${paid.expectedCapital.toString()}`,
  );
  check(
    "y entre los dos son exactamente la cuota",
    paid.plan.interestTotal
      .plus(paid.plan.principalTotal)
      .equals(plan.installment),
    plan.installment.toString(),
  );
  check(
    "la primera cuota queda pagada",
    paid.periods.find((p: any) => p.periodIndex === 1)?.status === "PAID",
    paid.periods.find((p: any) => p.periodIndex === 1)?.status,
  );
  check(
    "el préstamo sigue vivo, faltan cinco",
    paid.after.lifecycle === "ACTIVE",
    paid.after.lifecycle,
  );

  // --- 3b. Paying before the due date settles no interest ----------------
  //
  // The confirmation screen tells the operator this in words, and the words are
  // only true while this is. If allocation ever starts reaching into interest
  // that has not come due, the notice turns into a lie on a screen somebody
  // reads before handing money over.

  console.log("\n3b. Pagar antes del vencimiento no toca intereses");

  const beforeDue = await inRolledBackTx(async (tx) => {
    const { loan, today } = await makeLoan(tx, org.id, actor);

    const first = await tx.loanPeriod.findFirstOrThrow({
      where: { loanId: loan.loanId, periodIndex: 1 },
      select: { dueOn: true, interestAccrued: true, status: true },
    });

    // The day after disbursement: the first instalment is a fortnight away.
    const payment = await postPayment(tx, {
      organizationId: org.id,
      loanId: loan.loanId,
      amount: plan.installment,
      paidOn: addDays(today, 1),
      actor,
      settings: SETTINGS,
      idempotencyKey: `verify_fix_early_${crypto.randomUUID()}`,
    });

    return {
      plan: payment.plan,
      firstStatus: first.status,
      firstInterest: fromDb(first.interestAccrued),
      after: await tx.loan.findUniqueOrThrow({
        where: { id: loan.loanId },
        select: { outstandingPrincipal: true, lifecycle: true },
      }),
    };
  });

  check(
    "la cuota todavía estaba agendada, no exigible",
    beforeDue.firstStatus === "SCHEDULED",
    beforeDue.firstStatus,
  );
  check(
    "no se cobró ni un peso de interés",
    beforeDue.plan.interestTotal.isZero(),
    beforeDue.plan.interestTotal.toString(),
  );
  check(
    "toda la plata bajó el capital",
    beforeDue.plan.principalTotal.equals(plan.installment),
    beforeDue.plan.principalTotal.toString(),
  );
  check(
    "y el interés de esa cuota sigue esperando su fecha",
    beforeDue.firstInterest.isPositive(),
    `${beforeDue.firstInterest.toString()} se causarán al vencer`,
  );
  check(
    "el préstamo no se cerró por adelantar",
    beforeDue.after.lifecycle === "ACTIVE",
    beforeDue.after.lifecycle,
  );

  // --- 4. Paying the capital early does not close the loan ---------------

  console.log("\n4. Adelantar capital no cierra el préstamo solo");

  const prepaid = await inRolledBackTx(async (tx) => {
    const { loan } = await makeLoan(tx, org.id, actor);

    const first = await tx.loanPeriod.findFirstOrThrow({
      where: { loanId: loan.loanId, periodIndex: 1 },
      select: { dueOn: true, interestAccrued: true },
    });
    const dueDate = first.dueOn.toISOString().slice(0, 10) as any;

    // The whole capital plus the interest that has actually fallen due.
    const everything = Money.of(PRINCIPAL).plus(fromDb(first.interestAccrued));

    await postPayment(tx, {
      organizationId: org.id,
      loanId: loan.loanId,
      amount: everything,
      paidOn: dueDate,
      actor,
      settings: SETTINGS,
      idempotencyKey: `verify_fix_pre_${crypto.randomUUID()}`,
    });

    const state = await refreshLoanState(tx, loan.loanId, dueDate, SETTINGS);

    return {
      state,
      row: await tx.loan.findUniqueOrThrow({
        where: { id: loan.loanId },
        select: { lifecycle: true, outstandingPrincipal: true },
      }),
      periods: await scheduleOf(tx, loan.loanId),
    };
  });

  check(
    "el capital quedó en cero",
    fromDb(prepaid.row.outstandingPrincipal).isZero(),
    fromDb(prepaid.row.outstandingPrincipal).toString(),
  );
  check(
    "pero el préstamo NO se cerró: faltan cuotas por cobrar",
    prepaid.row.lifecycle === "ACTIVE",
    prepaid.row.lifecycle,
  );
  check(
    "y esas cuotas siguen agendadas, no desaparecieron",
    prepaid.periods.filter((p: any) => p.status === "SCHEDULED").length ===
      TERM - 1,
    `${prepaid.periods.filter((p: any) => p.status === "SCHEDULED").length} agendadas`,
  );

  // --- 5. Cancelling early: capital owed + the period in progress --------

  console.log("\n5. Cancelar antes: capital que falta + la cuota en curso");

  const early = await inRolledBackTx(async (tx) => {
    const { loan } = await makeLoan(tx, org.id, actor);

    // Two instalments paid, then the client asks to close during the third.
    for (const index of [1, 2]) {
      const period = await tx.loanPeriod.findFirstOrThrow({
        where: { loanId: loan.loanId, periodIndex: index },
        select: { dueOn: true },
      });
      await postPayment(tx, {
        organizationId: org.id,
        loanId: loan.loanId,
        amount: plan.installment,
        paidOn: period.dueOn.toISOString().slice(0, 10) as any,
        actor,
        settings: SETTINGS,
        idempotencyKey: `verify_fix_c${index}_${crypto.randomUUID()}`,
      });
    }

    const secondDue = await tx.loanPeriod.findFirstOrThrow({
      where: { loanId: loan.loanId, periodIndex: 2 },
      select: { dueOn: true },
    });
    // A week after the second instalment: period three is running, not due.
    const asOf = addDays(secondDue.dueOn.toISOString().slice(0, 10) as any, 7);

    const before = await tx.loan.findUniqueOrThrow({
      where: { id: loan.loanId },
      select: { outstandingPrincipal: true },
    });
    const third = await tx.loanPeriod.findFirstOrThrow({
      where: { loanId: loan.loanId, periodIndex: 3 },
      select: { interestAccrued: true, status: true },
    });

    const quote = await quoteLoanSettlement(tx, {
      organizationId: org.id,
      loanId: loan.loanId,
      asOf,
    });

    const result = await settleLoan(tx, {
      organizationId: org.id,
      loanId: loan.loanId,
      asOf,
      kind: "FULL_PAYMENT",
      amountReceived: quote.quote.total,
      actor,
      settings: SETTINGS,
      idempotencyKey: `verify_fix_set_${crypto.randomUUID()}`,
    });

    return {
      quote,
      result,
      capitalOwed: fromDb(before.outstandingPrincipal),
      runningInterest: fromDb(third.interestAccrued),
      thirdStatusBefore: third.status,
      row: await tx.loan.findUniqueOrThrow({
        where: { id: loan.loanId },
        select: { lifecycle: true, outstandingPrincipal: true },
      }),
      periods: await scheduleOf(tx, loan.loanId),
    };
  });

  check(
    "la cuota en curso todavía no estaba cobrada",
    early.thirdStatusBefore === "SCHEDULED",
    early.thirdStatusBefore,
  );
  check(
    "cobra el capital que falta",
    early.quote.quote.principalOutstanding.equals(early.capitalOwed),
    early.quote.quote.principalOutstanding.toString(),
  );
  check(
    "más el interés de la cuota en curso, completo",
    early.quote.quote.openPeriodCharge.equals(early.runningInterest),
    `${early.quote.quote.openPeriodCharge.toString()} vs ${early.runningInterest.toString()}`,
  );
  check(
    "y nada de las cuotas que el cliente ya no va a usar",
    early.quote.quote.total.equals(
      early.capitalOwed.plus(early.runningInterest),
    ),
    early.quote.quote.total.toString(),
  );
  check(
    "cuesta menos que seguir pagando el plazo completo",
    early.quote.quote.total.lessThan(plan.installment.times(4)),
    `${early.quote.quote.total.toString()} vs ${plan.installment.times(4).toString()}`,
  );

  check(
    "el préstamo queda cerrado",
    early.row.lifecycle === "PAID",
    early.row.lifecycle,
  );
  check(
    "sin capital pendiente",
    fromDb(early.row.outstandingPrincipal).isZero(),
    fromDb(early.row.outstandingPrincipal).toString(),
  );
  check(
    "no quedó ninguna cuota agendada colgando",
    early.periods.every((p: any) => p.status !== "SCHEDULED"),
    [...new Set(early.periods.map((p: any) => p.status))].join(", "),
  );

  // What was forgiven has to be visible, not simply gone.
  const waived = early.periods.filter((p: any) => p.status === "WAIVED");
  const waivedTotal = waived.reduce(
    (sum: Money, p: any) => sum.plus(fromDb(p.interestWaived)),
    Money.zero(),
  );
  check(
    "las cuotas perdonadas quedan marcadas como condonadas",
    waived.length === 3,
    `${waived.length} cuotas (4, 5 y 6)`,
  );
  check(
    "y queda escrito cuánto interés se perdonó",
    waivedTotal.isPositive() && waivedTotal.equals(early.result.interestWaived),
    waivedTotal.toString(),
  );
  check(
    "nada se castigó como capital perdido: el cliente pagó todo el capital",
    early.result.principalWrittenOff.isZero(),
    early.result.principalWrittenOff.toString(),
  );

  // --- 6. Paying the term out collects exactly what was agreed -----------

  console.log("\n6. Pagando las seis, entra exactamente lo acordado");

  const full = await inRolledBackTx(async (tx) => {
    const { loan } = await makeLoan(tx, org.id, actor);
    let lastDay: any = null;

    for (let index = 1; index <= TERM; index += 1) {
      const period = await tx.loanPeriod.findFirstOrThrow({
        where: { loanId: loan.loanId, periodIndex: index },
        select: { dueOn: true },
      });
      lastDay = period.dueOn.toISOString().slice(0, 10) as any;

      await postPayment(tx, {
        organizationId: org.id,
        loanId: loan.loanId,
        amount: plan.installment,
        paidOn: lastDay,
        actor,
        settings: SETTINGS,
        idempotencyKey: `verify_fix_f${index}_${crypto.randomUUID()}`,
      });
    }

    const movements = await tx.cashMovement.findMany({
      where: { loanId: loan.loanId, direction: "IN" },
      select: { amount: true, financialClass: true },
    });

    return {
      row: await tx.loan.findUniqueOrThrow({
        where: { id: loan.loanId },
        select: { lifecycle: true, outstandingPrincipal: true },
      }),
      movements,
      periods: await scheduleOf(tx, loan.loanId),
    };
  });

  const collectedCapital = full.movements
    .filter((m: any) => m.financialClass === "PRINCIPAL")
    .reduce((sum: Money, m: any) => sum.plus(fromDb(m.amount)), Money.zero());
  const collectedInterest = full.movements
    .filter((m: any) => m.financialClass === "INTEREST")
    .reduce((sum: Money, m: any) => sum.plus(fromDb(m.amount)), Money.zero());

  check(
    "volvió exactamente el capital prestado, ni un peso más",
    collectedCapital.equals(Money.of(PRINCIPAL)),
    `${collectedCapital.toString()} vs ${PRINCIPAL}`,
  );
  check(
    "la ganancia es el interés del plan",
    collectedInterest.equals(plan.totalInterest),
    `${collectedInterest.toString()} vs ${plan.totalInterest.toString()}`,
  );
  check(
    "y el total recibido es el total acordado",
    collectedCapital.plus(collectedInterest).equals(plan.totalRepaid),
    collectedCapital.plus(collectedInterest).toString(),
  );
  check(
    "el capital recuperado NUNCA se contó como ganancia",
    !full.movements.some(
      (m: any) =>
        m.financialClass === "OPERATING_INCOME" ||
        m.financialClass === "OPERATING_EXPENSE",
    ),
  );
  check(
    "las seis cuotas quedaron pagadas",
    full.periods.filter((p: any) => p.status === "PAID").length === TERM,
    `${full.periods.filter((p: any) => p.status === "PAID").length} de ${TERM}`,
  );
  check(
    "y el préstamo quedó cerrado solo",
    full.row.lifecycle === "PAID",
    full.row.lifecycle,
  );

  // --- 7. The product refuses what it cannot honour ----------------------

  console.log("\n7. Se niega a prometer lo que no puede cumplir");

  const refusals = await inRolledBackTx(async (tx) => {
    const client = await createClient(tx, {
      organizationId: org.id,
      fullName: "Rechazos Cuota Fija",
      documentNumber: `R${Date.now()}`.slice(0, 12),
      actor,
    });
    const today = todayIn(TZ);

    const base = {
      organizationId: org.id,
      clientId: client.clientId,
      principal: PRINCIPAL,
      ratePercent: RATE,
      periodicity: "MONTHLY" as const,
      allocationStrategy: "INTEREST_FIRST" as const,
      periodAnchor: "CALENDAR" as const,
      roundingMode: "HALF_UP" as const,
      moneyQuantum: "1",
      openPeriodPolicy: "FULL_PERIOD" as const,
      renewalDueBasis: "PREVIOUS_DUE_DATE" as const,
      disbursedOn: today,
      firstDueOn: addDays(today, 30),
      actor,
    };

    const attempt = async (overrides: any) => {
      try {
        await createLoan(tx, {
          ...base,
          interestMethod: "SIMPLE_ON_ORIGINAL_PRINCIPAL",
          idempotencyKey: `verify_fix_no_${crypto.randomUUID()}`,
          ...overrides,
        });
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };

    return {
      noTerm: await attempt({ repaymentPlan: "FIXED_INSTALLMENTS" }),
      wrongMethod: await attempt({
        repaymentPlan: "FIXED_INSTALLMENTS",
        termPeriods: TERM,
        interestMethod: "SIMPLE_ON_OUTSTANDING_PRINCIPAL",
      }),
      // A rounding step bigger than the instalment would not be rounding, it
      // would be a different loan.
      absurdQuantum: await attempt({
        repaymentPlan: "FIXED_INSTALLMENTS",
        termPeriods: TERM,
        installmentQuantum: "1000000",
      }),
      termOnOpenEnded: await attempt({ termPeriods: TERM }),
    };
  });

  check("sin plazo no crea el préstamo", refusals.noTerm !== null, refusals.noTerm ?? "");
  check(
    "no acepta un método de interés que no sea el del producto",
    refusals.wrongMethod !== null,
    refusals.wrongMethod ?? "",
  );
  check(
    "no acepta un redondeo más grande que la cuota",
    refusals.absurdQuantum !== null,
    refusals.absurdQuantum ?? "",
  );
  check(
    "y no deja poner plazo en un préstamo sin plazo",
    refusals.termOnOpenEnded !== null,
    refusals.termOnOpenEnded ?? "",
  );

  // --- 8. Nothing leaked ---------------------------------------------------

  console.log("\n8. Nada quedó escrito");

  const leaked = await prisma.client.count({
    where: {
      organizationId: org.id,
      fullName: { in: ["Cuota Fija De Prueba", "Rechazos Cuota Fija"] },
    },
  });
  check("no quedó ningún cliente de prueba en la base", leaked === 0);

  const fixedLoansAfter = await prisma.loan.count({
    where: { organizationId: org.id, repaymentPlan: "FIXED_INSTALLMENTS" },
  });
  check(
    "ni ningún préstamo de cuota fija de más",
    fixedLoansAfter === fixedLoansBefore,
    `${fixedLoansBefore} antes, ${fixedLoansAfter} después`,
  );

  console.log(
    failures === 0
      ? "\nLa cuota fija cobra lo acordado, y cancelar antes cuesta lo que se dijo.\n"
      : `\n${failures} comprobación(es) fallaron.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
