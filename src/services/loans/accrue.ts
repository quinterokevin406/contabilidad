import { dueDateFor, planAccrual, type AccrualLoan } from "@/core/loans/accrual";
import {
  computeDaysOverdue,
  deriveCompliance,
  deriveLifecycle,
} from "@/core/loans/state";
import { Money } from "@/core/money/money";
import {
  fromPrismaDate,
  toPrismaDate,
  type CalendarDate,
} from "@/core/time/calendar-date";
import { fromDb, rateFromDb, rateToDb, toDb } from "@/infra/db/money";

import type { Tx } from "../shared";
import { ServiceError } from "../shared";

/** Organization knobs that affect state derivation, not money. */
export interface ComplianceSettings {
  dueSoonLeadDays: number;
  overdueGraceDays: number;
}

/** Reads a loan row into the shape the accrual engine expects. */
async function loadAccrualLoan(
  tx: Tx,
  loanId: string,
): Promise<{
  loan: AccrualLoan;
  organizationId: string;
  lifecycle: string;
  repaymentPlan: string;
}> {
  const row = await tx.loan.findUnique({
    where: { id: loanId },
    select: {
      organizationId: true,
      scheduleAnchorOn: true,
      scheduleAnchorIndex: true,
      lastPeriodIndex: true,
      periodicity: true,
      periodAnchor: true,
      customPeriodDays: true,
      interestMethod: true,
      ratePercent: true,
      roundingMode: true,
      moneyQuantum: true,
      currentPrincipalBase: true,
      outstandingPrincipal: true,
      lifecycle: true,
      repaymentPlan: true,
    },
  });

  if (!row) throw new ServiceError(`Loan ${loanId} does not exist.`);

  return {
    organizationId: row.organizationId,
    lifecycle: row.lifecycle,
    repaymentPlan: row.repaymentPlan,
    loan: {
      anchorDueOn: fromPrismaDate(row.scheduleAnchorOn),
      anchorIndex: row.scheduleAnchorIndex,
      lastPeriodIndex: row.lastPeriodIndex,
      schedule: {
        periodicity: row.periodicity,
        anchor: row.periodAnchor,
        customPeriodDays: row.customPeriodDays,
      },
      interestMethod: row.interestMethod,
      ratePercent: rateFromDb(row.ratePercent),
      money: {
        roundingMode: row.roundingMode,
        moneyQuantum: fromDb(row.moneyQuantum),
      },
      principal: {
        currentPrincipalBase: fromDb(row.currentPrincipalBase),
        outstandingPrincipal: fromDb(row.outstandingPrincipal),
      },
    },
  };
}

export interface AccrualOutcome {
  periodsCreated: number;
  lastPeriodIndex: number;
  nextDueOn: CalendarDate;
}

/**
 * Materializes every period that has come due on or before `today`.
 *
 * MUST run before any payment, renewal or settlement is posted, inside the same
 * transaction. Catching up several periods at once uses the loan's current
 * principal state for each of them, which is only correct if no payment slipped
 * in between -- and calling this first is what guarantees that.
 *
 * Idempotent: running it twice on the same day creates nothing the second time.
 */
export async function accrueLoan(
  tx: Tx,
  loanId: string,
  today: CalendarDate,
): Promise<AccrualOutcome> {
  const { loan, organizationId, lifecycle, repaymentPlan } =
    await loadAccrualLoan(tx, loanId);

  // A closed loan stops accruing. Nothing here revives it.
  if (lifecycle !== "ACTIVE") {
    return {
      periodsCreated: 0,
      lastPeriodIndex: loan.lastPeriodIndex,
      nextDueOn: today,
    };
  }

  // A fixed-instalment loan has no periods left to invent: the whole schedule
  // was written when the loan was created, because its interest was fixed then
  // and nothing since can change a figure. What accrual still owes it is the
  // same thing it owes every other loan — turning a period that has reached its
  // due date into a real obligation.
  if (repaymentPlan === "FIXED_INSTALLMENTS") {
    return matureScheduledPeriods(tx, loanId, loan.lastPeriodIndex, today);
  }

  const plan = planAccrual(loan, today);

  for (const period of plan.newPeriods) {
    await tx.loanPeriod.create({
      data: {
        organizationId,
        loanId,
        periodIndex: period.periodIndex,
        startsOn: toPrismaDate(period.startsOn),
        dueOn: toPrismaDate(period.dueOn),
        principalBasis: toDb(period.principalBasis),
        rateApplied: rateToDb(period.rateApplied),
        interestAccrued: toDb(period.interestAccrued),
        interestPaid: toDb(Money.zero()),
        interestWaived: toDb(Money.zero()),
        status: period.interestAccrued.isZero() ? "PAID" : "PENDING",
        accruedAt: new Date(),
        settledAt: period.interestAccrued.isZero() ? new Date() : null,
      },
    });
  }

  if (plan.newPeriods.length > 0) {
    await tx.loan.update({
      where: { id: loanId },
      data: {
        lastPeriodIndex: plan.lastPeriodIndex,
        lastAccruedAt: new Date(),
      },
    });
  }

  return {
    periodsCreated: plan.newPeriods.length,
    lastPeriodIndex: plan.lastPeriodIndex,
    nextDueOn: plan.nextDueOn,
  };
}

