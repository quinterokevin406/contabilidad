import type { Money } from "@/core/money/money";
import type { CalendarDate } from "@/core/time/calendar-date";
import { toPrismaDate } from "@/core/time/calendar-date";
import type {
  AuditAction,
  CashDirection,
  CashMovementType,
  FinancialClass,
  Prisma,
} from "@/generated/prisma";
import { toDb } from "@/infra/db/money";

/**
 * The client every financial service takes.
 *
 * Services accept a TRANSACTION client rather than the top-level PrismaClient on
 * purpose: it is then impossible to run half of a financial operation outside the
 * transaction by accident (point 42). Callers open the transaction; services
 * never open their own.
 */
export type Tx = Prisma.TransactionClient;

export class ServiceError extends Error {}

/** Who is performing an operation, for the audit trail. */
export interface Actor {
  userId: string | null;
  email: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

// --- Sequential numbering ---------------------------------------------------

/**
 * Hands out the next number in a gap-free sequence.
 *
 * The UPDATE ... RETURNING is atomic, so two operators posting payments at the
 * same instant cannot receive the same receipt number. Called inside the same
 * transaction as the operation it numbers, so a rollback gives the number back.
 */
export async function nextSequenceNumber(
  tx: Tx,
  organizationId: string,
  scope: string,
  prefix: string,
): Promise<{ number: number; formatted: string }> {
  const existing = await tx.receiptSequence.findUnique({
    where: { organizationId_scope: { organizationId, scope } },
  });

  if (!existing) {
    const created = await tx.receiptSequence.create({
      data: { organizationId, scope, prefix, lastNumber: 1 },
    });
    return { number: 1, formatted: format(created.prefix, 1) };
  }

  const updated = await tx.receiptSequence.update({
    where: { organizationId_scope: { organizationId, scope } },
    data: { lastNumber: { increment: 1 } },
  });

  return {
    number: updated.lastNumber,
    formatted: format(updated.prefix, updated.lastNumber),
  };
}

function format(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(6, "0")}`;
}

// --- Idempotency ------------------------------------------------------------

/**
 * Guards against a repeated operation (point 51).
 *
 * A double click, a form resubmit or a network retry carries the same key. The
 * first attempt records it; a later one finds it and the caller returns the
 * original result instead of posting a second payment.
 *
 * Returns the id produced by the first attempt when this key was already used.
 */
export async function findIdempotentResult(
  tx: Tx,
  organizationId: string,
  key: string | null | undefined,
): Promise<string | null> {
  if (!key) return null;
  const existing = await tx.idempotencyKey.findUnique({
    where: { organizationId_key: { organizationId, key } },
  });
  return existing?.resultId ?? null;
}

export async function recordIdempotencyKey(
  tx: Tx,
  organizationId: string,
  key: string | null | undefined,
  operation: string,
  resultId: string,
): Promise<void> {
  if (!key) return;
  await tx.idempotencyKey.create({
    data: { organizationId, key, operation, resultId },
  });
}

// --- Audit ------------------------------------------------------------------

export interface AuditInput {
  organizationId: string;
  action: AuditAction;
  entity: string;
  entityId?: string | null;
  beforeValues?: Prisma.InputJsonValue | null;
  afterValues?: Prisma.InputJsonValue | null;
  summary?: string | null;
  reason?: string | null;
  actor: Actor;
}

/**
 * Writes an audit entry (point 33).
 *
 * The actor email is denormalized so the trail stays readable after a user is
 * archived. Money inside the JSON payloads must already be serialized as decimal
 * strings; never pass a float.
 */
export async function recordAudit(tx: Tx, input: AuditInput): Promise<void> {
  await tx.auditLog.create({
    data: {
      organizationId: input.organizationId,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId ?? null,
      beforeValues: input.beforeValues ?? undefined,
      afterValues: input.afterValues ?? undefined,
      summary: input.summary ?? null,
      reason: input.reason ?? null,
      actorId: input.actor.userId,
      actorEmail: input.actor.email,
      ipAddress: input.actor.ipAddress ?? null,
      userAgent: input.actor.userAgent ?? null,
    },
  });
}

// --- Cash movements ---------------------------------------------------------

export interface CashMovementInput {
  organizationId: string;
  cashAccountId: string;
  type: CashMovementType;
  direction: CashDirection;
  amount: Money;
  financialClass: FinancialClass;
  occurredOn: CalendarDate;
  loanId?: string | null;
  clientId?: string | null;
  paymentId?: string | null;
  renewalId?: string | null;
  expenseId?: string | null;
  incomeId?: string | null;
  capitalEventId?: string | null;
  note?: string | null;
  createdById: string | null;
  /**
   * Whether this actually moves money in or out of the till. Defaults to true.
   *
   * False only for a bad-debt write-off, which belongs in the result but not in
   * the drawer: that cash left when the loan was disbursed.
   */
  affectsCash?: boolean;
}

/**
 * Posts one cash movement.
 *
 * The amount must be positive: the sign lives in `direction`, so a stray negative
 * can never silently invert a till total. The financial class is what every
 * report groups by, and it is the reason recovered capital can never be summed
 * as profit.
 */
export async function recordCashMovement(
  tx: Tx,
  input: CashMovementInput,
): Promise<{ id: string }> {
  if (!input.amount.isPositive()) {
    throw new ServiceError(
      `A cash movement must be positive; received ${input.amount.toString()} ` +
        `for ${input.type}.`,
    );
  }

  return tx.cashMovement.create({
    data: {
      organizationId: input.organizationId,
      cashAccountId: input.cashAccountId,
      type: input.type,
      direction: input.direction,
      amount: toDb(input.amount),
      financialClass: input.financialClass,
      occurredOn: toPrismaDate(input.occurredOn),
      loanId: input.loanId ?? null,
      clientId: input.clientId ?? null,
      paymentId: input.paymentId ?? null,
      renewalId: input.renewalId ?? null,
      expenseId: input.expenseId ?? null,
      incomeId: input.incomeId ?? null,
      capitalEventId: input.capitalEventId ?? null,
      note: input.note ?? null,
      createdById: input.createdById,
      affectsCash: input.affectsCash ?? true,
    },
    select: { id: true },
  });
}

/** Resolves the organization's default till. */
export async function defaultCashAccountId(
  tx: Tx,
  organizationId: string,
): Promise<string> {
  const account = await tx.cashAccount.findFirst({
    where: { organizationId, isActive: true },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { id: true },
  });

  if (!account) {
    throw new ServiceError(
      "The organization has no active cash account. Run the seed or create one " +
        "in Configuración before registering financial operations.",
    );
  }
  return account.id;
}
