import { Money } from "@/core/money/money";
import {
  addDays,
  endOfIsoWeek,
  endOfMonth,
  isoWeek,
  startOfIsoWeek,
  startOfMonth,
  toParts,
  toPrismaDate,
  type CalendarDate,
} from "@/core/time/calendar-date";
import { fromDb, toDb } from "@/infra/db/money";

import { ServiceError, type Tx } from "../shared";

/**
 * Business snapshots (points 70, 89).
 *
 * ## The reconstruction property
 *
 * Every figure here is derived from the ledger AS IT STOOD on a date, not read
 * from the current state of a loan. That is possible only because nothing in
 * this system ever mutates history: a disbursement, a recovery, a write-off and
 * a payment all leave permanent rows, so the business's position on any past
 * date can be rebuilt exactly.
 *
 * Principal outstanding on date D, for instance, is:
 *
 *     Σ(PRINCIPAL out)  −  Σ(PRINCIPAL in)  −  Σ(written off)   ... up to D
 *
 * which needs no loan row at all. The verification script asserts this identity
 * against today's live loan balances.
 *
 * ## Why snapshots are frozen
 *
 * Point 70 asks that history not be restated by future configuration. Once a
 * snapshot is CLOSED its numbers are permanent, and every growth chart reads
 * those rows rather than recomputing the past.
 */

export type SnapshotKind = "WEEKLY" | "MONTHLY";

export interface SnapshotFigures {
  periodStart: CalendarDate;
  periodEnd: CalendarDate;
  periodYear: number;
  periodIndex: number;

  openingEquity: Money;
  closingEquity: Money;
  ownerContributions: Money;
  ownerWithdrawals: Money;

  principalOutstanding: Money;
  cashAvailable: Money;
  principalDisbursed: Money;
  principalRecovered: Money;

  interestAccrued: Money;
  interestCollected: Money;
  otherIncome: Money;
  operatingExpenses: Money;
  netProfitCash: Money;
  netProfitAccrual: Money;

  portfolioOutstanding: Money;
  portfolioOverdue: Money;

  activeClients: number;
  activeLoans: number;
  newLoans: number;
  settledLoans: number;
  renewals: number;
  overdueLoans: number;
  avgOverdueDays: number;
}

/** Resolves the calendar window and label for a period. */
export function resolvePeriod(
  kind: SnapshotKind,
  anyDateInside: CalendarDate,
): {
  periodStart: CalendarDate;
  periodEnd: CalendarDate;
  periodYear: number;
  periodIndex: number;
} {
  if (kind === "MONTHLY") {
    const { year, month } = toParts(anyDateInside);
    return {
      periodStart: startOfMonth(anyDateInside),
      periodEnd: endOfMonth(anyDateInside),
      periodYear: year,
      periodIndex: month,
    };
  }

  const { year, week } = isoWeek(anyDateInside);
  return {
    periodStart: startOfIsoWeek(anyDateInside),
    periodEnd: endOfIsoWeek(anyDateInside),
    periodYear: year,
    periodIndex: week,
  };
}

// --- Point-in-time reconstruction -------------------------------------------

/**
 * Principal still owed across the whole book on a date.
 *
 * Derived purely from cash movements, so it is correct for any past date without
 * needing the loan rows to remember what they used to hold.
 */
async function principalOutstandingOn(
  tx: Tx,
  organizationId: string,
  date: CalendarDate,
): Promise<Money> {
  const rows = await tx.$queryRaw<{ disbursed: string; recovered: string; written: string }[]>`
    SELECT
      COALESCE(SUM(amount) FILTER (
        WHERE "financialClass" = 'PRINCIPAL' AND direction = 'OUT'), 0)::text AS disbursed,
      COALESCE(SUM(amount) FILTER (
        WHERE "financialClass" = 'PRINCIPAL' AND direction = 'IN'), 0)::text  AS recovered,
      COALESCE(SUM(amount) FILTER (
        WHERE type = 'PRINCIPAL_WRITE_OFF'), 0)::text                          AS written
    FROM cash_movements
    WHERE "organizationId" = ${organizationId}
      AND "reversedAt" IS NULL
      AND "occurredOn" <= ${toPrismaDate(date)}
  `;

  const row = rows[0];
  if (!row) return Money.zero();

  return fromDb(row.disbursed)
    .minus(fromDb(row.recovered))
    .minus(fromDb(row.written));
}

