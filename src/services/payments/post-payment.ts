import { Money, type MoneyInput } from "@/core/money/money";
import {
  allocatePayment,
  type AllocationPlan,
  type DebtSnapshot,
  type ManualDistribution,
} from "@/core/payments/allocation";
import {
  fromPrismaDate,
  toPrismaDate,
  type CalendarDate,
} from "@/core/time/calendar-date";
import type { AllocationStrategy } from "@/generated/prisma";
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
import {
  accrueLoan,
  refreshLoanState,
  type ComplianceSettings,
} from "../loans/accrue";

export interface PostPaymentInput {
  organizationId: string;
  loanId: string;
  amount: MoneyInput;
  paidOn: CalendarDate;
  paymentMethodId?: string | null;
  /** Omit to use the loan's own strategy. */
  strategy?: AllocationStrategy;
  manual?: ManualDistribution;
  notes?: string | null;
  actor: Actor;
  idempotencyKey?: string | null;
  cashAccountId?: string | null;
  settings: ComplianceSettings;
  /**
   * Accept a payment larger than the whole debt. Off by default: the excess is
   * otherwise refused rather than silently absorbed.
   */
  allowOverpayment?: boolean;
}

export interface PostPaymentResult {
  paymentId: string;
  receiptNumber: string;
  plan: AllocationPlan;
  deduplicated: boolean;
}

/**
 * Posts a payment, atomically (points 10, 11, 12 and 42).
 *
 * One transaction performs all of it: accrue anything newly due, allocate the
 * money, write the payment and one allocation row per destination, update the
 * periods and the principal, move the cash, refresh the loan state and record the
 * audit entry. Any failure rolls the whole thing back — there is no state in
 * which the receipt exists but the balance did not move.
 *
 * Interest and principal produce SEPARATE cash movements with different financial
 * classes. That is what lets the reports state that a $300.000 payment earned
 * $200.000 and returned $100.000 of capital, instead of booking $300.000 of
 * income that never existed.
 */
