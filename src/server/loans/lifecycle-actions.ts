"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { planRenewal, type CapitalChange } from "@/core/loans/renewal";
import { Money } from "@/core/money/money";
import {
  calendarDate,
  fromPrismaDate,
  todayIn,
  type CalendarDate,
} from "@/core/time/calendar-date";
import { prisma } from "@/infra/db/client";
import { fromDb } from "@/infra/db/money";
import { getOrganizationSettings, requireWriteAccess } from "@/server/auth/dal";
import { accrueLoan } from "@/services/loans/accrue";
import { renewLoan } from "@/services/loans/renew";
import { quoteLoanSettlement, settleLoan } from "@/services/loans/settle";
import { ServiceError, type Tx } from "@/services/shared";

/**
 * Renewal and settlement actions (points 13, 14 and 16).
 *
 * Same two-step shape as payments: a preview computed by the real engine inside
 * a rolled-back transaction, then a confirmation that posts. Both steps go
 * through the same code, so the figures an operator approves are the figures
 * that get written.
 */

/**
 * Runs a computation inside a transaction that is always rolled back.
 *
 * A preview must accrue periods to see the true debt, and none of that may
 * survive. Throwing is the only way to abort a Prisma interactive transaction,
 * so the result rides out on the error.
 */
class Preview<T> extends Error {
  constructor(readonly value: T) {
    super("preview");
  }
}

async function preview<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma
    .$transaction(
      async (tx) => {
        throw new Preview(await fn(tx));
      },
      { timeout: 30_000 },
    )
    .catch((error: unknown) => {
      if (error instanceof Preview) return error.value as T;
      throw error;
    });
}

function humanError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Ocurrió un error inesperado y no se registró nada.";
}

const money = z
  .string()
  .trim()
  .transform((raw) =>
    raw.replace(/\./g, "").replace(/\s/g, "").replace(",", "."),
  )
  .refine((v) => v === "" || /^\d+(\.\d{1,2})?$/.test(v), "Valor inválido.")
  .transform((v) => (v === "" ? "0" : v));

// --- Renewal ----------------------------------------------------------------

const renewalSchema = z.object({
  loanId: z.string().min(1),
  effectiveOn: z.string().min(1),
  interestPaid: money,
  capitalMode: z.enum(["UNCHANGED", "INCREASE", "DECREASE"]),
  capitalAmount: money.optional(),
  allowPartialInterest: z.string().optional(),
});

export interface RenewalPreviewData {
  interestDue: string;
  interestCollected: string;
  interestCarried: string;
  previousPrincipal: string;
  newPrincipal: string;
  additionalDisbursed: string;
  principalCollected: string;
  cashIn: string;
  cashOut: string;
  netCash: string;
  newDueOn: CalendarDate;
  closedPeriods: number;
  sequence: number;
}

export interface RenewalPreviewResult {
  ok: boolean;
  error: string | null;
  data: RenewalPreviewData | null;
}

