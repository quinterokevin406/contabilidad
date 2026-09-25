import { planRenewal, type CapitalChange } from "@/core/loans/renewal";
import { Money } from "@/core/money/money";
import {
  fromPrismaDate,
  toPrismaDate,
  type CalendarDate,
} from "@/core/time/calendar-date";
import type { RenewalDueBasis } from "@/generated/prisma";
import { fromDb, toDb } from "@/infra/db/money";

import {
  defaultCashAccountId,
  findIdempotentResult,
  nextSequenceNumber,
  recordAudit,
  recordCashMovement,
  recordIdempotencyKey,
  ServiceError,
  type Actor,
  type Tx,
} from "../shared";
import { accrueLoan, refreshLoanState, type ComplianceSettings } from "./accrue";

export interface RenewLoanInput {
  organizationId: string;
  loanId: string;
  /** Interest actually received. */
  interestPaid: Money | string;
  capitalChange: CapitalChange;
  effectiveOn: CalendarDate;
  /** Omit to use the loan's own frozen basis. */
  dueBasis?: RenewalDueBasis;
  allowPartialInterest?: boolean;
  paymentMethodId?: string | null;
  notes?: string | null;
  actor: Actor;
  idempotencyKey?: string | null;
  cashAccountId?: string | null;
  settings: ComplianceSettings;
}

export interface RenewLoanResult {
  renewalId: string;
  paymentId: string | null;
  receiptNumber: string | null;
  sequence: number;
  newDueOn: CalendarDate;
  newPrincipalBase: Money;
}

/**
 * Renews a loan (points 13 and 14).
 *
 * The loan is never replaced or deleted. Its periods are closed, the capital
 * movement is recorded, the next period opens, and the Renewal row links it all
 * historically. The loan keeps its id, its code and its entire payment history.
 *
 * Both directions of cash are recorded separately: interest and returned capital
 * enter the till under different financial classes, and additional capital
 * leaves it as PRINCIPAL. A renewal that hands the client $500.000 while
 * collecting $200.000 of interest correctly shows the business $300.000 lighter
 * in cash and $200.000 richer in earnings.
 */