export async function postPayment(
  tx: Tx,
  input: PostPaymentInput,
): Promise<PostPaymentResult> {
  const existing = await findIdempotentResult(
    tx,
    input.organizationId,
    input.idempotencyKey,
  );
  if (existing) {
    const payment = await tx.payment.findUnique({
      where: { id: existing },
      select: { id: true, receiptNumber: true },
    });
    if (payment) {
      throw new ServiceError(
        `This payment was already registered as receipt ${payment.receiptNumber}. ` +
          "Refresh the loan to see it.",
      );
    }
  }

  const amount = Money.of(input.amount);
  if (!amount.isPositive()) {
    throw new ServiceError("A payment must be a positive amount.");
  }

  // INVARIANT: accrue before reading the debt. Otherwise a period that came due
  // today would be invisible and the money would land on principal instead.
  await accrueLoan(tx, input.loanId, input.paidOn);

  const loan = await tx.loan.findFirst({
    where: { id: input.loanId, organizationId: input.organizationId },
    select: {
      id: true,
      code: true,
      clientId: true,
      lifecycle: true,
      outstandingPrincipal: true,
      allocationStrategy: true,
      client: { select: { fullName: true } },
    },
  });

  if (!loan) throw new ServiceError("The loan does not exist in this organization.");
  if (loan.lifecycle !== "ACTIVE") {
    throw new ServiceError(
      `Loan ${loan.code} is ${loan.lifecycle} and cannot receive payments.`,
    );
  }

  const periods = await tx.loanPeriod.findMany({
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

  const debt: DebtSnapshot = {
    periods: periods
      .map((p) => ({
        periodId: p.id,
        dueOn: fromPrismaDate(p.dueOn),
        interestOutstanding: fromDb(p.interestAccrued)
          .minus(fromDb(p.interestPaid))
          .minus(fromDb(p.interestWaived)),
      }))
      .filter((p) => Money.of(p.interestOutstanding).isPositive()),
    principalOutstanding: fromDb(loan.outstandingPrincipal),
  };

  const strategy = input.strategy ?? loan.allocationStrategy;
  const plan = allocatePayment({
    amount,
    debt,
    strategy,
    manual: input.manual,
  });

  if (plan.unapplied.isPositive() && !input.allowOverpayment) {
    throw new ServiceError(
      `The payment exceeds the debt by ${plan.unapplied.toString()}. Settle the ` +
        "loan instead, or confirm the overpayment explicitly.",
    );
  }

  const { formatted: receiptNumber } = await nextSequenceNumber(
    tx,
    input.organizationId,
    "PAYMENT",
    "REC",
  );

  const payment = await tx.payment.create({
    data: {
      organizationId: input.organizationId,
      loanId: loan.id,
      clientId: loan.clientId,
      receiptNumber,
      amount: toDb(amount),
      paidOn: toPrismaDate(input.paidOn),
      paymentMethodId: input.paymentMethodId ?? null,
      manualAllocation: strategy === "MANUAL_ONLY",
      strategyApplied: strategy,
      status: "POSTED",
      notes: input.notes ?? null,
      createdById: input.actor.userId,
    },
    select: { id: true },
  });

  // One allocation row per destination. Summing these reconstructs the balance
  // from scratch, which is what makes the ledger auditable.
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

  if (plan.principalTotal.isPositive()) {
    await tx.paymentAllocation.create({
      data: {
        organizationId: input.organizationId,
        paymentId: payment.id,
        kind: "PRINCIPAL",
        amount: toDb(plan.principalTotal),
      },
    });
  }

  for (const fee of plan.feeAllocations) {
    await tx.paymentAllocation.create({
      data: {
        organizationId: input.organizationId,
        paymentId: payment.id,
        kind: "FEE",
        amount: toDb(fee.amount),
        concept: fee.concept,
      },
    });
  }

  // Update each touched period. A partial payment leaves PARTIALLY_PAID, never
  // PAID (point 12).
  for (const outcome of plan.periodOutcomes) {
    if (!outcome.interestApplied.isPositive()) continue;

    await tx.loanPeriod.update({
      where: { id: outcome.periodId },
      data: {
        interestPaid: { increment: outcome.interestApplied.toDatabaseString() },
        status: outcome.fullySettled ? "PAID" : "PARTIALLY_PAID",
        settledAt: outcome.fullySettled ? new Date() : null,
      },
    });
  }

  if (plan.principalTotal.isPositive()) {
    await tx.loan.update({
      where: { id: loan.id },
      data: { outstandingPrincipal: toDb(plan.resultingPrincipal) },
    });
  }

  const cashAccountId =
    input.cashAccountId ?? (await defaultCashAccountId(tx, input.organizationId));

  // Separate movements per financial class. This is the whole reason recovered
  // capital can never be reported as profit.
  if (plan.interestTotal.isPositive()) {
    await recordCashMovement(tx, {
      organizationId: input.organizationId,
      cashAccountId,
      type: "INTEREST_COLLECTION",
      direction: "IN",
      amount: plan.interestTotal,
      financialClass: "INTEREST",
      occurredOn: input.paidOn,
      loanId: loan.id,
      clientId: loan.clientId,
      paymentId: payment.id,
      note: `Interés recibido ${receiptNumber}`,
      createdById: input.actor.userId,
    });
  }

  if (plan.principalTotal.isPositive()) {
    await recordCashMovement(tx, {
      organizationId: input.organizationId,
      cashAccountId,
      type: "PRINCIPAL_RECOVERY",
      direction: "IN",
      amount: plan.principalTotal,
      financialClass: "PRINCIPAL",
      occurredOn: input.paidOn,
      loanId: loan.id,
      clientId: loan.clientId,
      paymentId: payment.id,
      note: `Capital recuperado ${receiptNumber}`,
      createdById: input.actor.userId,
    });
  }

  if (plan.feeTotal.isPositive()) {
    await recordCashMovement(tx, {
      organizationId: input.organizationId,
      cashAccountId,
      type: "FEE_COLLECTION",
      direction: "IN",
      amount: plan.feeTotal,
      financialClass: "OPERATING_INCOME",
      occurredOn: input.paidOn,
      loanId: loan.id,
      clientId: loan.clientId,
      paymentId: payment.id,
      note: `Otros conceptos ${receiptNumber}`,
      createdById: input.actor.userId,
    });
  }

  await refreshLoanState(tx, loan.id, input.paidOn, input.settings);

  await recordAudit(tx, {
    organizationId: input.organizationId,
    action: "CREATE",
    entity: "Payment",
    entityId: payment.id,
    afterValues: {
      receiptNumber,
      amount: amount.toDatabaseString(),
      interest: plan.interestTotal.toDatabaseString(),
      principal: plan.principalTotal.toDatabaseString(),
      fees: plan.feeTotal.toDatabaseString(),
      resultingPrincipal: plan.resultingPrincipal.toDatabaseString(),
      strategy,
    },
    summary:
      `Pago ${receiptNumber} de ${loan.client.fullName} por ` +
      `${amount.toDatabaseString()} en préstamo ${loan.code}`,
    actor: input.actor,
  });

  await recordIdempotencyKey(
    tx,
    input.organizationId,
    input.idempotencyKey,
    "payment.create",
    payment.id,
  );

  return { paymentId: payment.id, receiptNumber, plan, deduplicated: false };
}
