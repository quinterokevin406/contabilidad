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
): Promise<{ loan: AccrualLoan; organizationId: string; lifecycle: string }> {
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
    },
  });

  if (!row) throw new ServiceError(`Loan ${loanId} does not exist.`);

  return {
    organizationId: row.organizationId,
    lifecycle: row.lifecycle,
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
  const { loan, organizationId, lifecycle } = await loadAccrualLoan(tx, loanId);

  // A closed loan stops accruing. Nothing here revives it.
  if (lifecycle !== "ACTIVE") {
    return {
      periodsCreated: 0,
      lastPeriodIndex: loan.lastPeriodIndex,
      nextDueOn: today,
    };
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
    },
  });
  if (!loan) throw new ServiceError(`Loan ${loanId} does not exist.`);

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

  const lifecycle = deriveLifecycle(loan.lifecycle, {
    outstandingPrincipal,
    outstandingInterest,
  });

  // The next period that has not accrued is always lastPeriodIndex + 1.
  const nextDueOn =
    lifecycle === "ACTIVE"
      ? nextDueDate(loan, loan.lastPeriodIndex + 1)
      : null;

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