/** Cash held on a date: opening balances plus every cash-affecting movement. */
async function cashOn(
  tx: Tx,
  organizationId: string,
  date: CalendarDate,
): Promise<Money> {
  const [accounts, rows] = await Promise.all([
    tx.cashAccount.aggregate({
      where: { organizationId },
      _sum: { openingBalance: true },
    }),
    tx.$queryRaw<{ inflow: string; outflow: string }[]>`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE direction = 'IN'), 0)::text  AS inflow,
        COALESCE(SUM(amount) FILTER (WHERE direction = 'OUT'), 0)::text AS outflow
      FROM cash_movements
      WHERE "organizationId" = ${organizationId}
        AND "reversedAt" IS NULL
        AND "affectsCash" = true
        AND "occurredOn" <= ${toPrismaDate(date)}
    `,
  ]);

  const row = rows[0];
  const opening = fromDb(accounts._sum.openingBalance?.toFixed() ?? "0");
  if (!row) return opening;

  return opening.plus(fromDb(row.inflow)).minus(fromDb(row.outflow));
}

/** Operating result over a window, from the movement classes. */
async function resultOver(
  tx: Tx,
  organizationId: string,
  from: CalendarDate,
  to: CalendarDate,
): Promise<{
  interestCollected: Money;
  otherIncome: Money;
  operatingExpenses: Money;
  contributions: Money;
  withdrawals: Money;
  principalDisbursed: Money;
  principalRecovered: Money;
}> {
  const rows = await tx.$queryRaw<
    {
      interest: string;
      other: string;
      expenses: string;
      contributions: string;
      withdrawals: string;
      disbursed: string;
      recovered: string;
    }[]
  >`
    SELECT
      COALESCE(SUM(CASE WHEN "financialClass" = 'INTEREST'
        THEN CASE WHEN direction = 'IN' THEN amount ELSE -amount END END), 0)::text AS interest,
      COALESCE(SUM(CASE WHEN "financialClass" = 'OPERATING_INCOME'
        THEN CASE WHEN direction = 'IN' THEN amount ELSE -amount END END), 0)::text AS other,
      COALESCE(SUM(CASE WHEN "financialClass" = 'OPERATING_EXPENSE'
        THEN CASE WHEN direction = 'OUT' THEN amount ELSE -amount END END), 0)::text AS expenses,
      COALESCE(SUM(amount) FILTER (
        WHERE "financialClass" = 'EQUITY_CONTRIBUTION' AND direction = 'IN'), 0)::text AS contributions,
      COALESCE(SUM(amount) FILTER (
        WHERE "financialClass" = 'EQUITY_WITHDRAWAL' AND direction = 'OUT'), 0)::text AS withdrawals,
      COALESCE(SUM(amount) FILTER (
        WHERE "financialClass" = 'PRINCIPAL' AND direction = 'OUT'), 0)::text AS disbursed,
      COALESCE(SUM(amount) FILTER (
        WHERE "financialClass" = 'PRINCIPAL' AND direction = 'IN'), 0)::text  AS recovered
    FROM cash_movements
    WHERE "organizationId" = ${organizationId}
      AND "reversedAt" IS NULL
      AND "occurredOn" >= ${toPrismaDate(from)}
      AND "occurredOn" <= ${toPrismaDate(to)}
  `;

  const row = rows[0];
  const zero = Money.zero();
  if (!row) {
    return {
      interestCollected: zero,
      otherIncome: zero,
      operatingExpenses: zero,
      contributions: zero,
      withdrawals: zero,
      principalDisbursed: zero,
      principalRecovered: zero,
    };
  }

  return {
    interestCollected: fromDb(row.interest),
    otherIncome: fromDb(row.other),
    operatingExpenses: fromDb(row.expenses),
    contributions: fromDb(row.contributions),
    withdrawals: fromDb(row.withdrawals),
    principalDisbursed: fromDb(row.disbursed),
    principalRecovered: fromDb(row.recovered),
  };
}

/**
 * Equity on a date.
 *
 * Owner money in, minus owner money out, plus everything the business has earned
 * up to that point. Profit is cash-basis for interest, matching how the rest of
 * the system recognises it, and bad debt is already inside operatingExpenses —
 * which is exactly what keeps this identity true after a write-off.
 */
async function equityOn(
  tx: Tx,
  organizationId: string,
  date: CalendarDate,
): Promise<Money> {
  const result = await resultOver(
    tx,
    organizationId,
    // From the beginning of time.
    "1900-01-01" as CalendarDate,
    date,
  );

  return result.contributions
    .minus(result.withdrawals)
    .plus(result.interestCollected)
    .plus(result.otherIncome)
    .minus(result.operatingExpenses);
}

/** Interest that became an obligation inside a window (accrual basis). */
async function interestAccruedOver(
  tx: Tx,
  organizationId: string,
  from: CalendarDate,
  to: CalendarDate,
): Promise<Money> {
  const result = await tx.loanPeriod.aggregate({
    where: {
      organizationId,
      dueOn: { gte: toPrismaDate(from), lte: toPrismaDate(to) },
      accruedAt: { not: null },
    },
    _sum: { interestAccrued: true },
  });
  return fromDb(result._sum.interestAccrued?.toFixed() ?? "0");
}

