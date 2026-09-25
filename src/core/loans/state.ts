import { Money, type MoneyInput } from "@/core/money/money";
import {
  addDays,
  differenceInDays,
  type CalendarDate,
} from "@/core/time/calendar-date";

/** Mirrors the LoanLifecycle enum: is the loan still a live obligation? */
export type LoanLifecycle = "ACTIVE" | "PAID" | "CANCELLED" | "ARCHIVED";

/** Mirrors the ComplianceStatus enum: is the client keeping up? */
export type ComplianceStatus = "CURRENT" | "DUE_SOON" | "OVERDUE";

/**
 * The eight states point 17 asks for, as presentation codes.
 *
 * They are DERIVED, not stored. Storing them would mean eight mutually exclusive
 * values, and the truth is that "active" and "overdue" are answers to two
 * different questions -- a loan can be both at once. The database keeps the two
 * orthogonal columns; this module composes them into the label an operator reads.
 */
export type LoanStateCode =
  | "AL_DIA"
  | "PENDIENTE"
  | "VENCIDO"
  | "EN_RENOVACION"
  | "PAGADO"
  | "CANCELADO"
  | "ARCHIVADO";

export interface LoanDebtState {
  outstandingPrincipal: MoneyInput;
  /** Sum of interest still owed across all accrued periods. */
  outstandingInterest: MoneyInput;
}

export interface ComplianceInput {
  /**
   * Due date of the oldest accrued period that still owes interest. Null when
   * nothing accrued is unpaid.
   */
  oldestUnpaidDueOn: CalendarDate | null;
  /** Due date of the next period that has not accrued yet. */
  nextDueOn: CalendarDate | null;
  today: CalendarDate;
  /** Days after a due date before the loan counts as overdue. */
  overdueGraceDays: number;
  /** Days before a due date at which the loan is flagged as coming up. */
  dueSoonLeadDays: number;
}

/**
 * Decides whether a loan is current, coming due, or overdue.
 *
 * The grace period is applied to the OLDEST unpaid accrued period, not to the
 * newest. A client three periods behind is overdue on the strength of the first
 * one, and a grace window on the most recent period must never mask that.
 */
export function deriveCompliance(input: ComplianceInput): ComplianceStatus {
  if (input.overdueGraceDays < 0 || input.dueSoonLeadDays < 0) {
    throw new Error("Grace and lead day counts cannot be negative.");
  }

  if (input.oldestUnpaidDueOn) {
    const deadline = addDays(input.oldestUnpaidDueOn, input.overdueGraceDays);
    if (input.today > deadline) return "OVERDUE";
    // Accrued and unpaid but still inside the grace window: the money is owed
    // today, so this is not "current".
    return "DUE_SOON";
  }

  if (input.nextDueOn) {
    const daysUntil = differenceInDays(input.today, input.nextDueOn);
    if (daysUntil <= input.dueSoonLeadDays) return "DUE_SOON";
  }

  return "CURRENT";
}

/**
 * Days overdue, measured from the oldest unpaid accrued period.
 *
 * Zero when the loan is not overdue. Drives the aging buckets of point 79, so it
 * deliberately counts from the due date itself and not from the end of the grace
 * window: the aging report answers "how late is this money", not "when did we
 * start calling it late".
 */
export function computeDaysOverdue(
  oldestUnpaidDueOn: CalendarDate | null,
  today: CalendarDate,
): number {
  if (!oldestUnpaidDueOn) return 0;
  const days = differenceInDays(oldestUnpaidDueOn, today);
  return days > 0 ? days : 0;
}

/**
 * Decides whether a loan is still live.
 *
 * A loan is PAID only when both principal and accrued interest reach exactly
 * zero. "Close enough" does not exist here: the balance is decimal-exact, so a
 * residual peso means the loan is still open and the operator needs to see it.
 */
export function deriveLifecycle(
  current: LoanLifecycle,
  debt: LoanDebtState,
): LoanLifecycle {
  // Terminal states are never revisited by a balance check.
  if (current !== "ACTIVE") return current;

  const principal = Money.of(debt.outstandingPrincipal);
  const interest = Money.of(debt.outstandingInterest);

  if (principal.isNegative() || interest.isNegative()) {
    throw new Error(
      "A loan reports a negative balance, which means its state is corrupt.",
    );
  }

  return principal.isZero() && interest.isZero() ? "PAID" : "ACTIVE";
}

