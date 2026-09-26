"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { addDays, calendarDate, startOfMonth, todayIn } from "@/core/time/calendar-date";
import { prisma, tenantTransaction } from "@/infra/db/client";
import { getOrganizationSettings, requireAdmin } from "@/server/auth/dal";
import { closePeriod } from "@/services/analytics/close-period";

/**
 * Closing a business period.
 *
 * Restricted to administrators: a snapshot is permanent, and freezing the wrong
 * month is not something a collector should be able to do by accident.
 */

export interface CloseResult {
  ok: boolean;
  error: string | null;
  message: string | null;
}

const schema = z.object({
  /** Any date inside the period to close. */
  month: z.string().min(1),
});

export async function closeMonthlyPeriod(
  _previous: CloseResult,
  formData: FormData,
): Promise<CloseResult> {
  try {
    const user = await requireAdmin();
    const settings = await getOrganizationSettings();
    const today = todayIn(settings.timeZone);

    const parsed = schema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) {
      return { ok: false, error: "Datos inválidos.", message: null };
    }

    const result = await tenantTransaction(
      (tx) =>
        closePeriod(tx, {
          organizationId: user.organizationId,
          kind: "MONTHLY",
          anyDateInside: calendarDate(parsed.data.month),
          today,
          actor: { userId: user.id, email: user.email },
        }),
      { timeout: 120_000 },
    );

    revalidatePath("/ejecutivo");
    revalidatePath("/historico");
    revalidatePath("/");

    return {
      ok: true,
      error: null,
      message:
        `Período cerrado. Utilidad ${result.figures.netProfitCash.toDatabaseString()}, ` +
        `patrimonio ${result.figures.closingEquity.toDatabaseString()}.`,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Ocurrió un error y no se cerró nada.",
      message: null,
    };
  }
}

/** The last fully ended month, which is the one normally closed next. */
export async function suggestedCloseMonth(): Promise<string> {
  const settings = await getOrganizationSettings();
  const today = todayIn(settings.timeZone);
  return startOfMonth(addDays(startOfMonth(today), -1));
}
