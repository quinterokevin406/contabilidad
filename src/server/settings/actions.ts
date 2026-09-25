"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { prisma } from "@/infra/db/client";
import { requireAdmin } from "@/server/auth/dal";

/**
 * Configuration (points 48 and 88).
 *
 * Administrators only. Changing a default here never touches an existing loan:
 * every loan copied its rules at creation, which is what lets the owner adjust
 * how the business works tomorrow without restating what it agreed yesterday.
 * Each change leaves a SETTINGS_CHANGE audit entry.
 */

export interface SettingsResult {
  ok: boolean;
  error: string | null;
  message: string | null;
}

function fail(error: string): SettingsResult {
  return { ok: false, error, message: null };
}

function done(message: string): SettingsResult {
  revalidatePath("/configuracion");
  revalidatePath("/");
  return { ok: true, error: null, message };
}

function humanError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Ocurrió un error y no se guardó nada.";
}

// --- Organization defaults ---------------------------------------------------

const organizationSchema = z.object({
  businessName: z.string().trim().min(2, "El nombre del negocio es obligatorio."),
  timeZone: z.string().min(1),
  defaultInterestMethod: z.enum([
    "SIMPLE_ON_ORIGINAL_PRINCIPAL",
    "SIMPLE_ON_OUTSTANDING_PRINCIPAL",
  ]),
  defaultPeriodicity: z.enum([
    "DAILY",
    "WEEKLY",
    "BIWEEKLY",
    "MONTHLY",
    "CUSTOM",
  ]),
  defaultAllocationStrategy: z.enum([
    "INTEREST_FIRST",
    "PRINCIPAL_FIRST",
    "MANUAL_ONLY",
  ]),
  defaultPeriodAnchor: z.enum(["CALENDAR", "FIXED_DAYS"]),
  defaultRoundingMode: z.enum(["HALF_UP", "HALF_EVEN", "DOWN", "UP"]),
  defaultOpenPeriodPolicy: z.enum(["NOT_CHARGED", "FULL_PERIOD", "PRORATED"]),
  defaultRenewalDueBasis: z.enum(["PREVIOUS_DUE_DATE", "EFFECTIVE_DATE"]),
  dueSoonLeadDays: z.coerce.number().int().min(0).max(60),
  overdueGraceDays: z.coerce.number().int().min(0).max(60),
  rateReviewThresholdPercent: z.string().optional(),
  rateReviewNote: z.string().optional(),
  receiptPrefix: z.string().trim().min(1).max(8),
});

