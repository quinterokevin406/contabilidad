"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { allocatePayment } from "@/core/payments/allocation";
import { Money } from "@/core/money/money";
import {
  calendarDate,
  fromPrismaDate,
  todayIn,
  type CalendarDate,
} from "@/core/time/calendar-date";
import { prisma, tenantTransaction } from "@/infra/db/client";
import { fromDb } from "@/infra/db/money";
import { getOrganizationSettings, requireWriteAccess } from "@/server/auth/dal";
import { accrueLoan } from "@/services/loans/accrue";
import { createLoan } from "@/services/loans/create-loan";
import { postPayment } from "@/services/payments/post-payment";
import { ServiceError } from "@/services/shared";

/**
 * Payment registration (points 10, 11, 12, 51 and 52).
 *
 * Two steps on purpose. `previewPayment` computes exactly what the money will do
 * without writing anything, so the operator confirms a real breakdown rather than
 * a promise. `registerPayment` then posts it inside a single transaction.
 *
 * Both call the SAME allocation engine, so what is shown and what is written
 * cannot disagree.
 */

const moneySchema = z
  .string()
  .trim()
  .min(1, "Ingresá un valor.")
  // Accept what a Colombian operator actually types: 300.000 or 300000.
  .transform((raw) => raw.replace(/\./g, "").replace(/\s/g, "").replace(",", "."))
  .refine((v) => /^\d+(\.\d{1,2})?$/.test(v), "El valor no es un número válido.")
  .refine((v) => Number(v) > 0, "El valor debe ser mayor a cero.");

const previewSchema = z.object({
  loanId: z.string().min(1),
  amount: moneySchema,
  paidOn: z.string().min(1),
  mode: z.enum(["AUTO", "MANUAL"]),
  manualInterest: z.string().optional(),
  manualPrincipal: z.string().optional(),
});

export interface PeriodOutcomeView {
  periodIndex: number;
  dueOn: CalendarDate;
  before: string;
  applied: string;
  after: string;
  fullySettled: boolean;
}

export interface PaymentBreakdown {
  amount: string;
  interest: string;
  principal: string;
  fees: string;
  unapplied: string;
  resultingPrincipal: string;
  periodOutcomes: PeriodOutcomeView[];
}

export interface PreviewResult {
  ok: boolean;
  error: string | null;
  breakdown: PaymentBreakdown | null;
}

/**
 * Carries the preview out of the transaction while rolling it back.
 *
 * Throwing is the only way to abort a Prisma interactive transaction, and the
 * preview must leave nothing behind: the real posting accrues the periods itself
 * a moment later.
 */
class PreviewComplete extends Error {
  constructor(readonly breakdown: PaymentBreakdown) {
    super("preview complete");
  }
}

