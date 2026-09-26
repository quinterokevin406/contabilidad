/**
 * Integration check for cash, expenses, income, capital and closures.
 *
 * Runs the real services against the real database and rolls everything back.
 * The point of interest is classification: that an expense reaches the result,
 * that an owner contribution does NOT, and that a closure derives its expected
 * balance from the ledger rather than from yesterday's count.
 */

import { computeOperatingResult, projectCashPosition } from "@/core/cash/ledger";
import { Money } from "@/core/money/money";
import { addDays, todayIn } from "@/core/time/calendar-date";
import { fromDb } from "@/infra/db/money";
import { createSystemClient } from "@/infra/db/system-client";
import { performClosure, previewClosure } from "@/services/cash/closure";
import {
  recordCapitalEvent,
  recordExpense,
  recordIncome,
  recordTillAdjustment,
} from "@/services/cash/entries";
import type { Tx } from "@/services/shared";

if (!process.env.DATABASE_URL) process.loadEnvFile(".env");

const prisma = createSystemClient();

let failures = 0;

function check(label: string, pass: boolean, detail = "") {
  if (!pass) failures += 1;
  console.log(`  ${pass ? "OK  " : "FALLA"} ${label}${detail ? ` — ${detail}` : ""}`);
}

class Rollback<T> extends Error {
  constructor(readonly value: T) {
    super("rollback");
  }
}

async function rolledBack<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma
    .$transaction(
      async (tx) => {
        throw new Rollback(await fn(tx));
      },
      { timeout: 60_000 },
    )
    .catch((error: unknown) => {
      if (error instanceof Rollback) return error.value as T;
      throw error;
    });
}