/**
 * Turns the instalments that have reached their due date into real debt.
 *
 * SCHEDULED means agreed; PENDING means owed today. Flipping on the due date and
 * not before is what keeps the two honest, and it is what makes an early
 * settlement cost the right amount: periods still SCHEDULED have not been
 * charged, so the client is not asked to pay for months they never used.
 *
 * Idempotent. A second run on the same day finds nothing left SCHEDULED and due.
 */
async function matureScheduledPeriods(
  tx: Tx,
  loanId: string,
  lastPeriodIndex: number,
  today: CalendarDate,
): Promise<AccrualOutcome> {
  const due = await tx.loanPeriod.findMany({
    where: {
      loanId,
      status: "SCHEDULED",
      dueOn: { lte: toPrismaDate(today) },
    },
    orderBy: { periodIndex: "asc" },
    select: { id: true, interestAccrued: true },
  });

  for (const period of due) {
    // A zero-interest instalment is settled the moment it falls due; there is
    // nothing to collect on the interest side of it.
    const nothingOwed = fromDb(period.interestAccrued).isZero();
    await tx.loanPeriod.update({
      where: { id: period.id },
      data: {
        status: nothingOwed ? "PAID" : "PENDING",
        accruedAt: new Date(),
        settledAt: nothingOwed ? new Date() : null,
      },
    });
  }

  if (due.length > 0) {
    await tx.loan.update({
      where: { id: loanId },
      data: { lastAccruedAt: new Date() },
    });
  }

  return {
    periodsCreated: due.length,
    lastPeriodIndex,
    nextDueOn: (await earliestOpenDueDate(tx, loanId)) ?? today,
  };
}

/**
 * Due date of the earliest instalment that is not finished with.
 *
 * On a fixed-instalment loan this replaces "the next period that has not
 * accrued": there is no such period, the term is closed. What the operator and
 * the aging report want to know is which instalment is next, and that is the
 * oldest one still carrying something — whether it fell due last month or is
 * still scheduled for March.
 */
async function earliestOpenDueDate(
  tx: Tx,
  loanId: string,
): Promise<CalendarDate | null> {
  const next = await tx.loanPeriod.findFirst({
    where: { loanId, status: { in: ["SCHEDULED", "PENDING", "PARTIALLY_PAID"] } },
    orderBy: { periodIndex: "asc" },
    select: { dueOn: true },
  });
  return next ? fromPrismaDate(next.dueOn) : null;
}

export interface LoanStateSnapshot {
  outstandingPrincipal: Money;
  outstandingInterest: Money;
  lifecycle: "ACTIVE" | "PAID" | "CANCELLED" | "ARCHIVED";
  compliance: "CURRENT" | "DUE_SOON" | "OVERDUE";
  daysOverdue: number;
  nextDueOn: CalendarDate | null;
  oldestUnpaidDueOn: CalendarDate | null;
}

/**
 * Recomputes and persists a loan's derived state.
 *
 * Called after anything that can move a balance. The two state columns are kept
 * orthogonal on purpose: `lifecycle` answers "is this loan still live" and
 * `compliance` answers "is the client keeping up", and a loan can be ACTIVE and
 * OVERDUE at the same time.
 */