export interface LoanStateDescription {
  code: LoanStateCode;
  /** Short label for badges. */
  label: string;
  /**
   * Visual tone. Point 56 requires that colour is never the only signal, so the
   * label above always travels with it.
   */
  tone: "positive" | "warning" | "danger" | "neutral" | "info";
  /** One sentence an operator can act on, derived only from the data. */
  explanation: string;
}

export interface DescribeLoanStateInput {
  lifecycle: LoanLifecycle;
  compliance: ComplianceStatus;
  debt: LoanDebtState;
  daysOverdue: number;
  /** True while a renewal is being recorded for this loan. */
  renewalInProgress?: boolean;
}

/**
 * Composes the two stored columns into the state an operator sees.
 *
 * Every branch returns text as well as a tone, so the UI never has to encode
 * meaning in colour alone.
 */
export function describeLoanState(
  input: DescribeLoanStateInput,
): LoanStateDescription {
  switch (input.lifecycle) {
    case "ARCHIVED":
      return {
        code: "ARCHIVADO",
        label: "Archivado",
        tone: "neutral",
        explanation: "El préstamo está archivado y no aparece en la cartera activa.",
      };
    case "CANCELLED":
      return {
        code: "CANCELADO",
        label: "Cancelado",
        tone: "neutral",
        explanation: "El préstamo se cerró administrativamente.",
      };
    case "PAID":
      return {
        code: "PAGADO",
        label: "Pagado",
        tone: "positive",
        explanation: "El saldo llegó a cero. Capital e intereses quedaron cubiertos.",
      };
    case "ACTIVE":
      break;
  }

  if (input.renewalInProgress) {
    return {
      code: "EN_RENOVACION",
      label: "En renovación",
      tone: "info",
      explanation: "Se está registrando una renovación para este préstamo.",
    };
  }

  if (input.compliance === "OVERDUE") {
    const days = input.daysOverdue;
    return {
      code: "VENCIDO",
      label: "Vencido",
      tone: "danger",
      explanation:
        days === 1
          ? "Tiene 1 día de atraso sobre el período más antiguo sin pagar."
          : `Tiene ${days} días de atraso sobre el período más antiguo sin pagar.`,
    };
  }

  const outstandingInterest = Money.of(input.debt.outstandingInterest);

  if (outstandingInterest.isPositive()) {
    return {
      code: "PENDIENTE",
      label: "Pendiente",
      tone: "warning",
      explanation:
        "Hay interés devengado sin pagar, todavía dentro del plazo de gracia.",
    };
  }

  return {
    code: "AL_DIA",
    label: "Al día",
    tone: "positive",
    explanation:
      input.compliance === "DUE_SOON"
        ? "Sin saldo vencido. Tiene un cobro próximo."
        : "Sin saldo vencido ni interés pendiente.",
  };
}

/**
 * Aging bucket boundaries for point 79.
 *
 * Exported as data rather than hardcoded inside a query so the report, the chart
 * and the tests all read from one definition.
 */
export const AGING_BUCKETS = [
  { fromDays: 1, toDays: 7, label: "1–7 días" },
  { fromDays: 8, toDays: 15, label: "8–15 días" },
  { fromDays: 16, toDays: 30, label: "16–30 días" },
  { fromDays: 31, toDays: 60, label: "31–60 días" },
  { fromDays: 61, toDays: 90, label: "61–90 días" },
  { fromDays: 91, toDays: null, label: "+90 días" },
] as const;

export type AgingBucket = (typeof AGING_BUCKETS)[number];

/** Places a day count into its aging bucket. Null when not overdue. */
export function resolveAgingBucket(daysOverdue: number): AgingBucket | null {
  if (daysOverdue < 1) return null;
  for (const bucket of AGING_BUCKETS) {
    if (bucket.toDays === null || daysOverdue <= bucket.toDays) return bucket;
  }
  return null;
}
