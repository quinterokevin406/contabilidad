import Decimal from "decimal.js";

import { Money, type MoneyInput } from "@/core/money/money";
import { projectPeriod, type AccrualLoan } from "@/core/loans/accrual";
import { reviewRate } from "@/core/loans/interest";
import type { CalendarDate } from "@/core/time/calendar-date";
import { toPrismaDate } from "@/core/time/calendar-date";
import type {
  AllocationStrategy,
  InterestMethod,
  OpenPeriodPolicy,
  PeriodAnchor,
  Periodicity,
  RenewalDueBasis,
  RoundingMode,
} from "@/generated/prisma";
import { rateToDb, toDb } from "@/infra/db/money";

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

export interface CreateLoanInput {
  organizationId: string;
  clientId: string;
  principal: MoneyInput;
  /** Rate for ONE period, as a percentage. 20 means 20% per period. */
  ratePercent: Decimal | string;
  periodicity: Periodicity;
  customPeriodDays?: number | null;
  interestMethod: InterestMethod;
  allocationStrategy: AllocationStrategy;
  periodAnchor: PeriodAnchor;
  roundingMode: RoundingMode;
  moneyQuantum: MoneyInput;
  openPeriodPolicy: OpenPeriodPolicy;
  renewalDueBasis: RenewalDueBasis;
  disbursedOn: CalendarDate;
  firstDueOn: CalendarDate;
  maturityOn?: CalendarDate | null;
  notes?: string | null;
  actor: Actor;
  /** Guards against a duplicate disbursement from a double click or a retry. */
  idempotencyKey?: string | null;
  cashAccountId?: string | null;
}

export interface CreateLoanResult {
  loanId: string;
  code: string;
  /** True when an earlier attempt with the same key already created this loan. */
  deduplicated: boolean;
}

/**
 * Creates a loan and disburses it, atomically (point 9).
 *
 * Within one transaction this writes the loan, the cash movement that takes the
 * principal out of the till, and the audit entry. If any step fails the whole
 * thing rolls back, so a half-created loan with money already out of the drawer
 * cannot exist.
 *
 * Every rule the loan will ever run on is COPIED onto the row here. Nothing is
 * read back from organization settings at calculation time, which is what makes
 * "changing a default never restates an existing loan" true by construction
 * rather than by discipline.
 */
