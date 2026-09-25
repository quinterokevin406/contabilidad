import { Money, type MoneyInput } from "@/core/money/money";
import { toPrismaDate, type CalendarDate } from "@/core/time/calendar-date";
import { toDb } from "@/infra/db/money";

import {
  defaultCashAccountId,
  findIdempotentResult,
  recordAudit,
  recordCashMovement,
  recordIdempotencyKey,
  ServiceError,
  type Actor,
  type Tx,
} from "../shared";

/**
 * Expenses, other income, and owner capital movements (points 25, 26, 58).
 *
 * Each one writes its own domain row AND a cash movement, in the same
 * transaction. The domain row is what the operator manages (category, concept,
 * receipt); the cash movement is what every report sums. Keeping both means a
 * category can be renamed without touching the ledger, and the ledger can be
 * aggregated without joining four tables.
 */

export interface RecordExpenseInput {
  organizationId: string;
  categoryId: string;
  amount: MoneyInput;
  occurredOn: CalendarDate;
  concept: string;
  notes?: string | null;
  actor: Actor;
  idempotencyKey?: string | null;
  cashAccountId?: string | null;
}

export async function recordExpense(
  tx: Tx,
  input: RecordExpenseInput,
): Promise<{ expenseId: string }> {
  const existing = await findIdempotentResult(
    tx,
    input.organizationId,
    input.idempotencyKey,
  );
  if (existing) {
    throw new ServiceError("Este gasto ya fue registrado.");
  }

  const amount = Money.of(input.amount);
  if (!amount.isPositive()) {
    throw new ServiceError("El valor del gasto debe ser mayor a cero.");
  }

  const category = await assertCategory(
    tx,
    input.organizationId,
    input.categoryId,
    "OPERATING_EXPENSE",
  );

  const expense = await tx.expenseEntry.create({
    data: {
      organizationId: input.organizationId,
      categoryId: input.categoryId,
      amount: toDb(amount),
      occurredOn: toPrismaDate(input.occurredOn),
      concept: input.concept.trim(),
      notes: input.notes ?? null,
      createdById: input.actor.userId,
    },
    select: { id: true },
  });

  await recordCashMovement(tx, {
    organizationId: input.organizationId,
    cashAccountId:
      input.cashAccountId ??
      (await defaultCashAccountId(tx, input.organizationId)),
    type: "EXPENSE",
    direction: "OUT",
    amount,
    financialClass: "OPERATING_EXPENSE",
    occurredOn: input.occurredOn,
    expenseId: expense.id,
    note: `${category.name}: ${input.concept.trim()}`,
    createdById: input.actor.userId,
  });

  await recordAudit(tx, {
    organizationId: input.organizationId,
    action: "CREATE",
    entity: "ExpenseEntry",
    entityId: expense.id,
    afterValues: {
      amount: amount.toDatabaseString(),
      category: category.name,
      concept: input.concept.trim(),
      occurredOn: input.occurredOn,
    },
    summary: `Gasto de ${amount.toDatabaseString()} en ${category.name}`,
    actor: input.actor,
  });

  await recordIdempotencyKey(
    tx,
    input.organizationId,
    input.idempotencyKey,
    "expense.create",
    expense.id,
  );

  return { expenseId: expense.id };
}

export interface RecordIncomeInput extends Omit<RecordExpenseInput, "categoryId"> {
  categoryId: string;
}