export async function previewPayment(
  _previous: PreviewResult,
  formData: FormData,
): Promise<PreviewResult> {
  try {
    const user = await requireWriteAccess();
    const settings = await getOrganizationSettings();

    const parsed = previewSchema.safeParse({
      loanId: formData.get("loanId"),
      amount: formData.get("amount"),
      paidOn: formData.get("paidOn"),
      mode: formData.get("mode"),
      manualInterest: formData.get("manualInterest") ?? undefined,
      manualPrincipal: formData.get("manualPrincipal") ?? undefined,
    });

    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Datos inválidos.",
        breakdown: null,
      };
    }

    const paidOn = calendarDate(parsed.data.paidOn);
    const today = todayIn(settings.timeZone);

    if (paidOn > today) {
      return {
        ok: false,
        error: "No se puede registrar un pago con fecha futura.",
        breakdown: null,
      };
    }

    const breakdown = await tenantTransaction(async (tx) => {
        // Accrue so the preview sees exactly the debt the posting will see.
        await accrueLoan(tx, parsed.data.loanId, paidOn);

        const loan = await tx.loan.findFirst({
          where: {
            id: parsed.data.loanId,
            organizationId: user.organizationId,
            lifecycle: "ACTIVE",
          },
          select: {
            allocationStrategy: true,
            outstandingPrincipal: true,
            periods: {
              where: { status: { in: ["PENDING", "PARTIALLY_PAID"] } },
              orderBy: { periodIndex: "asc" },
              select: {
                id: true,
                periodIndex: true,
                dueOn: true,
                interestAccrued: true,
                interestPaid: true,
                interestWaived: true,
              },
            },
          },
        });

        if (!loan) {
          throw new ServiceError("El préstamo no existe o ya está cerrado.");
        }

        const openPeriods = loan.periods
          .map((p) => ({
            periodId: p.id,
            periodIndex: p.periodIndex,
            dueOn: fromPrismaDate(p.dueOn),
            interestOutstanding: fromDb(p.interestAccrued)
              .minus(fromDb(p.interestPaid))
              .minus(fromDb(p.interestWaived)),
          }))
          .filter((p) => p.interestOutstanding.isPositive());

        const amount = Money.of(parsed.data.amount);

        const plan = allocatePayment({
          amount,
          debt: {
            periods: openPeriods,
            principalOutstanding: fromDb(loan.outstandingPrincipal),
          },
          strategy:
            parsed.data.mode === "MANUAL"
              ? "MANUAL_ONLY"
              : loan.allocationStrategy,
          manual:
            parsed.data.mode === "MANUAL"
              ? buildManual(openPeriods, parsed.data)
              : undefined,
        });

        const byId = new Map(openPeriods.map((p) => [p.periodId, p]));

        throw new PreviewComplete({
          amount: amount.toDatabaseString(),
          interest: plan.interestTotal.toDatabaseString(),
          principal: plan.principalTotal.toDatabaseString(),
          fees: plan.feeTotal.toDatabaseString(),
          unapplied: plan.unapplied.toDatabaseString(),
          resultingPrincipal: plan.resultingPrincipal.toDatabaseString(),
          periodOutcomes: plan.periodOutcomes
            .filter((o) => o.interestApplied.isPositive())
            .map((o) => {
              const period = byId.get(o.periodId)!;
              return {
                periodIndex: period.periodIndex,
                dueOn: period.dueOn,
                before: o.interestBefore.toDatabaseString(),
                applied: o.interestApplied.toDatabaseString(),
                after: o.interestAfter.toDatabaseString(),
                fullySettled: o.fullySettled,
              };
            }),
        });
      })
      .catch((error: unknown) => {
        if (error instanceof PreviewComplete) return error.breakdown;
        throw error;
      });

    return { ok: true, error: null, breakdown };
  } catch (error: unknown) {
    return { ok: false, error: humanError(error), breakdown: null };
  }
}

function buildManual(
  openPeriods: { periodId: string; interestOutstanding: Money }[],
  data: { manualInterest?: string; manualPrincipal?: string },
) {
  const interestTotal = Money.of(normalizeMoney(data.manualInterest ?? "0"));

  // Spread the stated interest across open periods, oldest first, the same way
  // the automatic strategy would.
  let remaining = interestTotal;
  const interest: { periodId: string; amount: string }[] = [];

  for (const period of openPeriods) {
    if (!remaining.isPositive()) break;
    const applied = Money.min(period.interestOutstanding, remaining);
    interest.push({
      periodId: period.periodId,
      amount: applied.toDatabaseString(),
    });
    remaining = remaining.minus(applied);
  }

  if (remaining.isPositive()) {
    throw new ServiceError(
      `Asignaste ${interestTotal.toDatabaseString()} a intereses, pero solo hay ` +
        `${interestTotal.minus(remaining).toDatabaseString()} de interés pendiente.`,
    );
  }

  return { interest, principal: normalizeMoney(data.manualPrincipal ?? "0") };
}

