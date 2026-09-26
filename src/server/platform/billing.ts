import "server-only";

import {
  assessAccess,
  type AccessState,
} from "@/core/billing/subscription";
import { Money } from "@/core/money/money";
import {
  fromPrismaDate,
  todayIn,
  type CalendarDate,
} from "@/core/time/calendar-date";
import { prisma } from "@/infra/db/client";
import { fromDb } from "@/infra/db/money";
import { withSystemAccess } from "@/infra/db/tenancy";

/**
 * What each business owes the platform.
 *
 * Deliberately a separate query from `listOrganizations`. The amounts here are
 * the operator's own revenue, and keeping them apart is what lets the check in
 * verify-platform keep asserting — honestly — that the organization listing
 * exposes no money at all.
 */

export interface BillingRow {
  organizationId: string;
  organizationName: string;
  price: Money | null;
  currencyCode: string;
  billingDay: number;
  graceDays: number;
  renewalBasis: string;
  paidThrough: CalendarDate | null;
  cutoffOn: CalendarDate | null;
  state: AccessState | "NO_SUBSCRIPTION";
  daysPastDue: number;
  collected: Money;
  paymentCount: number;
  lastPaidOn: CalendarDate | null;
}

export async function listBilling(timeZone: string): Promise<BillingRow[]> {
  const today = todayIn(timeZone);

  return withSystemAccess(async () => {
    const organizations = await prisma.organization.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        subscription: {
          select: {
            price: true,
            currencyCode: true,
            billingDay: true,
            graceDays: true,
            renewalBasis: true,
            paidThrough: true,
            startedAt: true,
          },
        },
        subscriptionPayments: {
          orderBy: { paidOn: "desc" },
          select: { amount: true, paidOn: true },
        },
      },
    });

    return organizations.map((organization): BillingRow => {
      const payments = organization.subscriptionPayments;
      const collected = payments.reduce(
        (sum, payment) => sum.plus(fromDb(payment.amount)),
        Money.zero(),
      );
      const lastPaidOn = payments[0]
        ? fromPrismaDate(payments[0].paidOn)
        : null;

      const subscription = organization.subscription;

      if (!subscription) {
        return {
          organizationId: organization.id,
          organizationName: organization.name,
          price: null,
          currencyCode: "USD",
          billingDay: 1,
          graceDays: 0,
          renewalBasis: "PREVIOUS_DUE_DATE",
          paidThrough: null,
          cutoffOn: null,
          state: "NO_SUBSCRIPTION",
          daysPastDue: 0,
          collected,
          paymentCount: payments.length,
          lastPaidOn,
        };
      }

      const assessment = assessAccess(
        {
          paidThrough: subscription.paidThrough
            ? fromPrismaDate(subscription.paidThrough)
            : null,
          billingDay: subscription.billingDay,
          graceDays: subscription.graceDays,
          renewalBasis: subscription.renewalBasis,
          startedAt: fromPrismaDate(subscription.startedAt),
        },
        today,
      );

      return {
        organizationId: organization.id,
        organizationName: organization.name,
        price: fromDb(subscription.price),
        currencyCode: subscription.currencyCode,
        billingDay: subscription.billingDay,
        graceDays: subscription.graceDays,
        renewalBasis: subscription.renewalBasis,
        paidThrough: subscription.paidThrough
          ? fromPrismaDate(subscription.paidThrough)
          : null,
        cutoffOn: assessment.cutoffOn,
        state: assessment.state,
        daysPastDue: assessment.daysPastDue,
        collected,
        paymentCount: payments.length,
        lastPaidOn,
      };
    });
  });
}

export interface PaymentRow {
  id: string;
  organizationName: string;
  amount: Money;
  currencyCode: string;
  paidOn: CalendarDate;
  method: string;
  reference: string | null;
  coversFrom: CalendarDate;
  coversThrough: CalendarDate;
}

export async function listSubscriptionPayments(
  limit = 30,
): Promise<PaymentRow[]> {
  return withSystemAccess(async () => {
    const rows = await prisma.subscriptionPayment.findMany({
      orderBy: { paidOn: "desc" },
      take: limit,
      select: {
        id: true,
        amount: true,
        currencyCode: true,
        paidOn: true,
        method: true,
        reference: true,
        coversFrom: true,
        coversThrough: true,
        organization: { select: { name: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      organizationName: row.organization.name,
      amount: fromDb(row.amount),
      currencyCode: row.currencyCode,
      paidOn: fromPrismaDate(row.paidOn),
      method: row.method,
      reference: row.reference,
      coversFrom: fromPrismaDate(row.coversFrom),
      coversThrough: fromPrismaDate(row.coversThrough),
    }));
  });
}