export async function recordIncome(
  tx: Tx,
  input: RecordIncomeInput,
): Promise<{ incomeId: string }> {
  const existing = await findIdempotentResult(
    tx,
    input.organizationId,
    input.idempotencyKey,
  );
  if (existing) {
    throw new ServiceError("Este ingreso ya fue registrado.");
  }

  const amount = Money.of(input.amount);
  if (!amount.isPositive()) {
    throw new ServiceError("El valor del ingreso debe ser mayor a cero.");
  }

  const category = await assertCategory(
    tx,
    input.organizationId,
    input.categoryId,
    "OPERATING_INCOME",
  );

  const income = await tx.incomeEntry.create({
    data: {
      organizationId: input.organizationId,
      categoryId: input.categoryId,
      amount: toDb(amount),
      occurredOn: toPrismaDate(input.occurredOn),
      concept: input.concept.trim(),
      notes: input.notes ?? null,
      createdById: input.actor.userId,
    },
    select: { id: true },
  });

  await recordCashMovement(tx, {
    organizationId: input.organizationId,
    cashAccountId:
      input.cashAccountId ??
      (await defaultCashAccountId(tx, input.organizationId)),
    type: "EXTRAORDINARY_INCOME",
    direction: "IN",
    amount,
    financialClass: "OPERATING_INCOME",
    occurredOn: input.occurredOn,
    incomeId: income.id,
    note: `${category.name}: ${input.concept.trim()}`,
    createdById: input.actor.userId,
  });

  await recordAudit(tx, {
    organizationId: input.organizationId,
    action: "CREATE",
    entity: "IncomeEntry",
    entityId: income.id,
    afterValues: {
      amount: amount.toDatabaseString(),
      category: category.name,
      concept: input.concept.trim(),
      occurredOn: input.occurredOn,
    },
    summary: `Ingreso de ${amount.toDatabaseString()} en ${category.name}`,
    actor: input.actor,
  });

  await recordIdempotencyKey(
    tx,
    input.organizationId,
    input.idempotencyKey,
    "income.create",
    income.id,
  );

  return { incomeId: income.id };
}

/**
 * Guards the category classification (point 88).
 *
 * An administrator may invent any category name, but an expense must be filed
 * against an expense category and income against an income category. The
 * protected classes — PRINCIPAL, INTEREST, EQUITY_* — are produced only by the
 * loan and capital services and are never selectable here, which is what stops
 * recovered capital being reclassified as earnings by hand.
 */
async function assertCategory(
  tx: Tx,
  organizationId: string,
  categoryId: string,
  expected: "OPERATING_EXPENSE" | "OPERATING_INCOME",
): Promise<{ name: string }> {
  const category = await tx.transactionCategory.findFirst({
    where: { id: categoryId, organizationId, archivedAt: null },
    select: { name: true, financialClass: true, isSystem: true },
  });

  if (!category) {
    throw new ServiceError("La categoría no existe o está archivada.");
  }
  if (category.isSystem) {
    throw new ServiceError(
      `"${category.name}" es una categoría del sistema y se alimenta sola desde ` +
        "los préstamos. No se pueden registrar movimientos manuales en ella.",
    );
  }
  if (category.financialClass !== expected) {
    throw new ServiceError(
      `"${category.name}" no es una categoría de ${
        expected === "OPERATING_EXPENSE" ? "gasto" : "ingreso"
      }.`,
    );
  }

  return { name: category.name };
}

// --- Owner capital ----------------------------------------------------------

export interface RecordCapitalEventInput {
  organizationId: string;
  kind: "CONTRIBUTION" | "WITHDRAWAL";
  amount: MoneyInput;
  occurredOn: CalendarDate;
  concept?: string | null;
  notes?: string | null;
  actor: Actor;
  idempotencyKey?: string | null;
  cashAccountId?: string | null;
}

/**
 * Records owner money entering or leaving the business (point 58).
 *
 * Classified as EQUITY, never as income or expense. An owner injecting capital
 * has not earned anything, and an owner drawing money has not incurred a cost —
 * treating either as operating performance is how a growth chart starts lying.
 */