function normalizeMoney(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/\./g, "")
    .replace(/\s/g, "")
    .replace(",", ".");
  return cleaned === "" ? "0" : cleaned;
}

// --- Posting ----------------------------------------------------------------

const registerSchema = previewSchema.extend({
  paymentMethodId: z.string().optional(),
  notes: z.string().optional(),
  /** Generated by the browser, so a retry cannot post twice (point 51). */
  idempotencyKey: z.string().min(8),
});

export interface RegisterResult {
  ok: boolean;
  error: string | null;
  receiptNumber: string | null;
}

export async function registerPayment(
  _previous: RegisterResult,
  formData: FormData,
): Promise<RegisterResult> {
  try {
    const user = await requireWriteAccess();
    const settings = await getOrganizationSettings();

    const parsed = registerSchema.safeParse({
      loanId: formData.get("loanId"),
      amount: formData.get("amount"),
      paidOn: formData.get("paidOn"),
      mode: formData.get("mode"),
      manualInterest: formData.get("manualInterest") ?? undefined,
      manualPrincipal: formData.get("manualPrincipal") ?? undefined,
      paymentMethodId: formData.get("paymentMethodId") ?? undefined,
      notes: formData.get("notes") ?? undefined,
      idempotencyKey: formData.get("idempotencyKey"),
    });

    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Datos inválidos.",
        receiptNumber: null,
      };
    }

    const paidOn = calendarDate(parsed.data.paidOn);
    const today = todayIn(settings.timeZone);

    if (paidOn > today) {
      return {
        ok: false,
        error: "No se puede registrar un pago con fecha futura.",
        receiptNumber: null,
      };
    }

    const result = await tenantTransaction(
      async (tx) => {
        let manual;

        if (parsed.data.mode === "MANUAL") {
          await accrueLoan(tx, parsed.data.loanId, paidOn);

          const periods = await tx.loanPeriod.findMany({
            where: {
              loanId: parsed.data.loanId,
              status: { in: ["PENDING", "PARTIALLY_PAID"] },
            },
            orderBy: { periodIndex: "asc" },
            select: {
              id: true,
              interestAccrued: true,
              interestPaid: true,
              interestWaived: true,
            },
          });

          manual = buildManual(
            periods
              .map((p) => ({
                periodId: p.id,
                interestOutstanding: fromDb(p.interestAccrued)
                  .minus(fromDb(p.interestPaid))
                  .minus(fromDb(p.interestWaived)),
              }))
              .filter((p) => p.interestOutstanding.isPositive()),
            parsed.data,
          );
        }

        return postPayment(tx, {
          organizationId: user.organizationId,
          loanId: parsed.data.loanId,
          amount: parsed.data.amount,
          paidOn,
          paymentMethodId: parsed.data.paymentMethodId || null,
          strategy: parsed.data.mode === "MANUAL" ? "MANUAL_ONLY" : undefined,
          manual,
          notes: parsed.data.notes || null,
          actor: { userId: user.id, email: user.email },
          idempotencyKey: parsed.data.idempotencyKey,
          settings: {
            dueSoonLeadDays: settings.dueSoonLeadDays,
            overdueGraceDays: settings.overdueGraceDays,
          },
        });
      },
      { timeout: 30_000 },
    );

    revalidatePath(`/prestamos/${parsed.data.loanId}`);
    revalidatePath("/prestamos");
    revalidatePath("/clientes");
    revalidatePath("/");

    return { ok: true, error: null, receiptNumber: result.receiptNumber };
  } catch (error: unknown) {
    return { ok: false, error: humanError(error), receiptNumber: null };
  }
}

function humanError(error: unknown): string {
  // Domain and service errors already carry operator-readable Spanish or a
  // precise technical statement; anything else is a bug and says so.
  if (error instanceof Error && error.message) return error.message;
  return "Ocurrió un error inesperado y no se registró nada.";
}

