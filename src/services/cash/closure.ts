import { projectCashPosition, reconcileClosure, type LedgerEntry } from "@/core/cash/ledger";
import { Money, type MoneyInput } from "@/core/money/money";
import {
  fromPrismaDate,
  toPrismaDate,
  type CalendarDate,
} from "@/core/time/calendar-date";
import { fromDb, toDb } from "@/infra/db/money";

import {
  recordAudit,
  ServiceError,
  type Actor,
  type Tx,
} from "../shared";

/**
 * Daily cash closure (point 28).
 *
 * The expected balance is always derived from the LEDGER: the account's opening
 * balance plus every cash movement up to and including the closing date. It is
 * deliberately NOT carried from the previous closure's counted figure, because
 * that would quietly absorb yesterday's discrepancy and the books would drift
 * from the movements that produced them.
 *
 * A difference is recorded as a permanent fact. Correcting the ledger to match
 * the drawer is a separate, explicit decision (`recordTillAdjustment`).
 */

export interface ClosurePreview {
  cashAccountId: string;
  cashAccountName: string;
  closureDate: CalendarDate;
  openingBalance: Money;
  totalIn: Money;
  totalOut: Money;
  expectedBalance: Money;
  movementCount: number;
  /** Set when this date has already been closed. */
  existingClosure: {
    countedBalance: Money;
    difference: Money;
    closedAt: Date;
  } | null;
}

/** Computes what the till should hold at the end of a day. Writes nothing. */
export async function previewClosure(
  tx: Tx,
  organizationId: string,
  cashAccountId: string,
  closureDate: CalendarDate,
): Promise<ClosurePreview> {
  const account = await tx.cashAccount.findFirst({
    where: { id: cashAccountId, organizationId, archivedAt: null },
    select: { id: true, name: true, openingBalance: true, openedOn: true },
  });

  if (!account) {
    throw new ServiceError("La caja no existe.");
  }

  const movements = await tx.cashMovement.findMany({
    where: {
      organizationId,
      cashAccountId,
      reversedAt: null,
      occurredOn: { lte: toPrismaDate(closureDate) },
    },
    select: { direction: true, amount: true, financialClass: true, affectsCash: true },
  });

  const entries: LedgerEntry[] = movements.map((m) => ({
    direction: m.direction,
    amount: fromDb(m.amount),
    financialClass: m.financialClass,
    affectsCash: m.affectsCash,
  }));

  const position = projectCashPosition(fromDb(account.openingBalance), entries);

  const existing = await tx.cashClosure.findUnique({
    where: {
      cashAccountId_closureDate: {
        cashAccountId,
        closureDate: toPrismaDate(closureDate),
      },
    },
    select: { countedBalance: true, difference: true, closedAt: true },
  });

  return {
    cashAccountId: account.id,
    cashAccountName: account.name,
    closureDate,
    openingBalance: fromDb(account.openingBalance),
    totalIn: position.totalIn,
    totalOut: position.totalOut,
    expectedBalance: position.expectedBalance,
    movementCount: movements.length,
    existingClosure: existing
      ? {
          countedBalance: fromDb(existing.countedBalance),
          difference: fromDb(existing.difference),
          closedAt: existing.closedAt,
        }
      : null,
  };
}

export interface PerformClosureInput {
  organizationId: string;
  cashAccountId: string;
  closureDate: CalendarDate;
  /** What the operator actually counted. */
  countedBalance: MoneyInput;
  notes?: string | null;
  actor: Actor;
}

export interface ClosureResult {
  closureId: string;
  expectedBalance: Money;
  countedBalance: Money;
  difference: Money;
  summary: string;
}

/**
 * Records a daily closure permanently.
 *
 * Refuses to close a date that already has a closure, and refuses to close a
 * date earlier than one already closed: reopening the past silently is how an
 * audit trail stops being one. Point 28 requires elevated permission and an
 * audit trail to change a past closure, so this service simply will not.
 */
