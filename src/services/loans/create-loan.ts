import Decimal from "decimal.js";

import { Money, type MoneyInput } from "@/core/money/money";
import { projectPeriod, type AccrualLoan } from "@/core/loans/accrual";
import {
  planFixedInstallments,
  scheduleFixedInstallments,
  FixedInstallmentError,
  type FixedInstallmentPlan,
  type ScheduledInstallment,
} from "@/core/loans/fixed-installment";
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
  RepaymentPlan,
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
  /**
   * Shape of the obligation. Defaults to OPEN_ENDED, which is how every loan in
   * this system behaved before fixed instalments existed.
   */
  repaymentPlan?: RepaymentPlan;
  /** FIXED_INSTALLMENTS only: how many instalments the term is agreed in. */
  termPeriods?: number | null;
  /**
   * FIXED_INSTALLMENTS only: what the instalment is rounded to, so it is a
   * figure a person can say out loud. Defaults to `moneyQuantum`; a lender who
   * quotes to the hundred passes "100".
   */
  installmentQuantum?: MoneyInput | null;
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
  /**
   * The agreed schedule, for a FIXED_INSTALLMENTS loan. Null on an open-ended
   * one, which has no schedule to agree: it runs until the client pays it off.
   */
  plan: FixedInstallmentPlan | null;
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
    if (loan) {
      return { loanId: loan.id, code: loan.code, deduplicated: true, plan: null };
    }
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

  const repaymentPlan: RepaymentPlan = input.repaymentPlan ?? "OPEN_ENDED";
  const installmentQuantum = input.installmentQuantum ?? input.moneyQuantum;

  // The schedule of a fixed-instalment loan is agreed in full on day one, so it
  // is worked out here, before anything is written, and every figure the client
  // will ever be charged comes out of it.
  let plan: FixedInstallmentPlan | null = null;
  let schedule: ScheduledInstallment[] = [];

  if (repaymentPlan === "FIXED_INSTALLMENTS") {
    if (!input.termPeriods) {
      throw new ServiceError(
        "A fixed-instalment loan needs a term: how many instalments it is " +
          "repaid in.",
      );
    }
    // The engine's arithmetic IS interest on the original principal, every
    // period, for the whole term. Pairing it with a declining-balance method
    // would quote instalments the loan then does not charge.
    if (input.interestMethod !== "SIMPLE_ON_ORIGINAL_PRINCIPAL") {
      throw new ServiceError(
        "A fixed-instalment loan computes its interest on the original " +
          "principal for every period of the term. Use " +
          "SIMPLE_ON_ORIGINAL_PRINCIPAL, or choose an open-ended loan.",
      );
    }

    try {
      plan = planFixedInstallments({
        principal,
        ratePercent: rate.toFixed(),
        periods: input.termPeriods,
        installmentQuantum,
        roundingMode: input.roundingMode,
      });
    } catch (error) {
      if (error instanceof FixedInstallmentError) {
        throw new ServiceError(error.message);
      }
      throw error;
    }

    schedule = scheduleFixedInstallments(plan, {
      anchorDueOn: input.firstDueOn,
      anchorIndex: 0,
      schedule: {
        periodicity: input.periodicity,
        anchor: input.periodAnchor,
        customPeriodDays: input.customPeriodDays ?? null,
      },
    });
  } else if (input.termPeriods || input.installmentQuantum) {
    throw new ServiceError(
      "A term and an instalment rounding only mean something on a " +
        "fixed-instalment loan.",
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
      repaymentPlan,
      termPeriods: plan ? input.termPeriods : null,
      installmentAmount: plan ? toDb(plan.installment) : null,
      agreedTotal: plan ? toDb(plan.totalRepaid) : null,
      installmentQuantum: plan ? toDb(installmentQuantum) : null,
      disbursedOn: toPrismaDate(input.disbursedOn),
      firstDueOn: toPrismaDate(input.firstDueOn),
      nextDueOn: toPrismaDate(input.firstDueOn),
      // A new loan anchors its schedule at its first due date, index 0.
      scheduleAnchorOn: toPrismaDate(input.firstDueOn),
      scheduleAnchorIndex: 0,
      // A closed term HAS an end, and it is the last instalment's due date.
      // Nobody should have to work that out from the term length.
      maturityOn: lastDueOn(schedule, input.maturityOn),
      // Every period of a fixed-instalment loan exists from day one, so the
      // counter starts at the end of the term rather than at zero. See the
      // comment on the materialization below for why that is sound here and
      // nowhere else.
      lastPeriodIndex: schedule.length,
      lifecycle: "ACTIVE",
      compliance: "CURRENT",
      notes: input.notes ?? null,
      createdById: input.actor.userId,
    },
    select: { id: true, code: true },
  });

  // --- The agreed schedule, written in full ---------------------------------
  //
  // Everywhere else in this system a period becomes a row only once it has come
  // due, because a period row freezes `principalBasis` and under
  // SIMPLE_ON_OUTSTANDING_PRINCIPAL the right basis depends on how much capital
  // had been paid down by the time the period started. Freezing that early would
  // charge interest on money the client had already returned.
  //
  // A fixed-instalment loan is the one case where that objection does not hold:
  // its interest is computed on the ORIGINAL principal for every period and was
  // fixed the day the loan was written, so no later payment can change a single
  // figure. Writing the schedule now is therefore not a prediction, it is the
  // contract — and it is the whole point of the product, because the client is
  // handed those six dates and six amounts on paper.
  //
  // They land as SCHEDULED, not PENDING. Interest still becomes a real
  // obligation on the due date, which is what accrual flips them over for, and
  // what keeps a client who settles early from being charged for periods they
  // never used.
  for (const installment of schedule) {
    await tx.loanPeriod.create({
      data: {
        organizationId: input.organizationId,
        loanId: loan.id,
        periodIndex: installment.periodIndex,
        startsOn: toPrismaDate(installment.startsOn),
        dueOn: toPrismaDate(installment.dueOn),
        principalBasis: toDb(principal),
        rateApplied: rateToDb(rate),
        interestAccrued: toDb(installment.interest),
        interestPaid: toDb(Money.zero()),
        interestWaived: toDb(Money.zero()),
        principalDue: toDb(installment.principal),
        status: "SCHEDULED",
        accruedAt: null,
      },
    });
  }

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
      repaymentPlan,
      ...(plan
        ? {
            termPeriods: input.termPeriods,
            installment: plan.installment.toDatabaseString(),
            agreedTotal: plan.totalRepaid.toDatabaseString(),
            totalInterest: plan.totalInterest.toDatabaseString(),
          }
        : {}),
    },
    summary: plan
      ? `Préstamo ${loan.code} creado para ${client.fullName}: ` +
        `${input.termPeriods} cuotas de ${plan.installment.toDatabaseString()}`
      : `Préstamo ${loan.code} creado para ${client.fullName}`,
    actor: input.actor,
  });

  await recordIdempotencyKey(
    tx,
    input.organizationId,
    input.idempotencyKey,
    "loan.create",
    loan.id,
  );

  return { loanId: loan.id, code: loan.code, deduplicated: false, plan };
}

/**
 * Contractual end date of a fixed-instalment loan: its last instalment.
 *
 * An explicitly supplied date wins, because an operator may have agreed
 * something else in writing, but nobody has to compute the obvious one by hand.
 */
function lastDueOn(
  schedule: readonly ScheduledInstallment[],
  explicit: CalendarDate | null | undefined,
): Date | null {
  if (explicit) return toPrismaDate(explicit);
  const last = schedule.at(-1);
  return last ? toPrismaDate(last.dueOn) : null;
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
