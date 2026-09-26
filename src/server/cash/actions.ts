"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { calendarDate, todayIn } from "@/core/time/calendar-date";
import { prisma, tenantTransaction } from "@/infra/db/client";
import { getOrganizationSettings, requireWriteAccess } from "@/server/auth/dal";
import {
  recordCapitalEvent,
  recordExpense,
  recordIncome,
  recordTillAdjustment,
} from "@/services/cash/entries";
import { performClosure, previewClosure } from "@/services/cash/closure";

/**
 * Cash, expense, income and closure actions.
 *
 * Every one runs inside a transaction and returns a plain result object rather
 * than throwing across the server boundary, so the form can show the operator a
 * sentence instead of a stack trace.
 */

const money = z
  .string()
  .trim()
  .min(1, "Ingresá un valor.")
  .transform((raw) => raw.replace(/\./g, "").replace(/\s/g, "").replace(",", "."))
  .refine((v) => /^\d+(\.\d{1,2})?$/.test(v), "El valor no es un número válido.")
  .refine((v) => Number(v) > 0, "El valor debe ser mayor a cero.");

export interface ActionResult {
  ok: boolean;
  error: string | null;
  message: string | null;
}

function fail(error: string): ActionResult {
  return { ok: false, error, message: null };
}

function humanError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Ocurrió un error inesperado y no se registró nada.";
}

function revalidateCash(): void {
  revalidatePath("/caja");
  revalidatePath("/movimientos");
  revalidatePath("/");
}

async function assertNotFuture(date: string): Promise<string | null> {
  const settings = await getOrganizationSettings();
  const parsed = calendarDate(date);
  if (parsed > todayIn(settings.timeZone)) {
    return "No se puede registrar un movimiento con fecha futura.";
  }
  return null;
}

// --- Expense ----------------------------------------------------------------

const entrySchema = z.object({
  categoryId: z.string().min(1, "Elegí una categoría."),
  amount: money,
  occurredOn: z.string().min(1),
  concept: z.string().trim().min(3, "Describí el concepto."),
  notes: z.string().optional(),
  idempotencyKey: z.string().min(8),
});

export async function createExpense(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireWriteAccess();
    const parsed = entrySchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) {
      return fail(parsed.error.issues[0]?.message ?? "Datos inválidos.");
    }

    const future = await assertNotFuture(parsed.data.occurredOn);
    if (future) return fail(future);

    await tenantTransaction((tx) =>
      recordExpense(tx, {
        organizationId: user.organizationId,
        categoryId: parsed.data.categoryId,
        amount: parsed.data.amount,
        occurredOn: calendarDate(parsed.data.occurredOn),
        concept: parsed.data.concept,
        notes: parsed.data.notes || null,
        actor: { userId: user.id, email: user.email },
        idempotencyKey: parsed.data.idempotencyKey,
      }),
    );

    revalidateCash();
    return { ok: true, error: null, message: "Gasto registrado." };
  } catch (error: unknown) {
    return fail(humanError(error));
  }
}

export async function createIncome(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireWriteAccess();
    const parsed = entrySchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) {
      return fail(parsed.error.issues[0]?.message ?? "Datos inválidos.");
    }

    const future = await assertNotFuture(parsed.data.occurredOn);
    if (future) return fail(future);

    await tenantTransaction((tx) =>
      recordIncome(tx, {
        organizationId: user.organizationId,
        categoryId: parsed.data.categoryId,
        amount: parsed.data.amount,
        occurredOn: calendarDate(parsed.data.occurredOn),
        concept: parsed.data.concept,
        notes: parsed.data.notes || null,
        actor: { userId: user.id, email: user.email },
        idempotencyKey: parsed.data.idempotencyKey,
      }),
    );

    revalidateCash();
    return { ok: true, error: null, message: "Ingreso registrado." };
  } catch (error: unknown) {
    return fail(humanError(error));
  }
}

// --- Owner capital ----------------------------------------------------------

const capitalSchema = z.object({
  kind: z.enum(["CONTRIBUTION", "WITHDRAWAL"]),
  amount: money,
  occurredOn: z.string().min(1),
  concept: z.string().optional(),
  idempotencyKey: z.string().min(8),
});