export async function performClosure(
  tx: Tx,
  input: PerformClosureInput,
): Promise<ClosureResult> {
  const preview = await previewClosure(
    tx,
    input.organizationId,
    input.cashAccountId,
    input.closureDate,
  );

  if (preview.existingClosure) {
    throw new ServiceError(
      `El ${input.closureDate} ya tiene un cierre registrado. ` +
        "Los cierres anteriores no se modifican desde acá.",
    );
  }

  const later = await tx.cashClosure.findFirst({
    where: {
      cashAccountId: input.cashAccountId,
      closureDate: { gt: toPrismaDate(input.closureDate) },
    },
    orderBy: { closureDate: "asc" },
    select: { closureDate: true },
  });

  if (later) {
    throw new ServiceError(
      `No se puede cerrar el ${input.closureDate} porque ya existe un cierre ` +
        `posterior (${fromPrismaDate(later.closureDate)}). Los cierres van en orden.`,
    );
  }

  const reconciliation = reconcileClosure(
    preview.expectedBalance,
    input.countedBalance,
  );

  const closure = await tx.cashClosure.create({
    data: {
      organizationId: input.organizationId,
      cashAccountId: input.cashAccountId,
      closureDate: toPrismaDate(input.closureDate),
      openingBalance: toDb(preview.openingBalance),
      totalIn: toDb(preview.totalIn),
      totalOut: toDb(preview.totalOut),
      expectedBalance: toDb(preview.expectedBalance),
      countedBalance: toDb(reconciliation.countedBalance),
      difference: toDb(reconciliation.difference),
      notes: input.notes ?? null,
      closedById: input.actor.userId,
    },
    select: { id: true },
  });

  await recordAudit(tx, {
    organizationId: input.organizationId,
    action: "CREATE",
    entity: "CashClosure",
    entityId: closure.id,
    afterValues: {
      closureDate: input.closureDate,
      expectedBalance: preview.expectedBalance.toDatabaseString(),
      countedBalance: reconciliation.countedBalance.toDatabaseString(),
      difference: reconciliation.difference.toDatabaseString(),
    },
    summary: `Cierre de caja del ${input.closureDate}: ${reconciliation.summary}`,
    actor: input.actor,
  });

  return {
    closureId: closure.id,
    expectedBalance: preview.expectedBalance,
    countedBalance: reconciliation.countedBalance,
    difference: reconciliation.difference,
    summary: reconciliation.summary,
  };
}

/** Current till position, for the cash screen header. */
export async function currentCashPosition(
  tx: Tx,
  organizationId: string,
  cashAccountId: string,
  asOf: CalendarDate,
): Promise<{
  balance: Money;
  todayIn: Money;
  todayOut: Money;
  lastClosure: { date: CalendarDate; difference: Money } | null;
  pendingSince: CalendarDate | null;
}> {
  const preview = await previewClosure(
    tx,
    organizationId,
    cashAccountId,
    asOf,
  );

  const todayMovements = await tx.cashMovement.findMany({
    where: {
      organizationId,
      cashAccountId,
      reversedAt: null,
      occurredOn: toPrismaDate(asOf),
    },
    select: { direction: true, amount: true, financialClass: true, affectsCash: true },
  });

  const todayPosition = projectCashPosition(
    Money.zero(),
    todayMovements.map((m) => ({
      direction: m.direction,
      amount: fromDb(m.amount),
      financialClass: m.financialClass,
      affectsCash: m.affectsCash,
    })),
  );

  const lastClosure = await tx.cashClosure.findFirst({
    where: { cashAccountId },
    orderBy: { closureDate: "desc" },
    select: { closureDate: true, difference: true },
  });

  // The oldest day with movements that has not been closed yet.
  const oldestUnclosed = await tx.cashMovement.findFirst({
    where: {
      organizationId,
      cashAccountId,
      reversedAt: null,
      ...(lastClosure
        ? { occurredOn: { gt: lastClosure.closureDate } }
        : {}),
    },
    orderBy: { occurredOn: "asc" },
    select: { occurredOn: true },
  });

  return {
    balance: preview.expectedBalance,
    todayIn: todayPosition.totalIn,
    todayOut: todayPosition.totalOut,
    lastClosure: lastClosure
      ? {
          date: fromPrismaDate(lastClosure.closureDate),
          difference: fromDb(lastClosure.difference),
        }
      : null,
    pendingSince: oldestUnclosed
      ? fromPrismaDate(oldestUnclosed.occurredOn)
      : null,
  };
}