/**
 * Interest still owed on a date, and how much of it was already late.
 *
 * Reconstructed from what had actually been paid BY that date, which is why the
 * allocation rows matter: each one carries the date its payment was posted.
 */
async function portfolioInterestOn(
  tx: Tx,
  organizationId: string,
  date: CalendarDate,
): Promise<{ outstanding: Money; overdue: Money; overdueLoans: number; avgDays: number }> {
  const rows = await tx.$queryRaw<
    { loanId: string; owed: string; dueOn: Date }[]
  >`
    SELECT
      p."loanId"                                   AS "loanId",
      (p."interestAccrued" - COALESCE((
        SELECT SUM(a.amount)
        FROM payment_allocations a
        JOIN payments pay ON pay.id = a."paymentId"
        WHERE a."loanPeriodId" = p.id
          AND a.kind = 'INTEREST'
          AND pay.status = 'POSTED'
          AND pay."paidOn" <= ${toPrismaDate(date)}
      ), 0) - p."interestWaived")::text            AS owed,
      p."dueOn"                                    AS "dueOn"
    FROM loan_periods p
    WHERE p."organizationId" = ${organizationId}
      AND p."accruedAt" IS NOT NULL
      AND p."dueOn" <= ${toPrismaDate(date)}
  `;

  let outstanding = Money.zero();
  let overdue = Money.zero();
  const overdueLoanIds = new Set<string>();
  let dayTotal = 0;

  const asOfMs = toPrismaDate(date).getTime();

  for (const row of rows) {
    const owed = fromDb(row.owed);
    if (!owed.isPositive()) continue;

    outstanding = outstanding.plus(owed);

    // A period due strictly before the snapshot date and still unpaid was late.
    const days = Math.floor((asOfMs - row.dueOn.getTime()) / 86_400_000);
    if (days > 0) {
      overdue = overdue.plus(owed);
      if (!overdueLoanIds.has(row.loanId)) {
        overdueLoanIds.add(row.loanId);
        dayTotal += days;
      }
    }
  }

  return {
    outstanding,
    overdue,
    overdueLoans: overdueLoanIds.size,
    avgDays:
      overdueLoanIds.size === 0
        ? 0
        : Math.round(dayTotal / overdueLoanIds.size),
  };
}

// --- Composition -------------------------------------------------------------

/** Computes every figure for a period. Writes nothing. */
export async function computeSnapshot(
  tx: Tx,
  organizationId: string,
  kind: SnapshotKind,
  anyDateInside: CalendarDate,
): Promise<SnapshotFigures> {
  const period = resolvePeriod(kind, anyDateInside);
  const dayBefore = addDays(period.periodStart, -1);

  const [
    openingEquity,
    closingEquity,
    principalOutstanding,
    cashAvailable,
    result,
    interestAccrued,
    portfolio,
    counters,
  ] = await Promise.all([
    equityOn(tx, organizationId, dayBefore),
    equityOn(tx, organizationId, period.periodEnd),
    principalOutstandingOn(tx, organizationId, period.periodEnd),
    cashOn(tx, organizationId, period.periodEnd),
    resultOver(tx, organizationId, period.periodStart, period.periodEnd),
    interestAccruedOver(tx, organizationId, period.periodStart, period.periodEnd),
    portfolioInterestOn(tx, organizationId, period.periodEnd),
    countersOn(tx, organizationId, period.periodStart, period.periodEnd),
  ]);

  const netProfitCash = result.interestCollected
    .plus(result.otherIncome)
    .minus(result.operatingExpenses);

  const netProfitAccrual = interestAccrued
    .plus(result.otherIncome)
    .minus(result.operatingExpenses);

  return {
    ...period,
    openingEquity,
    closingEquity,
    ownerContributions: result.contributions,
    ownerWithdrawals: result.withdrawals,
    principalOutstanding,
    cashAvailable,
    principalDisbursed: result.principalDisbursed,
    principalRecovered: result.principalRecovered,
    interestAccrued,
    interestCollected: result.interestCollected,
    otherIncome: result.otherIncome,
    operatingExpenses: result.operatingExpenses,
    netProfitCash,
    netProfitAccrual,
    portfolioOutstanding: principalOutstanding.plus(portfolio.outstanding),
    portfolioOverdue: portfolio.overdue,
    overdueLoans: portfolio.overdueLoans,
    avgOverdueDays: portfolio.avgDays,
    ...counters,
  };
}