export async function saveOrganizationSettings(
  _previous: SettingsResult,
  formData: FormData,
): Promise<SettingsResult> {
  try {
    const user = await requireAdmin();
    const parsed = organizationSchema.safeParse(Object.fromEntries(formData));

    if (!parsed.success) {
      return fail(parsed.error.issues[0]?.message ?? "Datos inválidos.");
    }

    const before = await prisma.organizationSettings.findUniqueOrThrow({
      where: { organizationId: user.organizationId },
    });

    const threshold = parsed.data.rateReviewThresholdPercent?.trim();

    await prisma.$transaction(async (tx) => {
      await tx.organizationSettings.update({
        where: { organizationId: user.organizationId },
        data: {
          businessName: parsed.data.businessName,
          timeZone: parsed.data.timeZone,
          defaultInterestMethod: parsed.data.defaultInterestMethod,
          defaultPeriodicity: parsed.data.defaultPeriodicity,
          defaultAllocationStrategy: parsed.data.defaultAllocationStrategy,
          defaultPeriodAnchor: parsed.data.defaultPeriodAnchor,
          defaultRoundingMode: parsed.data.defaultRoundingMode,
          defaultOpenPeriodPolicy: parsed.data.defaultOpenPeriodPolicy,
          defaultRenewalDueBasis: parsed.data.defaultRenewalDueBasis,
          dueSoonLeadDays: parsed.data.dueSoonLeadDays,
          overdueGraceDays: parsed.data.overdueGraceDays,
          rateReviewThresholdPercent: threshold ? threshold : null,
          rateReviewNote: parsed.data.rateReviewNote?.trim() || null,
          receiptPrefix: parsed.data.receiptPrefix.toUpperCase(),
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: user.organizationId,
          action: "SETTINGS_CHANGE",
          entity: "OrganizationSettings",
          entityId: before.id,
          beforeValues: {
            defaultInterestMethod: before.defaultInterestMethod,
            defaultAllocationStrategy: before.defaultAllocationStrategy,
            defaultRoundingMode: before.defaultRoundingMode,
            defaultOpenPeriodPolicy: before.defaultOpenPeriodPolicy,
            defaultRenewalDueBasis: before.defaultRenewalDueBasis,
            dueSoonLeadDays: before.dueSoonLeadDays,
            overdueGraceDays: before.overdueGraceDays,
          },
          afterValues: {
            defaultInterestMethod: parsed.data.defaultInterestMethod,
            defaultAllocationStrategy: parsed.data.defaultAllocationStrategy,
            defaultRoundingMode: parsed.data.defaultRoundingMode,
            defaultOpenPeriodPolicy: parsed.data.defaultOpenPeriodPolicy,
            defaultRenewalDueBasis: parsed.data.defaultRenewalDueBasis,
            dueSoonLeadDays: parsed.data.dueSoonLeadDays,
            overdueGraceDays: parsed.data.overdueGraceDays,
          },
          summary: "Cambió la configuración de la organización",
          actorId: user.id,
          actorEmail: user.email,
        },
      });
    });

    return done(
      "Configuración guardada. Los préstamos existentes conservan las reglas con las que fueron creados.",
    );
  } catch (error: unknown) {
    return fail(humanError(error));
  }
}

// --- Categories (point 88) ----------------------------------------------------

const categorySchema = z.object({
  name: z.string().trim().min(2, "Escribí un nombre para la categoría."),
  financialClass: z.enum(["OPERATING_EXPENSE", "OPERATING_INCOME"]),
});

export async function createCategory(
  _previous: SettingsResult,
  formData: FormData,
): Promise<SettingsResult> {
  try {
    const user = await requireAdmin();
    const parsed = categorySchema.safeParse(Object.fromEntries(formData));

    if (!parsed.success) {
      return fail(parsed.error.issues[0]?.message ?? "Datos inválidos.");
    }

    const existing = await prisma.transactionCategory.findFirst({
      where: {
        organizationId: user.organizationId,
        name: parsed.data.name,
        financialClass: parsed.data.financialClass,
      },
      select: { id: true, archivedAt: true },
    });

    if (existing) {
      if (!existing.archivedAt) {
        return fail("Ya existe una categoría con ese nombre.");
      }
      // Reviving beats creating a duplicate: the archived one may still carry
      // historical movements that must keep pointing somewhere sensible.
      await prisma.transactionCategory.update({
        where: { id: existing.id },
        data: { archivedAt: null, isActive: true },
      });
      return done(`Se reactivó la categoría "${parsed.data.name}".`);
    }

    await prisma.transactionCategory.create({
      data: {
        organizationId: user.organizationId,
        name: parsed.data.name,
        financialClass: parsed.data.financialClass,
        isSystem: false,
        isActive: true,
      },
    });

    return done(`Categoría "${parsed.data.name}" creada.`);
  } catch (error: unknown) {
    return fail(humanError(error));
  }
}

