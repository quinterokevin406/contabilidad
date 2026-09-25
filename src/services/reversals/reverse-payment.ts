import { Money } from "@/core/money/money";
import { fromPrismaDate, toPrismaDate, type CalendarDate } from "@/core/time/calendar-date";
import type { Prisma } from "@/generated/prisma";
import { fromDb, toDb } from "@/infra/db/money";

import {
  recordAudit,
  recordCashMovement,
  ServiceError,
  type Actor,
  type Tx,
} from "../shared";
import { refreshLoanState, type ComplianceSettings } from "../loans/accrue";

/**
 * Payment reversal (points 33 and 34).
 *
 * Nothing is deleted. The original payment keeps every row it wrote and is
 * flagged REVERSED; the correction is a new set of COMPENSATING entries that
 * undo its effect. Both sides stay visible in the history forever, which is the
 * difference between an audit trail and a story someone edited afterwards.
 *
 * Concretely, reversing a payment:
 *   - restores the interest on each period it had settled, and reopens them
 *   - restores the principal it had reduced
 *   - posts cash movements in the OPPOSITE direction, so the till and the
 *     result both return to where they were
 *   - records a Reversal row carrying the reason and a frozen snapshot of the
 *     payment as it stood
 *
 * A reversed payment can never be reversed twice.
 */

export interface ReversePaymentInput {
  organizationId: string;
  paymentId: string;
  /** Mandatory. A correction without a stated reason is not a correction. */
  reason: string;
  /** Business date the reversal is posted on. */
  reversedOn: CalendarDate;
  actor: Actor;
  cashAccountId?: string | null;
  settings: ComplianceSettings;
}

export interface ReversePaymentResult {
  reversalId: string;
  receiptNumber: string;
  interestRestored: Money;
  principalRestored: Money;
  cashReturned: Money;
}

