import "server-only";

import { Money } from "@/core/money/money";
import {
  computeOperatingResult,
  projectCashPosition,
  type LedgerEntry,
} from "@/core/cash/ledger";
import { prisma } from "@/infra/db/client";
import { fromDb } from "@/infra/db/money";

/**
 * Headline figures.
 *
 * Every number is derived from recorded movements, never stored as a running
 * total that could drift out of agreement with the ledger. The cash position and
 * the operating result are computed by the same core functions the tests cover,
 * so a figure on the dashboard and a figure in a report cannot disagree.
 */

export interface DashboardSummary {
  cashOnHand: Money;
  principalOutstanding: Money;
  interestOutstanding: Money;
  portfolioOutstanding: Money;
  overduePortfolio: Money;
  interestCollected: Money;
  operatingExpenses: Money;
  badDebtExpense: Money;
  netProfit: Money;
  equity: Money;
  ownerContributions: Money;
  ownerWithdrawals: Money;
  activeClients: number;
  activeLoans: number;
  overdueLoans: number;
  dueTodayCount: number;
  dueTodayAmount: Money;
}

export async function getDashboardSummary(
  organizationId: string,
  today: Date,
): Promise<DashboardSummary> {
  const [movements, loanTotals, periodTotals, counts, dueToday] =
    await Promise.all([
      prisma.cashMovement.findMany({
        where: { organizationId, reversedAt: null },
        select: {
          direction: true,
          amount: true,
          financialClass: true,
          affectsCash: true,
          type: true,
        },
      }),

      prisma.loan.aggregate({
        where: { organizationId, lifecycle: "ACTIVE", archivedAt: null },
        _sum: { outstandingPrincipal: true },
      }),

      prisma.loanPeriod.findMany({
        where: {
          organizationId,
          status: { in: ["PENDING", "PARTIALLY_PAID"] },
          loan: { lifecycle: "ACTIVE", archivedAt: null },
        },
        select: {
          interestAccrued: true,
          interestPaid: true,
          interestWaived: true,
          loan: { select: { compliance: true } },
        },
      }),

      Promise.all([
        prisma.client.count({
          where: { organizationId, archivedAt: null, status: "ACTIVE" },
        }),
        prisma.loan.count({
          where: { organizationId, lifecycle: "ACTIVE", archivedAt: null },
        }),
        prisma.loan.count({
          where: {
            organizationId,
            lifecycle: "ACTIVE",
            compliance: "OVERDUE",
            archivedAt: null,
          },
        }),
      ]),

      prisma.loanPeriod.findMany({
        where: {
          organizationId,
          dueOn: today,
          status: { in: ["PENDING", "PARTIALLY_PAID"] },
        },
        select: {
          interestAccrued: true,
          interestPaid: true,
          interestWaived: true,
        },
      }),
    ]);

  const entries: LedgerEntry[] = movements.map((m) => ({
    direction: m.direction,
    amount: fromDb(m.amount),
    financialClass: m.financialClass,
    affectsCash: m.affectsCash,
    isWriteOff: m.type === "PRINCIPAL_WRITE_OFF",
  }));

  const result = computeOperatingResult(entries);

  // Through the core function, so the till correctly skips non-cash entries such
  // as a bad-debt write-off. Summing the rows here by hand is exactly how the
  // dashboard would drift away from the reports.
  const cashOnHand = projectCashPosition(Money.zero(), entries).expectedBalance;

  let interestOutstanding = Money.zero();
  let overdueInterest = Money.zero();

  for (const period of periodTotals) {
    const owed = fromDb(period.interestAccrued)
      .minus(fromDb(period.interestPaid))
      .minus(fromDb(period.interestWaived));
    if (!owed.isPositive()) continue;
    interestOutstanding = interestOutstanding.plus(owed);
    if (period.loan.compliance === "OVERDUE") {
      overdueInterest = overdueInterest.plus(owed);
    }
  }

  const overduePrincipal = await prisma.loan.aggregate({
    where: {
      organizationId,
      lifecycle: "ACTIVE",
      compliance: "OVERDUE",
      archivedAt: null,
    },
    _sum: { outstandingPrincipal: true },
  });

  const principalOutstanding = fromDb(
    loanTotals._sum.outstandingPrincipal?.toFixed() ?? "0",
  );

  const dueTodayAmount = dueToday.reduce(
    (acc, period) =>
      acc.plus(
        fromDb(period.interestAccrued)
          .minus(fromDb(period.interestPaid))
          .minus(fromDb(period.interestWaived)),
      ),
    Money.zero(),
  );

  const [activeClients, activeLoans, overdueLoans] = counts;

  return {
    cashOnHand,
    principalOutstanding,
    interestOutstanding,
    portfolioOutstanding: principalOutstanding.plus(interestOutstanding),
    overduePortfolio: fromDb(
      overduePrincipal._sum.outstandingPrincipal?.toFixed() ?? "0",
    ).plus(overdueInterest),
    interestCollected: result.interestIncome,
    operatingExpenses: result.operatingExpenses,
    badDebtExpense: result.badDebtExpense,
    netProfit: result.netProfit,
    // Equity: what the owner put in, plus what the business earned, minus draws.
    equity: result.equityContributions
      .plus(result.netProfit)
      .minus(result.equityWithdrawals),
    ownerContributions: result.equityContributions,
    ownerWithdrawals: result.equityWithdrawals,
    activeClients,
    activeLoans,
    overdueLoans,
    dueTodayCount: dueToday.length,
    dueTodayAmount,
  };
}