export async function refreshLoanState(
  tx: Tx,
  loanId: string,
  today: CalendarDate,
  settings: ComplianceSettings,
): Promise<LoanStateSnapshot> {
  const loan = await tx.loan.findUnique({
    where: { id: loanId },
    select: {
      outstandingPrincipal: true,
      lifecycle: true,
      scheduleAnchorOn: true,
      scheduleAnchorIndex: true,
      lastPeriodIndex: true,
      periodicity: true,
      periodAnchor: true,
      customPeriodDays: true,
      repaymentPlan: true,
    },
  });
  if (!loan) throw new ServiceError(`Loan ${loanId} does not exist.`);

  const fixedInstallments = loan.repaymentPlan === "FIXED_INSTALLMENTS";

  const periods = await tx.loanPeriod.findMany({
    where: { loanId, status: { in: ["PENDING", "PARTIALLY_PAID"] } },
    orderBy: { dueOn: "asc" },
    select: {
      dueOn: true,
      interestAccrued: true,
      interestPaid: true,
      interestWaived: true,
    },
  });

  let outstandingInterest = Money.zero();
  let oldestUnpaidDueOn: CalendarDate | null = null;

  for (const period of periods) {
    const owed = fromDb(period.interestAccrued)
      .minus(fromDb(period.interestPaid))
      .minus(fromDb(period.interestWaived));
    if (owed.isPositive()) {
      outstandingInterest = outstandingInterest.plus(owed);
      if (!oldestUnpaidDueOn) oldestUnpaidDueOn = fromPrismaDate(period.dueOn);
    }
  }

  const outstandingPrincipal = fromDb(loan.outstandingPrincipal);

  // Interest on instalments that are agreed but have not come due yet. Only a
  // fixed-instalment loan has any, and it is the difference between a loan that
  // is finished and one whose capital merely happens to be at zero.
  const scheduledInterestPending = fixedInstallments
    ? await pendingScheduledInterest(tx, loanId)
    : Money.zero();

  const lifecycle = deriveLifecycle(loan.lifecycle, {
    outstandingPrincipal,
    outstandingInterest,
    scheduledInterestPending,
  });

  // On an open-ended loan the next period is always lastPeriodIndex + 1, because
  // periods are invented as they fall due. A fixed-instalment loan has no such
  // period — asking for lastPeriodIndex + 1 there would quote a date past the
  // end of the term — so it reports the earliest instalment still open.
  const nextDueOn =
    lifecycle !== "ACTIVE"
      ? null
      : fixedInstallments
        ? await earliestOpenDueDate(tx, loanId)
        : nextDueDate(loan, loan.lastPeriodIndex + 1);

  const compliance =
    lifecycle === "ACTIVE"
      ? deriveCompliance({
          oldestUnpaidDueOn,
          nextDueOn,
          today,
          overdueGraceDays: settings.overdueGraceDays,
          dueSoonLeadDays: settings.dueSoonLeadDays,
        })
      : "CURRENT";

  const daysOverdue =
    compliance === "OVERDUE" ? computeDaysOverdue(oldestUnpaidDueOn, today) : 0;

  await tx.loan.update({
    where: { id: loanId },
    data: {
      lifecycle,
      compliance,
      daysOverdue,
      nextDueOn: nextDueOn ? toPrismaDate(nextDueOn) : null,
      closedOn:
        lifecycle === "PAID" ? toPrismaDate(today) : undefined,
    },
  });

  return {
    outstandingPrincipal,
    outstandingInterest,
    lifecycle,
    compliance,
    daysOverdue,
    nextDueOn,
    oldestUnpaidDueOn,
  };
}

/** Interest on instalments that have been agreed but have not come due yet. */
async function pendingScheduledInterest(
  tx: Tx,
  loanId: string,
): Promise<Money> {
  const periods = await tx.loanPeriod.findMany({
    where: { loanId, status: "SCHEDULED" },
    select: { interestAccrued: true, interestPaid: true, interestWaived: true },
  });

  return periods.reduce(
    (sum: Money, p) =>
      sum.plus(
        Money.max(
          Money.zero(),
          fromDb(p.interestAccrued)
            .minus(fromDb(p.interestPaid))
            .minus(fromDb(p.interestWaived)),
        ),
      ),
    Money.zero(),
  );
}

function nextDueDate(
  loan: {
    scheduleAnchorOn: Date;
    scheduleAnchorIndex: number;
    periodicity: AccrualLoan["schedule"]["periodicity"];
    periodAnchor: AccrualLoan["schedule"]["anchor"];
    customPeriodDays: number | null;
  },
  periodIndex: number,
): CalendarDate {
  // Reuses the engine's own schedule derivation so the date can never drift from
  // what accrual will actually use.
  return dueDateFor(
    {
      anchorDueOn: fromPrismaDate(loan.scheduleAnchorOn),
      anchorIndex: loan.scheduleAnchorIndex,
      schedule: {
        periodicity: loan.periodicity,
        anchor: loan.periodAnchor,
        customPeriodDays: loan.customPeriodDays,
      },
    },
    periodIndex,
  );
}