async function countersOn(
  tx: Tx,
  organizationId: string,
  from: CalendarDate,
  to: CalendarDate,
): Promise<{
  activeClients: number;
  activeLoans: number;
  newLoans: number;
  settledLoans: number;
  renewals: number;
}> {
  const end = toPrismaDate(to);

  // A loan was live at the period end if it had been disbursed and had not yet
  // been closed. Reconstructed, not read from today's lifecycle column.
  const [activeLoanRows, newLoans, settledLoans, renewals] = await Promise.all([
    tx.loan.findMany({
      where: {
        organizationId,
        disbursedOn: { lte: end },
        OR: [{ closedOn: null }, { closedOn: { gt: end } }],
      },
      select: { clientId: true },
    }),
    tx.loan.count({
      where: {
        organizationId,
        disbursedOn: { gte: toPrismaDate(from), lte: end },
      },
    }),
    tx.settlement.count({
      where: {
        organizationId,
        settledOn: { gte: toPrismaDate(from), lte: end },
      },
    }),
    tx.renewal.count({
      where: {
        organizationId,
        effectiveOn: { gte: toPrismaDate(from), lte: end },
        reversedAt: null,
      },
    }),
  ]);

  return {
    activeLoans: activeLoanRows.length,
    activeClients: new Set(activeLoanRows.map((l) => l.clientId)).size,
    newLoans,
    settledLoans,
    renewals,
  };
}

// --- Persistence -------------------------------------------------------------

export interface CloseSnapshotInput {
  organizationId: string;
  kind: SnapshotKind;
  anyDateInside: CalendarDate;
  /** Today, in the organization time zone. */
  today: CalendarDate;
  closedById: string | null;
  /** Allow closing a period that has not ended yet. Off by default. */
  allowOpenPeriod?: boolean;
}

/**
 * Freezes a period permanently.
 *
 * Refuses to close a period that has not ended: a month closed on the 12th would
 * be a snapshot of a third of a month wearing the label of a whole one, and
 * every comparison built on it afterwards would be wrong.
 */
export async function closeSnapshot(
  tx: Tx,
  input: CloseSnapshotInput,
): Promise<{ snapshotId: string; figures: SnapshotFigures }> {
  const figures = await computeSnapshot(
    tx,
    input.organizationId,
    input.kind,
    input.anyDateInside,
  );

  if (figures.periodEnd >= input.today && !input.allowOpenPeriod) {
    throw new ServiceError(
      `El período todavía no termina (cierra el ${figures.periodEnd}). ` +
        "Cerrarlo antes produciría un snapshot parcial con etiqueta de período completo.",
    );
  }

  const existing = await tx.periodSnapshot.findUnique({
    where: {
      organizationId_kind_periodStart: {
        organizationId: input.organizationId,
        kind: input.kind,
        periodStart: toPrismaDate(figures.periodStart),
      },
    },
    select: { id: true, status: true },
  });

  if (existing?.status === "CLOSED") {
    throw new ServiceError(
      "Este período ya está cerrado. Los snapshots cerrados no se recalculan.",
    );
  }

  const data = {
    organizationId: input.organizationId,
    kind: input.kind,
    status: "CLOSED" as const,
    periodStart: toPrismaDate(figures.periodStart),
    periodEnd: toPrismaDate(figures.periodEnd),
    periodYear: figures.periodYear,
    periodIndex: figures.periodIndex,
    openingEquity: toDb(figures.openingEquity),
    closingEquity: toDb(figures.closingEquity),
    ownerContributions: toDb(figures.ownerContributions),
    ownerWithdrawals: toDb(figures.ownerWithdrawals),
    principalOutstanding: toDb(figures.principalOutstanding),
    cashAvailable: toDb(figures.cashAvailable),
    principalDisbursed: toDb(figures.principalDisbursed),
    principalRecovered: toDb(figures.principalRecovered),
    interestAccrued: toDb(figures.interestAccrued),
    interestCollected: toDb(figures.interestCollected),
    otherIncome: toDb(figures.otherIncome),
    operatingExpenses: toDb(figures.operatingExpenses),
    netProfitCash: toDb(figures.netProfitCash),
    netProfitAccrual: toDb(figures.netProfitAccrual),
    portfolioOutstanding: toDb(figures.portfolioOutstanding),
    portfolioOverdue: toDb(figures.portfolioOverdue),
    activeClients: figures.activeClients,
    activeLoans: figures.activeLoans,
    newLoans: figures.newLoans,
    settledLoans: figures.settledLoans,
    renewals: figures.renewals,
    overdueLoans: figures.overdueLoans,
    avgOverdueDays: figures.avgOverdueDays,
    closedById: input.closedById,
    closedAt: new Date(),
  };

  const snapshot = existing
    ? await tx.periodSnapshot.update({
        where: { id: existing.id },
        data,
        select: { id: true },
      })
    : await tx.periodSnapshot.create({ data, select: { id: true } });

  return { snapshotId: snapshot.id, figures };
}
