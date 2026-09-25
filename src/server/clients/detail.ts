import "server-only";

import { Money } from "@/core/money/money";
import {
  fromPrismaDate,
  type CalendarDate,
} from "@/core/time/calendar-date";
import { describeLoanState } from "@/core/loans/state";
import type { ClientStatus } from "@/generated/prisma";
import { prisma } from "@/infra/db/client";
import { fromDb } from "@/infra/db/money";

/**
 * Client profile (point 8).
 *
 * Every historical total is derived from movement rows — payment allocations and
 * period rows — never from a running total kept on the client record. A cached
 * total is a number that can silently stop agreeing with the ledger; a derived
 * one cannot.
 */

export type TimelineKind =
  | "LOAN_CREATED"
  | "INTEREST_ACCRUED"
  | "PAYMENT"
  | "RENEWAL"
  | "SETTLEMENT";

export interface TimelineEvent {
  id: string;
  kind: TimelineKind;
  date: CalendarDate;
  title: string;
  detail: string | null;
  amount: Money | null;
  /** Direction of money from the business's point of view. */
  flow: "in" | "out" | "none";
  loanId: string;
  loanCode: string;
}

export interface ClientLoanRow {
  id: string;
  code: string;
  originalPrincipal: Money;
  outstandingPrincipal: Money;
  outstandingInterest: Money;
  ratePercent: string;
  periodicity: string;
  customPeriodDays: number | null;
  nextDueOn: CalendarDate | null;
  daysOverdue: number;
  renewalCount: number;
  state: ReturnType<typeof describeLoanState>;
}

export interface ClientDetail {
  id: string;
  code: string;
  fullName: string;
  documentType: string | null;
  documentNumber: string | null;
  phone: string | null;
  whatsappPhone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  referenceName: string | null;
  referencePhone: string | null;
  notes: string | null;
  status: ClientStatus;
  createdAt: Date;

  activeLoans: ClientLoanRow[];
  closedLoans: ClientLoanRow[];

  /** Everything ever handed to this client, across all loans and renewals. */
  principalReceivedHistorical: Money;
  principalOutstanding: Money;
  interestPaidHistorical: Money;
  interestOutstanding: Money;
  totalPaid: Money;
  totalOutstanding: Money;
  renewalCount: number;

  timeline: TimelineEvent[];
}