export async function reversePayment(
  tx: Tx,
  input: ReversePaymentInput,
): Promise<ReversePaymentResult> {
  if (input.reason.trim().length < 5) {
    throw new ServiceError("Una anulación necesita un motivo escrito.");
  }

  const payment = await tx.payment.findFirst({
    where: { id: input.paymentId, organizationId: input.organizationId },
    select: {
      id: true,
      receiptNumber: true,
      amount: true,
      paidOn: true,
      status: true,
      loanId: true,
      clientId: true,
      strategyApplied: true,
      notes: true,
      loan: {
        select: { code: true, outstandingPrincipal: true, lifecycle: true },
      },
      client: { select: { fullName: true } },
      allocations: {
        select: {
          id: true,
          kind: true,
          amount: true,
          loanPeriodId: true,
          concept: true,
        },
      },
      renewal: { select: { id: true } },
      cashMovements: {
        where: { reversedAt: null },
        select: {
          id: true,
          type: true,
          direction: true,
          amount: true,
          financialClass: true,
          cashAccountId: true,
        },
      },
    },
  });

  if (!payment) {
    throw new ServiceError("El pago no existe en esta organización.");
  }
  if (payment.status === "REVERSED") {
    throw new ServiceError(
      `El recibo ${payment.receiptNumber} ya fue anulado. Un pago no se anula dos veces.`,
    );
  }
  if (payment.renewal) {
    throw new ServiceError(
      "Este pago forma parte de una renovación. Anulá la renovación, no el pago suelto.",
    );
  }

  // --- Restore the periods --------------------------------------------------

  let interestRestored = Money.zero();
  let principalRestored = Money.zero();

  for (const allocation of payment.allocations) {
    const amount = fromDb(allocation.amount);

    if (allocation.kind === "INTEREST" && allocation.loanPeriodId) {
      const period = await tx.loanPeriod.findUniqueOrThrow({
        where: { id: allocation.loanPeriodId },
        select: {
          interestAccrued: true,
          interestPaid: true,
          interestWaived: true,
        },
      });

      const paidAfter = fromDb(period.interestPaid).minus(amount);
      if (paidAfter.isNegative()) {
        throw new ServiceError(
          "Anular este pago dejaría un período con interés pagado negativo. " +
            "No se anuló nada.",
        );
      }

      const owedAfter = fromDb(period.interestAccrued)
        .minus(paidAfter)
        .minus(fromDb(period.interestWaived));

      await tx.loanPeriod.update({
        where: { id: allocation.loanPeriodId },
        data: {
          interestPaid: toDb(paidAfter),
          // The period reopens exactly as far as the money is taken back.
          status: owedAfter.isZero()
            ? "PAID"
            : paidAfter.isZero()
              ? "PENDING"
              : "PARTIALLY_PAID",
          settledAt: owedAfter.isZero() ? new Date() : null,
        },
      });

      interestRestored = interestRestored.plus(amount);
    }

    if (allocation.kind === "PRINCIPAL") {
      principalRestored = principalRestored.plus(amount);
    }
  }

  if (principalRestored.isPositive()) {
    await tx.loan.update({
      where: { id: payment.loanId },
      data: {
        outstandingPrincipal: toDb(
          fromDb(payment.loan.outstandingPrincipal).plus(principalRestored),
        ),
        // A loan closed by this payment comes back to life.
        ...(payment.loan.lifecycle === "PAID"
          ? { lifecycle: "ACTIVE" as const, closedOn: null }
          : {}),
      },
    });
  }

  // --- The reversal record --------------------------------------------------

  const snapshot: Prisma.InputJsonValue = {
    receiptNumber: payment.receiptNumber,
    amount: fromDb(payment.amount).toDatabaseString(),
    paidOn: fromPrismaDate(payment.paidOn),
    loanCode: payment.loan.code,
    clientName: payment.client.fullName,
    strategyApplied: payment.strategyApplied,
    notes: payment.notes,
    allocations: payment.allocations.map((a) => ({
      kind: a.kind,
      amount: fromDb(a.amount).toDatabaseString(),
      loanPeriodId: a.loanPeriodId,
      concept: a.concept,
    })),
  };

  const reversal = await tx.reversal.create({
    data: {
      organizationId: input.organizationId,
      targetType: "PAYMENT",
      targetId: payment.id,
      reason: input.reason.trim(),
      originalSnapshot: snapshot,
      reversedById: input.actor.userId,
    },
    select: { id: true },
  });

  await tx.payment.update({
    where: { id: payment.id },
    data: {
      status: "REVERSED",
      reversedAt: new Date(),
      reversalId: reversal.id,
    },
  });

  // --- Compensating cash movements -----------------------------------------

  let cashReturned = Money.zero();

  for (const movement of payment.cashMovements) {
    const amount = fromDb(movement.amount);

    const compensating = await recordCashMovement(tx, {
      organizationId: input.organizationId,
      cashAccountId: input.cashAccountId ?? movement.cashAccountId,
      type: movement.type,
      // The mirror image: what came in goes back out.
      direction: movement.direction === "IN" ? "OUT" : "IN",
      amount,
      financialClass: movement.financialClass,
      occurredOn: input.reversedOn,
      loanId: payment.loanId,
      clientId: payment.clientId,
      paymentId: payment.id,
      note: `Anulación del recibo ${payment.receiptNumber}: ${input.reason.trim()}`,
      createdById: input.actor.userId,
    });

    // Link the two so a ledger view can show them as a pair rather than as two
    // unexplained movements on different days.
    await tx.cashMovement.update({
      where: { id: compensating.id },
      data: { reversesMovementId: movement.id },
    });
    await tx.cashMovement.update({
      where: { id: movement.id },
      data: { reversedAt: new Date() },
    });

    if (movement.direction === "IN") cashReturned = cashReturned.plus(amount);
  }

  const state = await refreshLoanState(
    tx,
    payment.loanId,
    input.reversedOn,
    input.settings,
  );

  await recordAudit(tx, {
    organizationId: input.organizationId,
    action: "REVERSE",
    entity: "Payment",
    entityId: payment.id,
    beforeValues: snapshot,
    afterValues: {
      status: "REVERSED",
      interestRestored: interestRestored.toDatabaseString(),
      principalRestored: principalRestored.toDatabaseString(),
      loanPrincipalAfter: state.outstandingPrincipal.toDatabaseString(),
    },
    reason: input.reason.trim(),
    summary:
      `Anulado el recibo ${payment.receiptNumber} de ${payment.client.fullName} ` +
      `por ${fromDb(payment.amount).toDatabaseString()}`,
    actor: input.actor,
  });

  return {
    reversalId: reversal.id,
    receiptNumber: payment.receiptNumber,
    interestRestored,
    principalRestored,
    cashReturned,
  };
}

