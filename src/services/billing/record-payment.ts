import {
  assessAccess,
  computeCoverage,
  type SubscriptionTerms,
} from "@/core/billing/subscription";
import { Money } from "@/core/money/money";
import {
  fromPrismaDate,
  todayIn,
  toPrismaDate,
  type CalendarDate,
} from "@/core/time/calendar-date";
import { fromDb, toDb } from "@/infra/db/money";
import { setOrganizationStatus } from "@/services/platform/set-organization-status";
import type { Actor, Tx } from "@/services/shared";

/**
 * Records a subscription payment and extends the customer's access.
 *
 * A payment that arrives while the business is suspended reactivates it in the
 * same transaction. Anything else would mean a customer who paid still cannot
 * work until somebody remembers to flip a switch — and they would be right to
 * be furious about it.
 */

export class BillingError extends Error {}

export interface RecordSubscriptionPaymentInput {
  organizationId: string;
  amount: Money;
  paidOn: CalendarDate;
  /** How it arrived: transfer, cash, a gateway's name. */
  method: string;
  reference?: string | null;
  /** Billing periods bought. */
  periods: number;
  notes?: string | null;
  actor: Actor;
  /** Zone the business day is resolved in. */
  timeZone: string;
}

export interface RecordSubscriptionPaymentResult {
  paymentId: string;
  organizationName: string;
  coversFrom: CalendarDate;
  coversThrough: CalendarDate;
  reactivated: boolean;
}

export async function recordSubscriptionPayment(
  tx: Tx,
  input: RecordSubscriptionPaymentInput,
): Promise<RecordSubscriptionPaymentResult> {
  if (!input.amount.isPositive()) {
    throw new BillingError("El valor del pago tiene que ser mayor a cero.");
  }
  if (input.method.trim().length < 2) {
    throw new BillingError("Indicá cómo llegó el pago.");
  }

  const subscription = await tx.subscription.findUnique({
    where: { organizationId: input.organizationId },
    select: {
      id: true,
      organizationId: true,
      currencyCode: true,
      billingDay: true,
      graceDays: true,
      renewalBasis: true,
      paidThrough: true,
      startedAt: true,
      status: true,
      organization: { select: { name: true, status: true } },
    },
  });

  if (!subscription) {
    throw new BillingError(
      "Ese negocio no tiene una suscripción configurada todavía.",
    );
  }

  const terms: SubscriptionTerms = {
    paidThrough: subscription.paidThrough
      ? fromPrismaDate(subscription.paidThrough)
      : null,
    billingDay: subscription.billingDay,
    graceDays: subscription.graceDays,
    renewalBasis: subscription.renewalBasis,
    startedAt: fromPrismaDate(subscription.startedAt),
  };

  const coverage = computeCoverage({
    terms,
    paidOn: input.paidOn,
    periods: input.periods,
  });

  const payment = await tx.subscriptionPayment.create({
    data: {
      subscriptionId: subscription.id,
      organizationId: subscription.organizationId,
      amount: toDb(input.amount),
      currencyCode: subscription.currencyCode,
      paidOn: toPrismaDate(input.paidOn),
      method: input.method.trim(),
      reference: input.reference?.trim() || null,
      periodsCovered: input.periods,
      coversFrom: toPrismaDate(coverage.from),
      coversThrough: toPrismaDate(coverage.through),
      recordedById: input.actor.userId,
      notes: input.notes?.trim() || null,
    },
    select: { id: true },
  });

  // Where the subscription stands once this payment is counted.
  const today = todayIn(input.timeZone);
  const after = assessAccess(
    { ...terms, paidThrough: coverage.through },
    today,
  );

  await tx.subscription.update({
    where: { id: subscription.id },
    data: {
      paidThrough: toPrismaDate(coverage.through),
      status: after.state === "OVERDUE" ? "PAST_DUE" : "ACTIVE",
    },
  });

  // A customer who has paid gets back in immediately.
  let reactivated = false;
  if (
    subscription.organization.status === "SUSPENDED" &&
    !after.shouldSuspend
  ) {
    await setOrganizationStatus(tx, {
      organizationId: subscription.organizationId,
      status: "ACTIVE",
      reason: `Pago recibido el ${input.paidOn}, cubierto hasta ${coverage.through}`,
      actor: input.actor,
    });
    reactivated = true;
  }

  return {
    paymentId: payment.id,
    organizationName: subscription.organization.name,
    coversFrom: coverage.from,
    coversThrough: coverage.through,
    reactivated,
  };
}

/**
 * Suspends every business whose grace window has run out.
 *
 * Runs from a scheduled job, and is deliberately dumb: it only ever acts on
 * what `assessAccess` already decided. A trial is never touched, and neither is
 * a business that is merely late but still inside its grace days.
 */
export interface EnforcementResult {
  suspended: { organizationId: string; name: string; daysPastDue: number }[];
  checked: number;
}

export async function enforceSubscriptions(
  tx: Tx,
  options: { timeZone: string; actor: Actor; dryRun?: boolean },
): Promise<EnforcementResult> {
  const today = todayIn(options.timeZone);

  const subscriptions = await tx.subscription.findMany({
    where: {
      status: { in: ["ACTIVE", "PAST_DUE"] },
      paidThrough: { not: null },
      organization: { status: "ACTIVE" },
    },
    select: {
      id: true,
      organizationId: true,
      billingDay: true,
      graceDays: true,
      renewalBasis: true,
      paidThrough: true,
      startedAt: true,
      organization: { select: { name: true } },
    },
  });

  const suspended: EnforcementResult["suspended"] = [];

  for (const subscription of subscriptions) {
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

    if (!assessment.shouldSuspend) {
      // Late but inside grace still gets recorded, so the screen can show it.
      if (assessment.state === "IN_GRACE") {
        await tx.subscription.update({
          where: { id: subscription.id },
          data: { status: "PAST_DUE" },
        });
      }
      continue;
    }

    if (options.dryRun) {
      suspended.push({
        organizationId: subscription.organizationId,
        name: subscription.organization.name,
        daysPastDue: assessment.daysPastDue,
      });
      continue;
    }

    await setOrganizationStatus(tx, {
      organizationId: subscription.organizationId,
      status: "SUSPENDED",
      reason: `Mensualidad vencida hace ${assessment.daysPastDue} días (cobertura hasta ${subscription.paidThrough ? fromPrismaDate(subscription.paidThrough) : "—"})`,
      actor: options.actor,
    });

    await tx.subscription.update({
      where: { id: subscription.id },
      data: { status: "PAST_DUE" },
    });

    suspended.push({
      organizationId: subscription.organizationId,
      name: subscription.organization.name,
      daysPastDue: assessment.daysPastDue,
    });
  }

  return { suspended, checked: subscriptions.length };
}

/** Total received from one business, for the billing screen. */
export async function totalCollected(
  tx: Tx,
  organizationId: string,
): Promise<Money | null> {
  const rows = await tx.subscriptionPayment.findMany({
    where: { organizationId },
    select: { amount: true },
  });
  if (rows.length === 0) return null;
  return rows.reduce((sum, row) => sum.plus(fromDb(row.amount)), Money.zero());
}
