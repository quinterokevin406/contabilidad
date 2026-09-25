import "server-only";

import { Money } from "@/core/money/money";
import { fromPrismaDate, type CalendarDate } from "@/core/time/calendar-date";
import { prisma } from "@/infra/db/client";
import { fromDb } from "@/infra/db/money";

/**
 * Receipt data (point 32).
 *
 * The balances on a receipt are the balances AT THE MOMENT OF THE PAYMENT, not
 * today's. Reprinting a receipt from three months ago must show what the client
 * was handed then; showing current figures on an old receipt would be a document
 * that contradicts itself.
 *
 * They are reconstructed by walking the ledger backwards from now:
 *
 *   principal(T) = principal(now)
 *                + Σ(principal recovered after T)
 *                − Σ(principal disbursed after T)
 *                + Σ(written off after T)
 *
 * Same technique the snapshots use, and possible for the same reason: nothing
 * in this system mutates history.
 */

export interface ReceiptData {
  receiptNumber: string;
  paidOn: CalendarDate;
  postedAt: Date;
  status: "POSTED" | "REVERSED";
  reversedReason: string | null;

  organizationName: string;
  organizationLogo: string | null;

  clientName: string;
  clientDocument: string | null;
  clientPhone: string | null;

  loanCode: string;
  loanId: string;

  amount: Money;
  appliedToInterest: Money;
  appliedToPrincipal: Money;
  appliedToFees: Money;

  /** Balances immediately AFTER this payment was applied. */
  principalAfter: Money;
  interestAfter: Money;
  totalAfter: Money;

  methodName: string | null;
  notes: string | null;
  createdByName: string | null;
}

export async function getReceipt(
  organizationId: string,
  paymentId: string,
): Promise<ReceiptData | null> {
  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, organizationId },
    select: {
      receiptNumber: true,
      paidOn: true,
      postedAt: true,
      amount: true,
      status: true,
      notes: true,
      loanId: true,
      loan: { select: { code: true, outstandingPrincipal: true } },
      client: {
        select: { fullName: true, documentNumber: true, phone: true },
      },
      paymentMethod: { select: { name: true } },
      createdBy: { select: { name: true } },
      allocations: { select: { kind: true, amount: true } },
      reversal: { select: { reason: true } },
    },
  });

  if (!payment) return null;

  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: {
      name: true,
      settings: { select: { businessName: true, logoUrl: true } },
    },
  });

  let appliedToInterest = Money.zero();
  let appliedToPrincipal = Money.zero();
  let appliedToFees = Money.zero();

  for (const allocation of payment.allocations) {
    const amount = fromDb(allocation.amount);
    if (allocation.kind === "INTEREST") {
      appliedToInterest = appliedToInterest.plus(amount);
    } else if (allocation.kind === "PRINCIPAL") {
      appliedToPrincipal = appliedToPrincipal.plus(amount);
    } else {
      appliedToFees = appliedToFees.plus(amount);
    }
  }

  const principalAfter = await principalAtPayment(
    payment.loanId,
    payment.postedAt,
    fromDb(payment.loan.outstandingPrincipal),
  );

  const interestAfter = await interestOwedAtPayment(
    payment.loanId,
    payment.postedAt,
  );

  return {
    receiptNumber: payment.receiptNumber,
    paidOn: fromPrismaDate(payment.paidOn),
    postedAt: payment.postedAt,
    status: payment.status,
    reversedReason: payment.reversal?.reason ?? null,
    organizationName:
      organization?.settings?.businessName ?? organization?.name ?? "",
    organizationLogo: organization?.settings?.logoUrl ?? null,
    clientName: payment.client.fullName,
    clientDocument: payment.client.documentNumber,
    clientPhone: payment.client.phone,
    loanCode: payment.loan.code,
    loanId: payment.loanId,
    amount: fromDb(payment.amount),
    appliedToInterest,
    appliedToPrincipal,
    appliedToFees,
    principalAfter,
    interestAfter,
    totalAfter: principalAfter.plus(interestAfter),
    methodName: payment.paymentMethod?.name ?? null,
    notes: payment.notes,
    createdByName: payment.createdBy?.name ?? null,
  };
}

/** Rewinds the principal movements posted after a payment. */
async function principalAtPayment(
  loanId: string,
  postedAt: Date,
  principalNow: Money,
): Promise<Money> {
  const later = await prisma.cashMovement.findMany({
    where: {
      loanId,
      reversedAt: null,
      postedAt: { gt: postedAt },
      OR: [
        { financialClass: "PRINCIPAL" },
        { type: "PRINCIPAL_WRITE_OFF" },
      ],
    },
    select: { direction: true, amount: true, type: true },
  });

  let principal = principalNow;

  for (const movement of later) {
    const amount = fromDb(movement.amount);
    if (movement.type === "PRINCIPAL_WRITE_OFF") {
      // A later write-off removed principal; undo it going backwards.
      principal = principal.plus(amount);
    } else if (movement.direction === "IN") {
      // A later recovery reduced principal; add it back.
      principal = principal.plus(amount);
    } else {
      // A later disbursement increased principal; take it away.
      principal = principal.minus(amount);
    }
  }

  return principal;
}

/**
 * Interest still owed on the loan the instant after this payment posted.
 *
 * Counts only periods that had already accrued by then, and only the part of
 * each that had not been paid by then.
 */
async function interestOwedAtPayment(
  loanId: string,
  postedAt: Date,
): Promise<Money> {
  const periods = await prisma.loanPeriod.findMany({
    where: { loanId, accruedAt: { not: null, lte: postedAt } },
    select: {
      id: true,
      interestAccrued: true,
      interestWaived: true,
      allocations: {
        where: {
          kind: "INTEREST",
          payment: { status: "POSTED", postedAt: { lte: postedAt } },
        },
        select: { amount: true },
      },
    },
  });

  return periods.reduce((acc, period) => {
    const paid = Money.sum(period.allocations.map((a) => fromDb(a.amount)));
    const owed = fromDb(period.interestAccrued)
      .minus(paid)
      .minus(fromDb(period.interestWaived));
    return owed.isPositive() ? acc.plus(owed) : acc;
  }, Money.zero());
}