/**
 * Reverses an expense or income entry.
 *
 * Same principle: the entry is flagged, a compensating cash movement is posted,
 * and both remain in the history.
 */
export async function reverseEntry(
  tx: Tx,
  input: {
    organizationId: string;
    kind: "EXPENSE" | "INCOME";
    entryId: string;
    reason: string;
    reversedOn: CalendarDate;
    actor: Actor;
  },
): Promise<{ reversalId: string; amount: Money }> {
  if (input.reason.trim().length < 5) {
    throw new ServiceError("Una anulación necesita un motivo escrito.");
  }

  const isExpense = input.kind === "EXPENSE";

  const entry = isExpense
    ? await tx.expenseEntry.findFirst({
        where: { id: input.entryId, organizationId: input.organizationId },
        select: {
          id: true,
          amount: true,
          concept: true,
          occurredOn: true,
          reversedAt: true,
          category: { select: { name: true } },
          cashMovements: {
            where: { reversedAt: null },
            select: { id: true, cashAccountId: true, amount: true },
          },
        },
      })
    : await tx.incomeEntry.findFirst({
        where: { id: input.entryId, organizationId: input.organizationId },
        select: {
          id: true,
          amount: true,
          concept: true,
          occurredOn: true,
          reversedAt: true,
          category: { select: { name: true } },
          cashMovements: {
            where: { reversedAt: null },
            select: { id: true, cashAccountId: true, amount: true },
          },
        },
      });

  if (!entry) throw new ServiceError("El movimiento no existe.");
  if (entry.reversedAt) {
    throw new ServiceError("Este movimiento ya fue anulado.");
  }

  const amount = fromDb(entry.amount);

  const reversal = await tx.reversal.create({
    data: {
      organizationId: input.organizationId,
      targetType: isExpense ? "EXPENSE_ENTRY" : "INCOME_ENTRY",
      targetId: entry.id,
      reason: input.reason.trim(),
      originalSnapshot: {
        amount: amount.toDatabaseString(),
        concept: entry.concept,
        category: entry.category.name,
        occurredOn: fromPrismaDate(entry.occurredOn),
      },
      reversedById: input.actor.userId,
    },
    select: { id: true },
  });

  for (const movement of entry.cashMovements) {
    const compensating = await recordCashMovement(tx, {
      organizationId: input.organizationId,
      cashAccountId: movement.cashAccountId,
      type: isExpense ? "EXPENSE" : "EXTRAORDINARY_INCOME",
      // An expense left the till, so undoing it brings the money back.
      direction: isExpense ? "IN" : "OUT",
      amount: fromDb(movement.amount),
      financialClass: isExpense ? "OPERATING_EXPENSE" : "OPERATING_INCOME",
      occurredOn: input.reversedOn,
      note: `Anulación de "${entry.concept}": ${input.reason.trim()}`,
      createdById: input.actor.userId,
    });

    await tx.cashMovement.update({
      where: { id: compensating.id },
      data: { reversesMovementId: movement.id },
    });
    await tx.cashMovement.update({
      where: { id: movement.id },
      data: { reversedAt: new Date() },
    });
  }

  if (isExpense) {
    await tx.expenseEntry.update({
      where: { id: entry.id },
      data: { reversedAt: new Date() },
    });
  } else {
    await tx.incomeEntry.update({
      where: { id: entry.id },
      data: { reversedAt: new Date() },
    });
  }

  await recordAudit(tx, {
    organizationId: input.organizationId,
    action: "REVERSE",
    entity: isExpense ? "ExpenseEntry" : "IncomeEntry",
    entityId: entry.id,
    reason: input.reason.trim(),
    summary: `Anulado ${isExpense ? "gasto" : "ingreso"} de ${amount.toDatabaseString()} (${entry.concept})`,
    actor: input.actor,
  });

  return { reversalId: reversal.id, amount };
}