async function main() {
  const org = await prisma.organization.findFirstOrThrow({ select: { id: true } });
  const admin = await prisma.user.findFirstOrThrow({
    where: { organizationId: org.id },
    select: { id: true, email: true },
  });
  const actor = { userId: admin.id, email: admin.email };
  const account = await prisma.cashAccount.findFirstOrThrow({
    where: { organizationId: org.id },
    select: { id: true },
  });
  const today = todayIn("America/Bogota");

  const expenseCategory = await prisma.transactionCategory.findFirstOrThrow({
    where: {
      organizationId: org.id,
      financialClass: "OPERATING_EXPENSE",
      isSystem: false,
    },
    select: { id: true, name: true },
  });
  const incomeCategory = await prisma.transactionCategory.findFirstOrThrow({
    where: {
      organizationId: org.id,
      financialClass: "OPERATING_INCOME",
      isSystem: false,
    },
    select: { id: true },
  });
  const systemCategory = await prisma.transactionCategory.findFirst({
    where: { organizationId: org.id, isSystem: true },
    select: { id: true, name: true },
  });

  console.log("\nGasto operativo:\n");

  await rolledBack(async (tx) => {
    const { expenseId } = await recordExpense(tx, {
      organizationId: org.id,
      categoryId: expenseCategory.id,
      amount: "150000",
      occurredOn: today,
      concept: "Transporte de prueba",
      actor,
    });

    const entry = await tx.expenseEntry.findUniqueOrThrow({
      where: { id: expenseId },
      select: { amount: true, concept: true },
    });
    check("se creó el registro de gasto", fromDb(entry.amount).equals("150000"));

    const movement = await tx.cashMovement.findFirstOrThrow({
      where: { expenseId },
      select: { financialClass: true, direction: true, affectsCash: true },
    });
    check(
      "el movimiento es gasto operativo saliente",
      movement.financialClass === "OPERATING_EXPENSE" &&
        movement.direction === "OUT",
    );
    check("un gasto SÍ mueve la caja", movement.affectsCash === true);

    const audit = await tx.auditLog.findFirst({
      where: { entity: "ExpenseEntry", entityId: expenseId },
      select: { action: true },
    });
    check("quedó auditado", audit?.action === "CREATE");

    return null;
  });

  console.log("\nCategoría del sistema:\n");

  if (systemCategory) {
    await rolledBack(async (tx) => {
      let rejected = false;
      try {
        await recordExpense(tx, {
          organizationId: org.id,
          categoryId: systemCategory.id,
          amount: "100000",
          occurredOn: today,
          concept: "Intento manual",
          actor,
        });
      } catch {
        rejected = true;
      }
      check(
        `no se puede registrar manualmente en "${systemCategory.name}"`,
        rejected,
      );
      return null;
    });

    await rolledBack(async (tx) => {
      let rejected = false;
      try {
        await recordIncome(tx, {
          organizationId: org.id,
          categoryId: expenseCategory.id,
          amount: "100000",
          occurredOn: today,
          concept: "Categoría equivocada",
          actor,
        });
      } catch {
        rejected = true;
      }
      check("un ingreso no puede usar una categoría de gasto", rejected);
      return null;
    });
  }

  console.log("\nAporte del propietario:\n");

  await rolledBack(async (tx) => {
    const before = await snapshotResult(tx, org.id);

    const { capitalEventId } = await recordCapitalEvent(tx, {
      organizationId: org.id,
      kind: "CONTRIBUTION",
      amount: "10000000",
      occurredOn: today,
      concept: "Aporte de prueba",
      actor,
    });

    const movement = await tx.cashMovement.findFirstOrThrow({
      where: { capitalEventId },
      select: { financialClass: true, direction: true },
    });
    check(
      "el aporte es clase patrimonio, no ingreso",
      movement.financialClass === "EQUITY_CONTRIBUTION" &&
        movement.direction === "IN",
      movement.financialClass,
    );

    const after = await snapshotResult(tx, org.id);
    check(
      "la utilidad NO cambió con el aporte",
      after.netProfit.equals(before.netProfit),
      `${before.netProfit.toDatabaseString()} → ${after.netProfit.toDatabaseString()}`,
    );
    check(
      "la caja SÍ subió 10.000.000",
      after.cash.minus(before.cash).equals("10000000"),
      after.cash.minus(before.cash).toDatabaseString(),
    );

    return null;
  });

  console.log("\nIngreso operativo (contraste):\n");

  await rolledBack(async (tx) => {
    const before = await snapshotResult(tx, org.id);

    await recordIncome(tx, {
      organizationId: org.id,
      categoryId: incomeCategory.id,
      amount: "500000",
      occurredOn: today,
      concept: "Ingreso de prueba",
      actor,
    });

    const after = await snapshotResult(tx, org.id);
    check(
      "un ingreso operativo SÍ sube la utilidad",
      after.netProfit.minus(before.netProfit).equals("500000"),
      after.netProfit.minus(before.netProfit).toDatabaseString(),
    );

    return null;
  });

  console.log("\nCierre de caja:\n");

  await rolledBack(async (tx) => {
    const preview = await previewClosure(tx, org.id, account.id, today);
    const ledger = await snapshotResult(tx, org.id);

    check(
      "el saldo esperado viene del libro mayor",
      preview.expectedBalance.equals(ledger.cash),
      `${preview.expectedBalance.toDatabaseString()} vs ${ledger.cash.toDatabaseString()}`,
    );

    // Count 350.000 short.
    const counted = preview.expectedBalance.minus("350000");

    const result = await performClosure(tx, {
      organizationId: org.id,
      cashAccountId: account.id,
      closureDate: today,
      countedBalance: counted,
      actor,
    });

    check(
      "la diferencia quedó registrada como faltante",
      result.difference.equals("-350000"),
      result.difference.toDatabaseString(),
    );
    check("el resumen lo dice en palabras", result.summary.includes("Faltan"));

    let duplicate = false;
    try {
      await performClosure(tx, {
        organizationId: org.id,
        cashAccountId: account.id,
        closureDate: today,
        countedBalance: counted,
        actor,
      });
    } catch {
      duplicate = true;
    }
    check("no se puede cerrar dos veces la misma fecha", duplicate);

    let outOfOrder = false;
    try {
      await performClosure(tx, {
        organizationId: org.id,
        cashAccountId: account.id,
        closureDate: addDays(today, -1),
        countedBalance: counted,
        actor,
      });
    } catch {
      outOfOrder = true;
    }
    check("no se puede cerrar una fecha anterior ya superada", outOfOrder);

    // The closure alone does NOT touch the ledger.
    const afterClosure = await snapshotResult(tx, org.id);
    check(
      "el cierre por sí solo no altera el libro mayor",
      afterClosure.cash.equals(ledger.cash),
    );

    return null;
  });

  console.log("\nAjuste de caja:\n");

  await rolledBack(async (tx) => {
    const before = await snapshotResult(tx, org.id);

    await recordTillAdjustment(tx, {
      organizationId: org.id,
      cashAccountId: account.id,
      difference: "-350000",
      occurredOn: today,
      reason: "Faltante detectado en el cierre",
      actor,
    });

    const after = await snapshotResult(tx, org.id);
    check(
      "el ajuste baja la caja del libro",
      before.cash.minus(after.cash).equals("350000"),
      before.cash.minus(after.cash).toDatabaseString(),
    );
    check(
      "el faltante baja la utilidad",
      before.netProfit.minus(after.netProfit).equals("350000"),
      before.netProfit.minus(after.netProfit).toDatabaseString(),
    );

    let noReason = false;
    try {
      await recordTillAdjustment(tx, {
        organizationId: org.id,
        cashAccountId: account.id,
        difference: "-1000",
        occurredOn: today,
        reason: "",
        actor,
      });
    } catch {
      noReason = true;
    }
    check("un ajuste sin motivo es rechazado", noReason);

    return null;
  });

  console.log("\nVerificando que no quedó nada:\n");

  const leftovers = await prisma.cashClosure.count({
    where: { organizationId: org.id },
  });
  check("no quedaron cierres de prueba", leftovers === 0, `${leftovers}`);

  console.log(
    failures === 0
      ? "\nCaja, gastos, ingresos y cierres funcionan de punta a punta.\n"
      : `\n${failures} verificaciones fallaron.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

/** Cash and profit as the core functions compute them. */
async function snapshotResult(tx: Tx, organizationId: string) {
  const movements = await tx.cashMovement.findMany({
    where: { organizationId, reversedAt: null },
    select: {
      direction: true,
      amount: true,
      financialClass: true,
      affectsCash: true,
      type: true,
    },
  });

  const entries = movements.map((m) => ({
    direction: m.direction,
    amount: fromDb(m.amount),
    financialClass: m.financialClass,
    affectsCash: m.affectsCash,
    isWriteOff: m.type === "PRINCIPAL_WRITE_OFF",
  }));

  return {
    cash: projectCashPosition(Money.zero(), entries).expectedBalance,
    netProfit: computeOperatingResult(entries).netProfit,
  };
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