export async function previewRenewal(
  _previous: RenewalPreviewResult,
  formData: FormData,
): Promise<RenewalPreviewResult> {
  try {
    const user = await requireWriteAccess();
    const settings = await getOrganizationSettings();

    const parsed = renewalSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Datos inválidos.",
        data: null,
      };
    }

    const effectiveOn = calendarDate(parsed.data.effectiveOn);
    if (effectiveOn > todayIn(settings.timeZone)) {
      return {
        ok: false,
        error: "No se puede renovar con fecha futura.",
        data: null,
      };
    }

    const data = await preview(async (tx) => {
      await accrueLoan(tx, parsed.data.loanId, effectiveOn);

      const loan = await tx.loan.findFirst({
        where: {
          id: parsed.data.loanId,
          organizationId: user.organizationId,
          lifecycle: "ACTIVE",
        },
        select: {
          currentPrincipalBase: true,
          outstandingPrincipal: true,
          renewalCount: true,
          periodicity: true,
          periodAnchor: true,
          customPeriodDays: true,
          renewalDueBasis: true,
          periods: {
            where: { status: { in: ["PENDING", "PARTIALLY_PAID"] } },
            orderBy: { periodIndex: "asc" },
            select: {
              id: true,
              dueOn: true,
              interestAccrued: true,
              interestPaid: true,
              interestWaived: true,
            },
          },
        },
      });

      if (!loan) throw new ServiceError("El préstamo no existe o ya está cerrado.");
      if (loan.periods.length === 0) {
        throw new ServiceError(
          "Todavía no hay ningún período causado, así que no hay nada que renovar.",
        );
      }

      const closingPeriods = loan.periods.map((p) => ({
        periodId: p.id,
        dueOn: fromPrismaDate(p.dueOn),
        interestOutstanding: fromDb(p.interestAccrued)
          .minus(fromDb(p.interestPaid))
          .minus(fromDb(p.interestWaived)),
      }));

      const interestDue = Money.sum(
        closingPeriods.map((p) => p.interestOutstanding),
      );

      const plan = planRenewal({
        loan: {
          currentPrincipalBase: fromDb(loan.currentPrincipalBase),
          outstandingPrincipal: fromDb(loan.outstandingPrincipal),
          renewalCount: loan.renewalCount,
          schedule: {
            periodicity: loan.periodicity,
            anchor: loan.periodAnchor,
            customPeriodDays: loan.customPeriodDays,
          },
        },
        closingPeriods,
        interestPaid: parsed.data.interestPaid,
        capitalChange: buildCapitalChange(parsed.data),
        effectiveOn,
        dueBasis: loan.renewalDueBasis,
        allowPartialInterest: parsed.data.allowPartialInterest === "on",
      });

      return {
        interestDue: interestDue.toDatabaseString(),
        interestCollected: plan.interestCollected.toDatabaseString(),
        interestCarried: plan.interestCarried.toDatabaseString(),
        previousPrincipal: plan.previousOutstandingPrincipal.toDatabaseString(),
        newPrincipal: plan.newOutstandingPrincipal.toDatabaseString(),
        additionalDisbursed: plan.additionalDisbursed.toDatabaseString(),
        principalCollected: plan.principalCollected.toDatabaseString(),
        cashIn: plan.cashIn.toDatabaseString(),
        cashOut: plan.cashOut.toDatabaseString(),
        netCash: plan.netCash.toDatabaseString(),
        newDueOn: plan.newDueOn,
        closedPeriods: plan.closedPeriodIds.length,
        sequence: plan.sequence,
      } satisfies RenewalPreviewData;
    });

    return { ok: true, error: null, data };
  } catch (error: unknown) {
    return { ok: false, error: humanError(error), data: null };
  }
}

function buildCapitalChange(data: {
  capitalMode: "UNCHANGED" | "INCREASE" | "DECREASE";
  capitalAmount?: string;
}): CapitalChange {
  switch (data.capitalMode) {
    case "UNCHANGED":
      return { kind: "UNCHANGED" };
    case "INCREASE":
      return { kind: "INCREASE", additionalDisbursed: data.capitalAmount ?? "0" };
    case "DECREASE":
      return { kind: "DECREASE", principalCollected: data.capitalAmount ?? "0" };
  }
}

const confirmRenewalSchema = renewalSchema.extend({
  paymentMethodId: z.string().optional(),
  notes: z.string().optional(),
  idempotencyKey: z.string().min(8),
});

export interface ConfirmResult {
  ok: boolean;
  error: string | null;
  summary: string | null;
}

export async function confirmRenewal(
  _previous: ConfirmResult,
  formData: FormData,
): Promise<ConfirmResult> {
  try {
    const user = await requireWriteAccess();
    const settings = await getOrganizationSettings();

    const parsed = confirmRenewalSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Datos inválidos.",
        summary: null,
      };
    }

    const effectiveOn = calendarDate(parsed.data.effectiveOn);

    const result = await prisma.$transaction(
      async (tx) =>
        renewLoan(tx, {
          organizationId: user.organizationId,
          loanId: parsed.data.loanId,
          interestPaid: parsed.data.interestPaid,
          capitalChange: buildCapitalChange(parsed.data),
          effectiveOn,
          allowPartialInterest: parsed.data.allowPartialInterest === "on",
          paymentMethodId: parsed.data.paymentMethodId || null,
          notes: parsed.data.notes || null,
          actor: { userId: user.id, email: user.email },
          idempotencyKey: parsed.data.idempotencyKey,
          settings: {
            dueSoonLeadDays: settings.dueSoonLeadDays,
            overdueGraceDays: settings.overdueGraceDays,
          },
        }),
      { timeout: 30_000 },
    );

    revalidateLoan(parsed.data.loanId);

    return {
      ok: true,
      error: null,
      summary: `Renovación ${result.sequence} registrada. Próximo vencimiento: ${result.newDueOn}.`,
    };
  } catch (error: unknown) {
    return { ok: false, error: humanError(error), summary: null };
  }
}

// --- Settlement -------------------------------------------------------------

const settlementSchema = z.object({
  loanId: z.string().min(1),
  asOf: z.string().min(1),
  policyOverride: z.enum(["NOT_CHARGED", "FULL_PERIOD", "PRORATED", ""]).optional(),
});

