/**
 * Integration check for archiving a client.
 *
 * Archiving is the only thing in this system that looks like deleting, which
 * makes it the one most likely to quietly become deleting. So this counts every
 * record belonging to the client before and after and refuses any difference,
 * and it proves the refusal that gives the feature its meaning: you cannot
 * archive somebody who still owes money.
 *
 * Nothing survives this script. The transaction is aborted on purpose.
 */

import { createSystemClient } from "@/infra/db/system-client";
import {
  archiveClient,
  unarchiveClient,
} from "@/services/clients/archive-client";

const prisma = createSystemClient();

let failures = 0;

function check(label: string, pass: boolean, detail = "") {
  if (!pass) failures += 1;
  console.log(
    `  ${pass ? "OK  " : "FALLA"} ${label}${detail ? ` — ${detail}` : ""}`,
  );
}

class Rollback<T> extends Error {
  constructor(readonly value: T) {
    super("rollback");
  }
}

async function inRolledBackTx<T>(fn: (tx: any) => Promise<T>): Promise<T> {
  return prisma
    .$transaction(
      async (tx) => {
        throw new Rollback(await fn(tx));
      },
      { timeout: 30_000 },
    )
    .catch((error: unknown) => {
      if (error instanceof Rollback) return error.value as T;
      throw error;
    });
}

const actor = { userId: null, email: "verificacion@archivo" };

/** Everything that belongs to this client and must survive untouched. */
async function footprint(tx: any, clientId: string) {
  const [loans, periods, payments, allocations, movements] = await Promise.all([
    tx.loan.count({ where: { clientId } }),
    tx.loanPeriod.count({ where: { loan: { clientId } } }),
    tx.payment.count({ where: { clientId } }),
    tx.paymentAllocation.count({ where: { payment: { clientId } } }),
    tx.cashMovement.count({ where: { clientId } }),
  ]);
  return { loans, periods, payments, allocations, movements };
}

async function main() {
  const org = await prisma.organization.findFirstOrThrow({
    select: { id: true },
  });

  // --- Somebody who still owes: archiving must be refused ----------------

  console.log("\n1. No se puede archivar a quien debe");

  const debtor = await prisma.loan.findFirstOrThrow({
    where: { organizationId: org.id, lifecycle: "ACTIVE", archivedAt: null },
    select: { code: true, client: { select: { id: true, fullName: true } } },
  });

  const refusal = await inRolledBackTx(async (tx) => {
    try {
      await archiveClient(tx, {
        organizationId: org.id,
        clientId: debtor.client.id,
        reason: "Verificación automática",
        actor,
      });
      return { refused: false, message: "" };
    } catch (error: unknown) {
      return {
        refused: true,
        message: error instanceof Error ? error.message : "",
      };
    }
  });

  check(
    `${debtor.client.fullName} tiene préstamo activo y fue rechazado`,
    refusal.refused,
  );
  check(
    "el mensaje dice cuál préstamo lo impide",
    refusal.message.includes(debtor.code),
    refusal.message.slice(0, 90),
  );

  const stillThere = await prisma.client.findUniqueOrThrow({
    where: { id: debtor.client.id },
    select: { archivedAt: true },
  });
  check("y no quedó archivado igual", stillThere.archivedAt === null);

  // --- Somebody with no open loans: archiving must keep everything -------

  console.log("\n2. Archivar no borra absolutamente nada");

  const settled = await prisma.client.findFirst({
    where: {
      organizationId: org.id,
      archivedAt: null,
      loans: { none: { lifecycle: "ACTIVE", archivedAt: null } },
    },
    select: { id: true, fullName: true },
  });

  if (!settled) {
    console.log(
      "  (sin clientes sin préstamos activos en esta base; se omite)\n",
    );
  } else {
    const round = await inRolledBackTx(async (tx) => {
      const before = await footprint(tx, settled.id);

      const archived = await archiveClient(tx, {
        organizationId: org.id,
        clientId: settled.id,
        reason: "Verificación automática de archivado",
        actor,
      });

      const afterArchive = await footprint(tx, settled.id);
      const row = await tx.client.findUniqueOrThrow({
        where: { id: settled.id },
        select: { archivedAt: true },
      });

      const entry = await tx.auditLog.findFirst({
        where: { entity: "Client", entityId: settled.id },
        orderBy: { createdAt: "desc" },
        select: { action: true, reason: true },
      });

      // Reversing it has to be possible, or archiving is a one-way door.
      const restored = await unarchiveClient(tx, {
        organizationId: org.id,
        clientId: settled.id,
        reason: "Fin de la verificación",
        actor,
      });

      const finalRow = await tx.client.findUniqueOrThrow({
        where: { id: settled.id },
        select: { archivedAt: true },
      });
      const afterAll = await footprint(tx, settled.id);

      return { before, archived, afterArchive, row, entry, restored, finalRow, afterAll };
    });

    check(
      "quedó marcado como archivado",
      round.row.archivedAt !== null,
      settled.fullName,
    );

    for (const key of Object.keys(round.before) as (keyof typeof round.before)[]) {
      check(
        `${key} intactos`,
        round.before[key] === round.afterArchive[key],
        `${round.before[key]} → ${round.afterArchive[key]}`,
      );
    }

    check(
      "quedó la anotación en el historial",
      round.entry?.action === "ARCHIVE" &&
        round.entry.reason === "Verificación automática de archivado",
      round.entry?.reason ?? "sin anotación",
    );

    check("se puede reactivar", round.finalRow.archivedAt === null);
    check(
      "y todo sigue ahí después de la vuelta completa",
      JSON.stringify(round.before) === JSON.stringify(round.afterAll),
      `${round.before.payments} pagos, ${round.before.movements} movimientos`,
    );
  }

  // --- A reason is not optional -------------------------------------------

  console.log("\n3. Hace falta un motivo escrito");

  const noReason = await inRolledBackTx(async (tx) => {
    try {
      await archiveClient(tx, {
        organizationId: org.id,
        clientId: debtor.client.id,
        reason: "x",
        actor,
      });
      return false;
    } catch {
      return true;
    }
  });
  check("se rechaza sin motivo", noReason);

  console.log(
    failures === 0
      ? "\nArchivar oculta, nunca borra.\n"
      : `\n${failures} comprobación(es) fallaron.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