export async function recordCapitalEvent(
  tx: Tx,
  input: RecordCapitalEventInput,
): Promise<{ capitalEventId: string }> {
  const existing = await findIdempotentResult(
    tx,
    input.organizationId,
    input.idempotencyKey,
  );
  if (existing) {
    throw new ServiceError("Este movimiento de capital ya fue registrado.");
  }

  const amount = Money.of(input.amount);
  if (!amount.isPositive()) {
    throw new ServiceError("El valor debe ser mayor a cero.");
  }

  const event = await tx.capitalEvent.create({
    data: {
      organizationId: input.organizationId,
      kind: input.kind,
      amount: toDb(amount),
      occurredOn: toPrismaDate(input.occurredOn),
      concept: input.concept ?? null,
      notes: input.notes ?? null,
      createdById: input.actor.userId,
    },
    select: { id: true },
  });

  const isContribution = input.kind === "CONTRIBUTION";

  await recordCashMovement(tx, {
    organizationId: input.organizationId,
    cashAccountId:
      input.cashAccountId ??
      (await defaultCashAccountId(tx, input.organizationId)),
    type: isContribution ? "CAPITAL_CONTRIBUTION" : "OWNER_WITHDRAWAL",
    direction: isContribution ? "IN" : "OUT",
    amount,
    financialClass: isContribution
      ? "EQUITY_CONTRIBUTION"
      : "EQUITY_WITHDRAWAL",
    occurredOn: input.occurredOn,
    capitalEventId: event.id,
    note: input.concept ?? (isContribution ? "Aporte del propietario" : "Retiro del propietario"),
    createdById: input.actor.userId,
  });

  await recordAudit(tx, {
    organizationId: input.organizationId,
    action: "CREATE",
    entity: "CapitalEvent",
    entityId: event.id,
    afterValues: {
      kind: input.kind,
      amount: amount.toDatabaseString(),
      occurredOn: input.occurredOn,
    },
    summary: `${isContribution ? "Aporte" : "Retiro"} de ${amount.toDatabaseString()}`,
    actor: input.actor,
  });

  await recordIdempotencyKey(
    tx,
    input.organizationId,
    input.idempotencyKey,
    "capital.create",
    event.id,
  );

  return { capitalEventId: event.id };
}

// --- Till adjustment --------------------------------------------------------

export interface RecordAdjustmentInput {
  organizationId: string;
  cashAccountId: string;
  /** Positive when the till holds MORE than the ledger says. */
  difference: MoneyInput;
  occurredOn: CalendarDate;
  reason: string;
  actor: Actor;
}

/**
 * Brings the ledger in line with a counted till (point 25, type AJUSTE).
 *
 * Deliberately NOT automatic. A closure records its difference as a permanent
 * fact; correcting the ledger is a separate, explicit decision with a stated
 * reason, because "the drawer is short" and "we agree the drawer is right" are
 * not the same statement.
 *
 * A shortfall is classified as an operating expense and a surplus as other
 * income — the same treatment the owner chose for bad debt: a loss the business
 * really took belongs in the result.
 */
export async function recordTillAdjustment(
  tx: Tx,
  input: RecordAdjustmentInput,
): Promise<{ movementId: string }> {
  const difference = Money.of(input.difference);

  if (difference.isZero()) {
    throw new ServiceError("No hay diferencia que ajustar.");
  }
  if (input.reason.trim().length < 5) {
    throw new ServiceError("Un ajuste de caja necesita un motivo escrito.");
  }

  const isSurplus = difference.isPositive();

  const movement = await recordCashMovement(tx, {
    organizationId: input.organizationId,
    cashAccountId: input.cashAccountId,
    type: "ADJUSTMENT",
    direction: isSurplus ? "IN" : "OUT",
    amount: difference.abs(),
    financialClass: isSurplus ? "OPERATING_INCOME" : "OPERATING_EXPENSE",
    occurredOn: input.occurredOn,
    note: `Ajuste de caja (${isSurplus ? "sobrante" : "faltante"}): ${input.reason.trim()}`,
    createdById: input.actor.userId,
  });

  await recordAudit(tx, {
    organizationId: input.organizationId,
    action: "CREATE",
    entity: "CashMovement",
    entityId: movement.id,
    afterValues: {
      type: "ADJUSTMENT",
      difference: difference.toDatabaseString(),
      occurredOn: input.occurredOn,
    },
    reason: input.reason.trim(),
    summary: `Ajuste de caja por ${difference.toDatabaseString()}`,
    actor: input.actor,
  });

  return { movementId: movement.id };
}