export async function archiveCategory(
  _previous: SettingsResult,
  formData: FormData,
): Promise<SettingsResult> {
  try {
    const user = await requireAdmin();
    const id = String(formData.get("categoryId") ?? "");
    if (!id) return fail("Categoría no indicada.");

    const category = await prisma.transactionCategory.findFirst({
      where: { id, organizationId: user.organizationId },
      select: {
        id: true,
        name: true,
        isSystem: true,
        archivedAt: true,
        _count: { select: { expenseEntries: true, incomeEntries: true } },
      },
    });

    if (!category) return fail("La categoría no existe.");
    if (category.isSystem) {
      return fail(
        `"${category.name}" es del sistema y se alimenta desde los préstamos.`,
      );
    }

    // Point 74: a category with history is archived, never deleted — deleting
    // it would orphan the movements that reference it.
    const movements =
      category._count.expenseEntries + category._count.incomeEntries;

    await prisma.transactionCategory.update({
      where: { id: category.id },
      data: {
        archivedAt: category.archivedAt ? null : new Date(),
        isActive: category.archivedAt !== null,
      },
    });

    return done(
      category.archivedAt
        ? `"${category.name}" volvió a estar disponible.`
        : `"${category.name}" archivada.` +
            (movements > 0
              ? ` Sus ${movements} movimientos históricos se conservan.`
              : ""),
    );
  } catch (error: unknown) {
    return fail(humanError(error));
  }
}

// --- Payment methods ----------------------------------------------------------

export async function createPaymentMethod(
  _previous: SettingsResult,
  formData: FormData,
): Promise<SettingsResult> {
  try {
    const user = await requireAdmin();
    const name = String(formData.get("name") ?? "").trim();

    if (name.length < 2) return fail("Escribí un nombre para el método.");

    const existing = await prisma.paymentMethod.findFirst({
      where: { organizationId: user.organizationId, name },
      select: { id: true, archivedAt: true },
    });

    if (existing) {
      if (!existing.archivedAt) return fail("Ese método ya existe.");
      await prisma.paymentMethod.update({
        where: { id: existing.id },
        data: { archivedAt: null, isActive: true },
      });
      return done(`Se reactivó "${name}".`);
    }

    const count = await prisma.paymentMethod.count({
      where: { organizationId: user.organizationId },
    });

    await prisma.paymentMethod.create({
      data: {
        organizationId: user.organizationId,
        name,
        sortOrder: count,
        isActive: true,
      },
    });

    return done(`Método "${name}" creado.`);
  } catch (error: unknown) {
    return fail(humanError(error));
  }
}

// --- Goals (point 85) ---------------------------------------------------------

const goalSchema = z.object({
  kind: z.enum([
    "EQUITY_TARGET",
    "MONTHLY_PROFIT",
    "MAX_DELINQUENCY_RATIO",
    "MAX_MONTHLY_EXPENSE",
    "INTEREST_COLLECTED",
    "RECOVERY_RATIO",
  ]),
  label: z.string().trim().min(2, "Ponéle un nombre a la meta."),
  targetValue: z
    .string()
    .trim()
    .transform((raw) =>
      raw.replace(/\./g, "").replace(/\s/g, "").replace(",", "."),
    )
    .refine((v) => /^\d+(\.\d{1,4})?$/.test(v), "El valor no es válido.")
    .refine((v) => Number(v) > 0, "La meta debe ser mayor a cero."),
});

const CEILING_GOALS = new Set(["MAX_DELINQUENCY_RATIO", "MAX_MONTHLY_EXPENSE"]);

export async function saveGoal(
  _previous: SettingsResult,
  formData: FormData,
): Promise<SettingsResult> {
  try {
    const user = await requireAdmin();
    const parsed = goalSchema.safeParse(Object.fromEntries(formData));

    if (!parsed.success) {
      return fail(parsed.error.issues[0]?.message ?? "Datos inválidos.");
    }

    const existing = await prisma.goal.findFirst({
      where: { organizationId: user.organizationId, kind: parsed.data.kind },
      select: { id: true },
    });

    const data = {
      label: parsed.data.label,
      targetValue: parsed.data.targetValue,
      // A maximum is a ceiling, a target is a floor. Getting this backwards
      // would render a breached expense limit as progress.
      direction: CEILING_GOALS.has(parsed.data.kind)
        ? ("AT_MOST" as const)
        : ("AT_LEAST" as const),
      isActive: true,
    };

    if (existing) {
      await prisma.goal.update({ where: { id: existing.id }, data });
    } else {
      await prisma.goal.create({
        data: {
          organizationId: user.organizationId,
          kind: parsed.data.kind,
          ...data,
        },
      });
    }

    return done("Meta guardada.");
  } catch (error: unknown) {
    return fail(humanError(error));
  }
}