export interface SettlementPreviewData {
  principalOutstanding: string;
  accruedInterest: string;
  openPeriodCharge: string;
  openPeriodExplanation: string;
  policyApplied: string;
  total: string;
}

export interface SettlementPreviewResult {
  ok: boolean;
  error: string | null;
  data: SettlementPreviewData | null;
}

export async function previewSettlement(
  _previous: SettlementPreviewResult,
  formData: FormData,
): Promise<SettlementPreviewResult> {
  try {
    const user = await requireWriteAccess();
    const settings = await getOrganizationSettings();

    const parsed = settlementSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Datos inválidos.",
        data: null,
      };
    }

    const asOf = calendarDate(parsed.data.asOf);
    if (asOf > todayIn(settings.timeZone)) {
      return {
        ok: false,
        error: "No se puede liquidar con fecha futura.",
        data: null,
      };
    }

    const data = await preview(async (tx) => {
      const result = await quoteLoanSettlement(tx, {
        organizationId: user.organizationId,
        loanId: parsed.data.loanId,
        asOf,
        openPeriodPolicyOverride: parsed.data.policyOverride
          ? parsed.data.policyOverride
          : null,
      });

      return {
        principalOutstanding:
          result.quote.principalOutstanding.toDatabaseString(),
        accruedInterest:
          result.quote.accruedInterestOutstanding.toDatabaseString(),
        openPeriodCharge: result.quote.openPeriodCharge.toDatabaseString(),
        openPeriodExplanation: result.quote.openPeriodExplanation,
        policyApplied: result.quote.openPeriodPolicy,
        total: result.quote.total.toDatabaseString(),
      } satisfies SettlementPreviewData;
    });

    return { ok: true, error: null, data };
  } catch (error: unknown) {
    return { ok: false, error: humanError(error), data: null };
  }
}

const confirmSettlementSchema = settlementSchema
  .extend({
    kind: z.enum(["FULL_PAYMENT", "WRITE_OFF"]).default("FULL_PAYMENT"),
    amountReceived: money,
    reason: z.string().optional(),
    paymentMethodId: z.string().optional(),
    notes: z.string().optional(),
    idempotencyKey: z.string().min(8),
  })
  // A write-off closes a debt the business will not collect. Requiring a stated
  // reason at the edge means the audit trail can never contain a silent one.
  .refine(
    (data) =>
      data.kind !== "WRITE_OFF" || (data.reason?.trim().length ?? 0) >= 5,
    {
      message: "Un castigo de cartera necesita un motivo escrito.",
      path: ["reason"],
    },
  );

export async function confirmSettlement(
  _previous: ConfirmResult,
  formData: FormData,
): Promise<ConfirmResult> {
  try {
    const user = await requireWriteAccess();
    const settings = await getOrganizationSettings();

    const parsed = confirmSettlementSchema.safeParse(
      Object.fromEntries(formData),
    );
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Datos inválidos.",
        summary: null,
      };
    }

    const asOf = calendarDate(parsed.data.asOf);

    const result = await prisma.$transaction(
      async (tx) =>
        settleLoan(tx, {
          organizationId: user.organizationId,
          loanId: parsed.data.loanId,
          asOf,
          openPeriodPolicyOverride: parsed.data.policyOverride
            ? parsed.data.policyOverride
            : null,
          kind: parsed.data.kind,
          amountReceived: parsed.data.amountReceived,
          reason: parsed.data.reason || null,
          paymentMethodId: parsed.data.paymentMethodId || null,
          notes: parsed.data.notes || null,
          actor: { userId: user.id, email: user.email },
          idempotencyKey: parsed.data.idempotencyKey,
          settings: {
            dueSoonLeadDays: settings.dueSoonLeadDays,
            overdueGraceDays: settings.overdueGraceDays,
          },
        }),
      { timeout: 30_000 },
    );

    revalidateLoan(parsed.data.loanId);

    return {
      ok: true,
      error: null,
      summary:
        parsed.data.kind === "WRITE_OFF"
          ? `Préstamo cerrado con castigo de ${result.principalWrittenOff.toDatabaseString()} ` +
            `de capital. Registrado como gasto operativo.`
          : `Préstamo liquidado. Recibo ${result.receiptNumber}.`,
    };
  } catch (error: unknown) {
    return { ok: false, error: humanError(error), summary: null };
  }
}

function revalidateLoan(loanId: string): void {
  revalidatePath(`/prestamos/${loanId}`);
  revalidatePath("/prestamos");
  revalidatePath("/clientes");
  revalidatePath("/");
}
