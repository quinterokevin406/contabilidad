"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { Money } from "@/core/money/money";
import { calendarDate } from "@/core/time/calendar-date";
import { prisma, tenantTransaction } from "@/infra/db/client";
import { withSystemAccess } from "@/infra/db/tenancy";
import { getOrganizationSettings, requirePlatformOwner } from "@/server/auth/dal";
import { recordSubscriptionPayment } from "@/services/billing/record-payment";

/**
 * Setting up a subscription and recording what has been paid for it.
 *
 * No payment gateway is integrated, and that is deliberate: the money can
 * arrive by transfer, cash or a processor, and none of that changes what has to
 * be recorded. A gateway, when there is one worth choosing, becomes another
 * caller of the same service.
 */

export interface BillingResult {
  ok: boolean;
  error: string | null;
  message: string | null;
}

function fail(error: string): BillingResult {
  return { ok: false, error, message: null };
}

function humanError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Ocurrió un error y no se guardó nada.";
}

/** Accepts "20", "20.000" and "20,50" — the shapes people actually type. */
const amount = z
  .string()
  .trim()
  .transform((raw) => raw.replace(/\./g, "").replace(",", "."))
  .refine((v) => /^\d+(\.\d{1,2})?$/.test(v), "El valor no es válido.");

const subscriptionSchema = z.object({
  organizationId: z.string().min(1),
  price: amount,
  currencyCode: z.enum(["USD", "COP"]),
  billingDay: z.coerce.number().int().min(1).max(28),
  graceDays: z.coerce.number().int().min(0).max(60),
  renewalBasis: z.enum(["PREVIOUS_DUE_DATE", "EFFECTIVE_DATE"]),
  startedAt: z.string().min(10),
  notes: z.string().optional(),
});

export async function saveSubscription(
  _previous: BillingResult,
  formData: FormData,
): Promise<BillingResult> {
  try {
    await requirePlatformOwner();
    const parsed = subscriptionSchema.safeParse(Object.fromEntries(formData));

    if (!parsed.success) {
      return fail(parsed.error.issues[0]?.message ?? "Datos inválidos.");
    }

    const data = parsed.data;
    const startedAt = calendarDate(data.startedAt);

    await withSystemAccess(() =>
      tenantTransaction(async (tx) => {
        const existing = await tx.subscription.findUnique({
          where: { organizationId: data.organizationId },
          select: { id: true },
        });

        const shared = {
          price: data.price,
          currencyCode: data.currencyCode,
          billingDay: data.billingDay,
          graceDays: data.graceDays,
          renewalBasis: data.renewalBasis,
          notes: data.notes?.trim() || null,
        };

        if (existing) {
          // paidThrough is never touched here: changing the price must not
          // silently move what somebody already paid for.
          await tx.subscription.update({
            where: { id: existing.id },
            data: shared,
          });
        } else {
          await tx.subscription.create({
            data: {
              organizationId: data.organizationId,
              startedAt: new Date(`${startedAt}T00:00:00.000Z`),
              status: "TRIAL",
              ...shared,
            },
          });
        }
      }),
    );

    revalidatePath("/plataforma");
    return {
      ok: true,
      error: null,
      message: "Suscripción guardada. La cobertura ya pagada no se modificó.",
    };
  } catch (error: unknown) {
    return fail(humanError(error));
  }
}

const paymentSchema = z.object({
  organizationId: z.string().min(1),
  amount,
  paidOn: z.string().min(10),
  method: z.string().trim().min(2, "Indicá cómo llegó el pago."),
  reference: z.string().optional(),
  periods: z.coerce.number().int().min(1).max(36),
  notes: z.string().optional(),
});

export async function recordPayment(
  _previous: BillingResult,
  formData: FormData,
): Promise<BillingResult> {
  try {
    const owner = await requirePlatformOwner();
    const settings = await getOrganizationSettings();
    const parsed = paymentSchema.safeParse(Object.fromEntries(formData));

    if (!parsed.success) {
      return fail(parsed.error.issues[0]?.message ?? "Datos inválidos.");
    }

    const data = parsed.data;

    const result = await withSystemAccess(() =>
      tenantTransaction((tx) =>
        recordSubscriptionPayment(tx, {
          organizationId: data.organizationId,
          amount: Money.of(data.amount),
          paidOn: calendarDate(data.paidOn),
          method: data.method,
          reference: data.reference ?? null,
          periods: data.periods,
          notes: data.notes ?? null,
          actor: { userId: owner.id, email: owner.email },
          timeZone: settings.timeZone,
        }),
      ),
    );

    revalidatePath("/plataforma");

    return {
      ok: true,
      error: null,
      message:
        `Pago registrado. ${result.organizationName} queda cubierto hasta ` +
        `${result.coversThrough}.` +
        (result.reactivated ? " El acceso se reactivó." : ""),
    };
  } catch (error: unknown) {
    return fail(humanError(error));
  }
}

/** Organizations that can still have a subscription created for them. */
export async function organizationsWithoutSubscription(): Promise<
  { id: string; name: string }[]
> {
  await requirePlatformOwner();
  return withSystemAccess(() =>
    prisma.organization.findMany({
      where: { subscription: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  );
}