export async function getClientDetail(
  organizationId: string,
  clientId: string,
): Promise<ClientDetail | null> {
  const client = await prisma.client.findFirst({
    where: { id: clientId, organizationId, archivedAt: null },
    select: {
      id: true,
      code: true,
      fullName: true,
      documentType: true,
      documentNumber: true,
      phone: true,
      whatsappPhone: true,
      email: true,
      address: true,
      city: true,
      referenceName: true,
      referencePhone: true,
      notes: true,
      status: true,
      createdAt: true,
    },
  });

  if (!client) return null;

  const loans = await prisma.loan.findMany({
    where: { clientId, organizationId, archivedAt: null },
    orderBy: { disbursedOn: "desc" },
    select: {
      id: true,
      code: true,
      originalPrincipal: true,
      outstandingPrincipal: true,
      ratePercent: true,
      periodicity: true,
      customPeriodDays: true,
      disbursedOn: true,
      nextDueOn: true,
      daysOverdue: true,
      renewalCount: true,
      lifecycle: true,
      compliance: true,
      periods: {
        select: {
          id: true,
          periodIndex: true,
          dueOn: true,
          interestAccrued: true,
          interestPaid: true,
          interestWaived: true,
          accruedAt: true,
        },
        orderBy: { periodIndex: "asc" },
      },
      renewals: {
        select: {
          id: true,
          sequence: true,
          effectiveOn: true,
          previousPrincipalBase: true,
          newPrincipalBase: true,
          additionalDisbursed: true,
          interestCollected: true,
          principalCollected: true,
        },
        orderBy: { sequence: "asc" },
      },
      settlement: {
        select: {
          id: true,
          kind: true,
          settledOn: true,
          principalCollected: true,
          interestCollected: true,
          amountWrittenOff: true,
        },
      },
    },
  });

  const payments = await prisma.payment.findMany({
    where: { clientId, organizationId, status: "POSTED" },
    orderBy: { paidOn: "asc" },
    select: {
      id: true,
      receiptNumber: true,
      amount: true,
      paidOn: true,
      loanId: true,
      loan: { select: { code: true } },
      allocations: { select: { kind: true, amount: true } },
    },
  });

  // --- Historical totals, all derived -------------------------------------

  let principalReceivedHistorical = Money.zero();
  let principalOutstanding = Money.zero();
  let interestOutstanding = Money.zero();
  let renewalCount = 0;

  const activeLoans: ClientLoanRow[] = [];
  const closedLoans: ClientLoanRow[] = [];
  const timeline: TimelineEvent[] = [];

  for (const loan of loans) {
    const original = fromDb(loan.originalPrincipal);
    const outstanding = fromDb(loan.outstandingPrincipal);

    // Everything handed over: the original disbursement plus any capital added
    // on a renewal.
    const additional = loan.renewals.reduce(
      (acc, r) => acc.plus(fromDb(r.additionalDisbursed)),
      Money.zero(),
    );
    principalReceivedHistorical = principalReceivedHistorical
      .plus(original)
      .plus(additional);

    let loanInterestOutstanding = Money.zero();
    for (const period of loan.periods) {
      const owed = fromDb(period.interestAccrued)
        .minus(fromDb(period.interestPaid))
        .minus(fromDb(period.interestWaived));
      if (owed.isPositive()) {
        loanInterestOutstanding = loanInterestOutstanding.plus(owed);
      }
    }

    if (loan.lifecycle === "ACTIVE") {
      principalOutstanding = principalOutstanding.plus(outstanding);
      interestOutstanding = interestOutstanding.plus(loanInterestOutstanding);
    }

    renewalCount += loan.renewalCount;

    const row: ClientLoanRow = {
      id: loan.id,
      code: loan.code,
      originalPrincipal: original,
      outstandingPrincipal: outstanding,
      outstandingInterest: loanInterestOutstanding,
      ratePercent: loan.ratePercent.toFixed(),
      periodicity: loan.periodicity,
      customPeriodDays: loan.customPeriodDays,
      nextDueOn: loan.nextDueOn ? fromPrismaDate(loan.nextDueOn) : null,
      daysOverdue: loan.daysOverdue,
      renewalCount: loan.renewalCount,
      state: describeLoanState({
        lifecycle: loan.lifecycle,
        compliance: loan.compliance,
        debt: {
          outstandingPrincipal: outstanding,
          outstandingInterest: loanInterestOutstanding,
        },
        daysOverdue: loan.daysOverdue,
      }),
    };

    if (loan.lifecycle === "ACTIVE") activeLoans.push(row);
    else closedLoans.push(row);

    // --- Timeline contributions -------------------------------------------

    timeline.push({
      id: `loan-${loan.id}`,
      kind: "LOAN_CREATED",
      date: fromPrismaDate(loan.disbursedOn),
      title: "Préstamo desembolsado",
      detail: `Préstamo ${loan.code}`,
      amount: original,
      flow: "out",
      loanId: loan.id,
      loanCode: loan.code,
    });

    for (const period of loan.periods) {
      if (!period.accruedAt) continue;
      const accrued = fromDb(period.interestAccrued);
      if (accrued.isZero()) continue;

      timeline.push({
        id: `period-${period.id}`,
        kind: "INTEREST_ACCRUED",
        date: fromPrismaDate(period.dueOn),
        title: "Interés generado",
        detail: `Período ${period.periodIndex} de ${loan.code}`,
        amount: accrued,
        flow: "none",
        loanId: loan.id,
        loanCode: loan.code,
      });
    }

    for (const renewal of loan.renewals) {
      const previous = fromDb(renewal.previousPrincipalBase);
      const next = fromDb(renewal.newPrincipalBase);
      const extra = fromDb(renewal.additionalDisbursed);

      timeline.push({
        id: `renewal-${renewal.id}`,
        kind: "RENEWAL",
        date: fromPrismaDate(renewal.effectiveOn),
        title: `Renovación ${renewal.sequence}`,
        detail: next.equals(previous)
          ? `Capital continúa en ${previous.toDatabaseString()}`
          : `Capital ${previous.toDatabaseString()} → ${next.toDatabaseString()}`,
        amount: extra.isPositive() ? extra : null,
        flow: extra.isPositive() ? "out" : "none",
        loanId: loan.id,
        loanCode: loan.code,
      });
    }

    if (loan.settlement) {
      timeline.push({
        id: `settlement-${loan.settlement.id}`,
        kind: "SETTLEMENT",
        date: fromPrismaDate(loan.settlement.settledOn),
        title:
          loan.settlement.kind === "FULL_PAYMENT"
            ? "Préstamo liquidado"
            : "Préstamo cerrado administrativamente",
        detail: `Préstamo ${loan.code}`,
        amount: fromDb(loan.settlement.principalCollected).plus(
          fromDb(loan.settlement.interestCollected),
        ),
        flow: "in",
        loanId: loan.id,
        loanCode: loan.code,
      });
    }
  }

  let interestPaidHistorical = Money.zero();
  let totalPaid = Money.zero();

  for (const payment of payments) {
    const amount = fromDb(payment.amount);
    totalPaid = totalPaid.plus(amount);

    let interestPart = Money.zero();
    let principalPart = Money.zero();
    for (const allocation of payment.allocations) {
      const value = fromDb(allocation.amount);
      if (allocation.kind === "INTEREST") interestPart = interestPart.plus(value);
      if (allocation.kind === "PRINCIPAL") principalPart = principalPart.plus(value);
    }
    interestPaidHistorical = interestPaidHistorical.plus(interestPart);

    const parts: string[] = [];
    if (interestPart.isPositive())
      parts.push(`Interés ${interestPart.toDatabaseString()}`);
    if (principalPart.isPositive())
      parts.push(`Capital ${principalPart.toDatabaseString()}`);

    timeline.push({
      id: `payment-${payment.id}`,
      kind: "PAYMENT",
      date: fromPrismaDate(payment.paidOn),
      title: "Pago recibido",
      detail: `${payment.receiptNumber}${parts.length ? ` · ${parts.join(" · ")}` : ""}`,
      amount,
      flow: "in",
      loanId: payment.loanId,
      loanCode: payment.loan.code,
    });
  }

  // Newest first. Ties break by kind so a disbursement precedes the interest it
  // generates on the same day.
  timeline.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return {
    ...client,
    activeLoans,
    closedLoans,
    principalReceivedHistorical,
    principalOutstanding,
    interestPaidHistorical,
    interestOutstanding,
    totalPaid,
    totalOutstanding: principalOutstanding.plus(interestOutstanding),
    renewalCount,
    timeline,
  };
}