export async function createCapitalEvent(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireWriteAccess();
    const parsed = capitalSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) {
      return fail(parsed.error.issues[0]?.message ?? "Datos inválidos.");
    }

    const future = await assertNotFuture(parsed.data.occurredOn);
    if (future) return fail(future);

    await tenantTransaction((tx) =>
      recordCapitalEvent(tx, {
        organizationId: user.organizationId,
        kind: parsed.data.kind,
        amount: parsed.data.amount,
        occurredOn: calendarDate(parsed.data.occurredOn),
        concept: parsed.data.concept || null,
        actor: { userId: user.id, email: user.email },
        idempotencyKey: parsed.data.idempotencyKey,
      }),
    );

    revalidateCash();
    return {
      ok: true,
      error: null,
      message:
        parsed.data.kind === "CONTRIBUTION"
          ? "Aporte registrado. No cuenta como ingreso operativo."
          : "Retiro registrado. No cuenta como gasto operativo.",
    };
  } catch (error: unknown) {
    return fail(humanError(error));
  }
}

// --- Closure ----------------------------------------------------------------

const closurePreviewSchema = z.object({
  cashAccountId: z.string().min(1),
  closureDate: z.string().min(1),
});

export interface ClosurePreviewResult {
  ok: boolean;
  error: string | null;
  data: {
    openingBalance: string;
    totalIn: string;
    totalOut: string;
    expectedBalance: string;
    movementCount: number;
    alreadyClosed: boolean;
  } | null;
}

export async function loadClosurePreview(
  _previous: ClosurePreviewResult,
  formData: FormData,
): Promise<ClosurePreviewResult> {
  try {
    const user = await requireWriteAccess();
    const parsed = closurePreviewSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) {
      return { ok: false, error: "Datos inválidos.", data: null };
    }

    const preview = await tenantTransaction((tx) =>
      previewClosure(
        tx,
        user.organizationId,
        parsed.data.cashAccountId,
        calendarDate(parsed.data.closureDate),
      ),
    );

    return {
      ok: true,
      error: null,
      data: {
        openingBalance: preview.openingBalance.toDatabaseString(),
        totalIn: preview.totalIn.toDatabaseString(),
        totalOut: preview.totalOut.toDatabaseString(),
        expectedBalance: preview.expectedBalance.toDatabaseString(),
        movementCount: preview.movementCount,
        alreadyClosed: preview.existingClosure !== null,
      },
    };
  } catch (error: unknown) {
    return { ok: false, error: humanError(error), data: null };
  }
}

const closureSchema = closurePreviewSchema.extend({
  countedBalance: money,
  notes: z.string().optional(),
});

export async function performDailyClosure(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireWriteAccess();
    const parsed = closureSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) {
      return fail(parsed.error.issues[0]?.message ?? "Datos inválidos.");
    }

    const future = await assertNotFuture(parsed.data.closureDate);
    if (future) return fail("No se puede cerrar una fecha futura.");

    const result = await tenantTransaction((tx) =>
      performClosure(tx, {
        organizationId: user.organizationId,
        cashAccountId: parsed.data.cashAccountId,
        closureDate: calendarDate(parsed.data.closureDate),
        countedBalance: parsed.data.countedBalance,
        notes: parsed.data.notes || null,
        actor: { userId: user.id, email: user.email },
      }),
    );

    revalidateCash();
    return { ok: true, error: null, message: result.summary };
  } catch (error: unknown) {
    return fail(humanError(error));
  }
}

// --- Till adjustment --------------------------------------------------------

const adjustmentSchema = z.object({
  cashAccountId: z.string().min(1),
  occurredOn: z.string().min(1),
  /** Signed: negative for a shortfall. */
  difference: z
    .string()
    .trim()
    .transform((raw) =>
      raw.replace(/\./g, "").replace(/\s/g, "").replace(",", "."),
    )
    .refine((v) => /^-?\d+(\.\d{1,2})?$/.test(v), "Valor inválido.")
    .refine((v) => Number(v) !== 0, "La diferencia no puede ser cero."),
  reason: z.string().trim().min(5, "Escribí el motivo del ajuste."),
});

export async function createTillAdjustment(
  _previous: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireWriteAccess();
    const parsed = adjustmentSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) {
      return fail(parsed.error.issues[0]?.message ?? "Datos inválidos.");
    }

    const future = await assertNotFuture(parsed.data.occurredOn);
    if (future) return fail(future);

    await tenantTransaction((tx) =>
      recordTillAdjustment(tx, {
        organizationId: user.organizationId,
        cashAccountId: parsed.data.cashAccountId,
        difference: parsed.data.difference,
        occurredOn: calendarDate(parsed.data.occurredOn),
        reason: parsed.data.reason,
        actor: { userId: user.id, email: user.email },
      }),
    );

    revalidateCash();
    return {
      ok: true,
      error: null,
      message:
        "Ajuste registrado. El libro ahora coincide con lo contado, y la " +
        "diferencia quedó en el resultado.",
    };
  } catch (error: unknown) {
    return fail(humanError(error));
  }
}