/**
 * Disbursing a loan.
 *
 * The rules are copied onto the loan here and frozen: interest method,
 * periodicity, allocation order, rounding, how a period in progress is charged
 * when it is settled early, where a renewal measures from. Changing a default
 * in Settings tomorrow never reaches back into this loan — that is the whole
 * reason they are stored per loan rather than read from configuration when a
 * balance is computed.
 */
const newLoanSchema = z.object({
  clientId: z.string().min(1, "Elegí un cliente."),
  principal: moneySchema,
  ratePercent: z
    .string()
    .trim()
    .transform((raw) => raw.replace(/\./g, "").replace(",", "."))
    .refine((v) => /^\d+(\.\d{1,4})?$/.test(v), "La tasa no es válida.")
    .refine((v) => Number(v) > 0, "La tasa tiene que ser mayor a cero."),
  periodicity: z.enum(["DAILY", "WEEKLY", "BIWEEKLY", "MONTHLY", "CUSTOM"]),
  customPeriodDays: z.coerce.number().int().min(1).max(365).optional(),
  interestMethod: z.enum([
    "SIMPLE_ON_ORIGINAL_PRINCIPAL",
    "SIMPLE_ON_OUTSTANDING_PRINCIPAL",
  ]),
  disbursedOn: z.string().min(10),
  firstDueOn: z.string().min(10),
  notes: z.string().optional(),
  idempotencyKey: z.string().min(1),
});

export interface CreateLoanActionResult {
  ok: boolean;
  error: string | null;
  message: string | null;
  loanId: string | null;
}

export async function registerLoan(
  _previous: CreateLoanActionResult,
  formData: FormData,
): Promise<CreateLoanActionResult> {
  try {
    const user = await requireWriteAccess();
    const settings = await getOrganizationSettings();
    const parsed = newLoanSchema.safeParse(Object.fromEntries(formData));

    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Datos inválidos.",
        message: null,
        loanId: null,
      };
    }

    const data = parsed.data;
    const disbursedOn = calendarDate(data.disbursedOn);
    const firstDueOn = calendarDate(data.firstDueOn);

    if (firstDueOn <= disbursedOn) {
      return {
        ok: false,
        error: "El primer vencimiento tiene que ser posterior al desembolso.",
        message: null,
        loanId: null,
      };
    }

    const result = await tenantTransaction((tx) =>
      createLoan(tx, {
        organizationId: user.organizationId,
        clientId: data.clientId,
        principal: Money.of(data.principal),
        ratePercent: data.ratePercent,
        periodicity: data.periodicity,
        customPeriodDays:
          data.periodicity === "CUSTOM" ? (data.customPeriodDays ?? 30) : null,
        interestMethod: data.interestMethod,
        // Frozen from the organization's defaults at this moment. A later
        // change in Settings must never move a balance that already exists.
        allocationStrategy: settings.defaultAllocationStrategy,
        periodAnchor: settings.defaultPeriodAnchor,
        roundingMode: settings.defaultRoundingMode,
        moneyQuantum: settings.moneyQuantum.toString(),
        openPeriodPolicy: settings.defaultOpenPeriodPolicy,
        renewalDueBasis: settings.defaultRenewalDueBasis,
        disbursedOn,
        firstDueOn,
        notes: data.notes ?? null,
        actor: { userId: user.id, email: user.email },
        idempotencyKey: data.idempotencyKey,
      }),
    );

    revalidatePath("/prestamos");
    revalidatePath("/clientes");
    revalidatePath(`/clientes/${data.clientId}`);

    return {
      ok: true,
      error: null,
      message: result.deduplicated
        ? `Ese préstamo ya estaba registrado como ${result.code}.`
        : `Préstamo ${result.code} desembolsado. La plata salió de la caja.`,
      loanId: result.loanId,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error:
        error instanceof Error && error.message
          ? error.message
          : "Ocurrió un error y no se registró nada.",
      message: null,
      loanId: null,
    };
  }
}