export async function createLoan(
  tx: Tx,
  input: CreateLoanInput,
): Promise<CreateLoanResult> {
  const existing = await findIdempotentResult(tx, input.organizationId, input.idempotencyKey);
  if (existing) {
    const loan = await tx.loan.findUnique({
      where: { id: existing },
      select: { id: true, code: true },
    });
    if (loan) return { loanId: loan.id, code: loan.code, deduplicated: true };
  }

  const principal = Money.of(input.principal);
  const rate = new Decimal(input.ratePercent.toString());

  if (!principal.isPositive()) {
    throw new ServiceError("The principal must be a positive amount.");
  }
  if (rate.isNegative()) {
    throw new ServiceError("The interest rate cannot be negative.");
  }
  if (input.periodicity === "CUSTOM" && !input.customPeriodDays) {
    throw new ServiceError(
      "A CUSTOM periodicity requires customPeriodDays.",
    );
  }
  if (input.firstDueOn < input.disbursedOn) {
    throw new ServiceError(
      "The first due date cannot precede the disbursement date.",
    );
  }

  const client = await tx.client.findFirst({
    where: {
      id: input.clientId,
      organizationId: input.organizationId,
      archivedAt: null,
    },
    select: { id: true, status: true, fullName: true },
  });

  if (!client) {
    throw new ServiceError("The client does not exist in this organization.");
  }
  if (client.status === "BLOCKED") {
    throw new ServiceError(
      `${client.fullName} is blocked and cannot receive a new loan.`,
    );
  }

  const { formatted: code } = await nextSequenceNumber(
    tx,
    input.organizationId,
    "LOAN",
    "PR",
  );

  const loan = await tx.loan.create({
    data: {
      organizationId: input.organizationId,
      clientId: input.clientId,
      code,
      originalPrincipal: toDb(principal),
      currentPrincipalBase: toDb(principal),
      outstandingPrincipal: toDb(principal),
      ratePercent: rateToDb(rate),
      periodicity: input.periodicity,
      customPeriodDays: input.customPeriodDays ?? null,
      interestMethod: input.interestMethod,
      allocationStrategy: input.allocationStrategy,
      periodAnchor: input.periodAnchor,
      roundingMode: input.roundingMode,
      moneyQuantum: toDb(input.moneyQuantum),
      openPeriodPolicy: input.openPeriodPolicy,
      renewalDueBasis: input.renewalDueBasis,
      disbursedOn: toPrismaDate(input.disbursedOn),
      firstDueOn: toPrismaDate(input.firstDueOn),
      nextDueOn: toPrismaDate(input.firstDueOn),
      // A new loan anchors its schedule at its first due date, index 0.
      scheduleAnchorOn: toPrismaDate(input.firstDueOn),
      scheduleAnchorIndex: 0,
      maturityOn: input.maturityOn ? toPrismaDate(input.maturityOn) : null,
      lastPeriodIndex: 0,
      lifecycle: "ACTIVE",
      compliance: "CURRENT",
      notes: input.notes ?? null,
      createdById: input.actor.userId,
    },
    select: { id: true, code: true },
  });

  const cashAccountId =
    input.cashAccountId ?? (await defaultCashAccountId(tx, input.organizationId));

  // The principal leaves the till. Classified as PRINCIPAL, never as an expense:
  // lending money is not a cost, it is capital changing form.
  await recordCashMovement(tx, {
    organizationId: input.organizationId,
    cashAccountId,
    type: "LOAN_DISBURSEMENT",
    direction: "OUT",
    amount: principal,
    financialClass: "PRINCIPAL",
    occurredOn: input.disbursedOn,
    loanId: loan.id,
    clientId: input.clientId,
    note: `Desembolso préstamo ${loan.code}`,
    createdById: input.actor.userId,
  });

  await recordAudit(tx, {
    organizationId: input.organizationId,
    action: "CREATE",
    entity: "Loan",
    entityId: loan.id,
    afterValues: {
      code: loan.code,
      principal: principal.toDatabaseString(),
      ratePercent: rate.toFixed(),
      periodicity: input.periodicity,
      interestMethod: input.interestMethod,
      allocationStrategy: input.allocationStrategy,
      disbursedOn: input.disbursedOn,
      firstDueOn: input.firstDueOn,
    },
    summary: `Préstamo ${loan.code} creado para ${client.fullName}`,
    actor: input.actor,
  });

  await recordIdempotencyKey(
    tx,
    input.organizationId,
    input.idempotencyKey,
    "loan.create",
    loan.id,
  );

  return { loanId: loan.id, code: loan.code, deduplicated: false };
}

export interface LoanPreview {
  principal: Money;
  ratePercent: Decimal;
  periodInterest: Money;
  firstDueOn: CalendarDate;
  totalAtFirstDueDate: Money;
  rateReview: ReturnType<typeof reviewRate>;
}

/**
 * Builds the confirmation summary shown before disbursing (point 9).
 *
 * Writes nothing. The figures come from the same engine the loan will use, so
 * what the operator confirms is exactly what the loan will charge.
 */
export function previewLoan(input: {
  principal: MoneyInput;
  ratePercent: Decimal | string;
  periodicity: Periodicity;
  customPeriodDays?: number | null;
  interestMethod: InterestMethod;
  periodAnchor: PeriodAnchor;
  roundingMode: RoundingMode;
  moneyQuantum: MoneyInput;
  firstDueOn: CalendarDate;
  rateReviewThresholdPercent?: Decimal | string | null;
  rateReviewNote?: string | null;
}): LoanPreview {
  const principal = Money.of(input.principal);

  const loan: AccrualLoan = {
    anchorDueOn: input.firstDueOn,
    anchorIndex: 0,
    lastPeriodIndex: 0,
    schedule: {
      periodicity: input.periodicity,
      anchor: input.periodAnchor,
      customPeriodDays: input.customPeriodDays ?? null,
    },
    interestMethod: input.interestMethod,
    ratePercent: input.ratePercent,
    money: {
      roundingMode: input.roundingMode,
      moneyQuantum: input.moneyQuantum,
    },
    principal: {
      currentPrincipalBase: principal,
      outstandingPrincipal: principal,
    },
  };

  const projection = projectPeriod(loan, 1);

  return {
    principal,
    ratePercent: new Decimal(input.ratePercent.toString()),
    periodInterest: projection.interest,
    firstDueOn: projection.dueOn,
    totalAtFirstDueDate: projection.totalAtDueDate,
    rateReview: reviewRate(
      input.ratePercent,
      input.rateReviewThresholdPercent ?? null,
      input.rateReviewNote ?? null,
    ),
  };
}