export async function renewLoan(
  tx: Tx,
  input: RenewLoanInput,
): Promise<RenewLoanResult> {
  const existing = await findIdempotentResult(
    tx,
    input.organizationId,
    input.idempotencyKey,
  );
  if (existing) {
    throw new ServiceError(
      "This renewal was already registered. Refresh the loan to see it.",
    );
  }

  const accrual = await accrueLoan(tx, input.loanId, input.effectiveOn);

  const loan = await tx.loan.findFirst({
    where: { id: input.loanId, organizationId: input.organizationId },
    select: {
      id: true,
      code: true,
      clientId: true,
      lifecycle: true,
      currentPrincipalBase: true,
      outstandingPrincipal: true,
      renewalCount: true,
      periodicity: true,
      periodAnchor: true,
      customPeriodDays: true,
      renewalDueBasis: true,
      firstDueOn: true,
      client: { select: { fullName: true } },
    },
  });

  if (!loan) throw new ServiceError("The loan does not exist in this organization.");
  if (loan.lifecycle !== "ACTIVE") {
    throw new ServiceError(`Loan ${loan.code} is ${loan.lifecycle} and cannot be renewed.`);
  }

  const openPeriods = await tx.loanPeriod.findMany({
    where: { loanId: loan.id, status: { in: ["PENDING", "PARTIALLY_PAID"] } },
    orderBy: { periodIndex: "asc" },
    select: {
      id: true,
      dueOn: true,
      interestAccrued: true,
      interestPaid: true,
      interestWaived: true,
    },
  });

  if (openPeriods.length === 0) {
    throw new ServiceError(
      `Loan ${loan.code} has no accrued period to close, so there is nothing to renew yet.`,
    );
  }

  const plan = planRenewal({
    loan: {
      currentPrincipalBase: fromDb(loan.currentPrincipalBase),
      outstandingPrincipal: fromDb(loan.outstandingPrincipal),
      renewalCount: loan.renewalCount,
      schedule: {
        periodicity: loan.periodicity,
        anchor: loan.periodAnchor,
        customPeriodDays: loan.customPeriodDays,
      },
    },
    closingPeriods: openPeriods.map((p) => ({
      periodId: p.id,
      dueOn: fromPrismaDate(p.dueOn),
      interestOutstanding: fromDb(p.interestAccrued)
        .minus(fromDb(p.interestPaid))
        .minus(fromDb(p.interestWaived)),
    })),
    interestPaid: input.interestPaid,
    capitalChange: input.capitalChange,
    effectiveOn: input.effectiveOn,
    dueBasis: input.dueBasis ?? loan.renewalDueBasis,
    allowPartialInterest: input.allowPartialInterest,
  });

  const cashAccountId =
    input.cashAccountId ?? (await defaultCashAccountId(tx, input.organizationId));

  // The money the client hands over is recorded as an ordinary payment, so it
  // appears in the payment history and produces a receipt like any other.
  let paymentId: string | null = null;
  let receiptNumber: string | null = null;

  if (plan.cashIn.isPositive()) {
    const receipt = await nextSequenceNumber(
      tx,
      input.organizationId,
      "PAYMENT",
      "REC",
    );
    receiptNumber = receipt.formatted;

    const payment = await tx.payment.create({
      data: {
        organizationId: input.organizationId,
        loanId: loan.id,
        clientId: loan.clientId,
        receiptNumber,
        amount: toDb(plan.cashIn),
        paidOn: toPrismaDate(input.effectiveOn),
        paymentMethodId: input.paymentMethodId ?? null,
        manualAllocation: true,
        strategyApplied: "MANUAL_ONLY",
        status: "POSTED",
        notes: input.notes ?? `Renovación ${plan.sequence}`,
        createdById: input.actor.userId,
      },
      select: { id: true },
    });
    paymentId = payment.id;

    for (const allocation of plan.interestAllocations) {
      await tx.paymentAllocation.create({
        data: {
          organizationId: input.organizationId,
          paymentId: payment.id,
          kind: "INTEREST",
          amount: toDb(allocation.amount),
          loanPeriodId: allocation.periodId,
        },
      });
    }

    if (plan.principalCollected.isPositive()) {
      await tx.paymentAllocation.create({
        data: {
          organizationId: input.organizationId,
          paymentId: payment.id,
          kind: "PRINCIPAL",
          amount: toDb(plan.principalCollected),
        },
      });
    }
  }

  const renewal = await tx.renewal.create({
    data: {
      organizationId: input.organizationId,
      loanId: loan.id,
      sequence: plan.sequence,
      effectiveOn: toPrismaDate(input.effectiveOn),
      previousPrincipalBase: toDb(plan.previousPrincipalBase),
      newPrincipalBase: toDb(plan.newPrincipalBase),
      additionalDisbursed: toDb(plan.additionalDisbursed),
      principalCollected: toDb(plan.principalCollected),
      interestCollected: toDb(plan.interestCollected),
      interestCarried: toDb(plan.interestCarried),
      newDueOn: toPrismaDate(plan.newDueOn),
      dueBasisApplied: input.dueBasis ?? loan.renewalDueBasis,
      paymentId,
      notes: input.notes ?? null,
      createdById: input.actor.userId,
    },
    select: { id: true },
  });

  // Apply the interest to each closed period and close them.
  for (const allocation of plan.interestAllocations) {
    await tx.loanPeriod.update({
      where: { id: allocation.periodId },
      data: { interestPaid: { increment: allocation.amount.toDatabaseString() } },
    });
  }

  for (const period of openPeriods) {
    const owed = fromDb(period.interestAccrued)
      .minus(fromDb(period.interestPaid))
      .minus(fromDb(period.interestWaived));
    const applied =
      plan.interestAllocations.find((a) => a.periodId === period.id)?.amount ??
      Money.zero();
    const remaining = owed.minus(applied);

    await tx.loanPeriod.update({
      where: { id: period.id },
      data: {
        status: remaining.isZero() ? "PAID" : "PARTIALLY_PAID",
        settledAt: remaining.isZero() ? new Date() : null,
        closedByRenewalId: renewal.id,
      },
    });
  }

  await tx.loan.update({
    where: { id: loan.id },
    data: {
      currentPrincipalBase: toDb(plan.newPrincipalBase),
      outstandingPrincipal: toDb(plan.newOutstandingPrincipal),
      renewalCount: { increment: 1 },
      // The schedule restarts at the renewed date, but the period counter does
      // NOT: indices must stay unique and monotonic for the life of the loan, or
      // a second renewal collides with the periods the first one already wrote.
      // Moving the anchor instead means the next period to accrue is
      // lastPeriodIndex + 1 and it falls due on plan.newDueOn.
      scheduleAnchorOn: toPrismaDate(plan.newDueOn),
      scheduleAnchorIndex: accrual.lastPeriodIndex,
      nextDueOn: toPrismaDate(plan.newDueOn),
    },
  });

  if (plan.interestCollected.isPositive()) {
    await recordCashMovement(tx, {
      organizationId: input.organizationId,
      cashAccountId,
      type: "INTEREST_COLLECTION",
      direction: "IN",
      amount: plan.interestCollected,
      financialClass: "INTEREST",
      occurredOn: input.effectiveOn,
      loanId: loan.id,
      clientId: loan.clientId,
      paymentId,
      renewalId: renewal.id,
      note: `Interés en renovación ${plan.sequence} de ${loan.code}`,
      createdById: input.actor.userId,
    });
  }

  if (plan.principalCollected.isPositive()) {
    await recordCashMovement(tx, {
      organizationId: input.organizationId,
      cashAccountId,
      type: "PRINCIPAL_RECOVERY",
      direction: "IN",
      amount: plan.principalCollected,
      financialClass: "PRINCIPAL",
      occurredOn: input.effectiveOn,
      loanId: loan.id,
      clientId: loan.clientId,
      paymentId,
      renewalId: renewal.id,
      note: `Capital recuperado en renovación ${plan.sequence} de ${loan.code}`,
      createdById: input.actor.userId,
    });
  }

  if (plan.additionalDisbursed.isPositive()) {
    await recordCashMovement(tx, {
      organizationId: input.organizationId,
      cashAccountId,
      type: "LOAN_DISBURSEMENT",
      direction: "OUT",
      amount: plan.additionalDisbursed,
      financialClass: "PRINCIPAL",
      occurredOn: input.effectiveOn,
      loanId: loan.id,
      clientId: loan.clientId,
      renewalId: renewal.id,
      note: `Capital adicional en renovación ${plan.sequence} de ${loan.code}`,
      createdById: input.actor.userId,
    });
  }

  await refreshLoanState(tx, loan.id, input.effectiveOn, input.settings);

  await recordAudit(tx, {
    organizationId: input.organizationId,
    action: "UPDATE",
    entity: "Loan",
    entityId: loan.id,
    beforeValues: {
      principalBase: plan.previousPrincipalBase.toDatabaseString(),
      outstandingPrincipal: plan.previousOutstandingPrincipal.toDatabaseString(),
    },
    afterValues: {
      principalBase: plan.newPrincipalBase.toDatabaseString(),
      outstandingPrincipal: plan.newOutstandingPrincipal.toDatabaseString(),
      interestCollected: plan.interestCollected.toDatabaseString(),
      additionalDisbursed: plan.additionalDisbursed.toDatabaseString(),
      principalCollected: plan.principalCollected.toDatabaseString(),
      newDueOn: plan.newDueOn,
      sequence: plan.sequence,
    },
    summary:
      `Renovación ${plan.sequence} de ${loan.code} (${loan.client.fullName}): ` +
      `capital ${plan.previousPrincipalBase.toDatabaseString()} -> ` +
      plan.newPrincipalBase.toDatabaseString(),
    actor: input.actor,
  });

  await recordIdempotencyKey(
    tx,
    input.organizationId,
    input.idempotencyKey,
    "loan.renew",
    renewal.id,
  );

  return {
    renewalId: renewal.id,
    paymentId,
    receiptNumber,
    sequence: plan.sequence,
    newDueOn: plan.newDueOn,
    newPrincipalBase: plan.newPrincipalBase,
  };
}