export async function deleteGoal(
  _previous: SettingsResult,
  formData: FormData,
): Promise<SettingsResult> {
  try {
    const user = await requireAdmin();
    const id = String(formData.get("goalId") ?? "");
    if (!id) return fail("Meta no indicada.");

    await prisma.goal.updateMany({
      where: { id, organizationId: user.organizationId },
      data: { isActive: false },
    });

    return done("Meta desactivada.");
  } catch (error: unknown) {
    return fail(humanError(error));
  }
}

// --- Alert rules (point 86) ---------------------------------------------------

const alertSchema = z.object({
  metric: z.enum([
    "DELINQUENCY_RATIO",
    "MONTHLY_EXPENSE_TOTAL",
    "EXPENSE_TO_INCOME_RATIO",
    "OVERDUE_LOAN_COUNT",
    "OVERDUE_DAYS_MAX",
    "CASH_DISCREPANCY_ABS",
    "MISSING_MONTHLY_CLOSURE",
    "MISSING_DAILY_CLOSURE",
  ]),
  comparator: z.enum([
    "GREATER_THAN",
    "GREATER_OR_EQUAL",
    "LESS_THAN",
    "LESS_OR_EQUAL",
  ]),
  threshold: z
    .string()
    .trim()
    .transform((raw) => raw.replace(/\./g, "").replace(",", "."))
    .refine((v) => /^\d+(\.\d{1,4})?$/.test(v), "El umbral no es válido."),
  severity: z.enum(["INFO", "WARNING", "CRITICAL"]),
  label: z.string().trim().min(3, "Describí la alerta."),
});

export async function saveAlertRule(
  _previous: SettingsResult,
  formData: FormData,
): Promise<SettingsResult> {
  try {
    const user = await requireAdmin();
    const parsed = alertSchema.safeParse(Object.fromEntries(formData));

    if (!parsed.success) {
      return fail(parsed.error.issues[0]?.message ?? "Datos inválidos.");
    }

    await prisma.alertRule.upsert({
      where: {
        organizationId_metric_comparator_threshold: {
          organizationId: user.organizationId,
          metric: parsed.data.metric,
          comparator: parsed.data.comparator,
          threshold: parsed.data.threshold,
        },
      },
      update: {
        severity: parsed.data.severity,
        label: parsed.data.label,
        isActive: true,
      },
      create: {
        organizationId: user.organizationId,
        metric: parsed.data.metric,
        comparator: parsed.data.comparator,
        threshold: parsed.data.threshold,
        severity: parsed.data.severity,
        label: parsed.data.label,
        isActive: true,
      },
    });

    return done("Alerta guardada.");
  } catch (error: unknown) {
    return fail(humanError(error));
  }
}

export async function toggleAlertRule(
  _previous: SettingsResult,
  formData: FormData,
): Promise<SettingsResult> {
  try {
    const user = await requireAdmin();
    const id = String(formData.get("ruleId") ?? "");
    if (!id) return fail("Alerta no indicada.");

    const rule = await prisma.alertRule.findFirst({
      where: { id, organizationId: user.organizationId },
      select: { id: true, isActive: true, label: true },
    });
    if (!rule) return fail("La alerta no existe.");

    await prisma.alertRule.update({
      where: { id: rule.id },
      data: { isActive: !rule.isActive },
    });

    return done(
      rule.isActive ? `"${rule.label}" desactivada.` : `"${rule.label}" activada.`,
    );
  } catch (error: unknown) {
    return fail(humanError(error));
  }
}
