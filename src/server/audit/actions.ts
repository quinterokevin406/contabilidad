"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { todayIn } from "@/core/time/calendar-date";
import { prisma, tenantTransaction } from "@/infra/db/client";
import { getOrganizationSettings, requireAdmin } from "@/server/auth/dal";
import { reversePayment } from "@/services/reversals/reverse-payment";

/**
 * Corrections (point 34).
 *
 * Restricted to administrators. A reversal moves real balances back, and the
 * decision that a posted payment was a mistake is not a collector's to make.
 */

export interface ReversalResult {
  ok: boolean;
  error: string | null;
  message: string | null;
}

const schema = z.object({
  paymentId: z.string().min(1, "Elegí el pago a anular."),
  reason: z.string().trim().min(5, "Escribí el motivo de la anulación."),
});

export async function reversePaymentAction(
  _previous: ReversalResult,
  formData: FormData,
): Promise<ReversalResult> {
  try {
    const user = await requireAdmin();
    const settings = await getOrganizationSettings();
    const today = todayIn(settings.timeZone);

    const parsed = schema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Datos inválidos.",
        message: null,
      };
    }

    const result = await tenantTransaction(
      (tx) =>
        reversePayment(tx, {
          organizationId: user.organizationId,
          paymentId: parsed.data.paymentId,
          reason: parsed.data.reason,
          reversedOn: today,
          actor: { userId: user.id, email: user.email },
          settings: {
            dueSoonLeadDays: settings.dueSoonLeadDays,
            overdueGraceDays: settings.overdueGraceDays,
          },
        }),
      { timeout: 60_000 },
    );

    revalidatePath("/historial");
    revalidatePath("/prestamos");
    revalidatePath("/caja");
    revalidatePath("/");

    return {
      ok: true,
      error: null,
      message:
        `Recibo ${result.receiptNumber} anulado. Se devolvieron ` +
        `${result.interestRestored.toDatabaseString()} a interés y ` +
        `${result.principalRestored.toDatabaseString()} a capital.`,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Ocurrió un error y no se anuló nada.",
      message: null,
    };
  }
}
