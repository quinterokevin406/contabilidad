import { Money } from "@/core/money/money";
import { fromDb } from "@/infra/db/money";
import { recordAudit, type Actor, type Tx } from "@/services/shared";

/**
 * Archiving a client (point 7).
 *
 * This is the only "delete" the system has, and it deletes nothing. The client,
 * their loans, their payments, their receipts and every cash movement stay
 * exactly where they are and keep counting in every historical report. What
 * changes is that they stop appearing in the day-to-day lists — which is the
 * actual problem being solved, because a list of eighty names where fifty are
 * people you will never see again is a list nobody reads.
 *
 * It refuses while the client still owes money. Hiding a debtor from the list
 * is not tidying up, it is losing a debt: the balance would keep counting in
 * the portfolio totals while the person who owes it is nowhere to be found.
 */

export class ArchiveError extends Error {}

export interface ArchiveClientInput {
  organizationId: string;
  clientId: string;
  /** Mandatory. It is written into the audit trail. */
  reason: string;
  actor: Actor;
}

export interface ArchiveClientResult {
  clientId: string;
  clientName: string;
  archived: boolean;
  /** Loans left behind, all of them settled. */
  loansKept: number;
  paymentsKept: number;
}

export async function archiveClient(
  tx: Tx,
  input: ArchiveClientInput,
): Promise<ArchiveClientResult> {
  if (input.reason.trim().length < 3) {
    throw new ArchiveError("Escribí por qué lo archivás. Queda en el historial.");
  }

  const client = await tx.client.findFirst({
    where: { id: input.clientId, organizationId: input.organizationId },
    select: {
      id: true,
      code: true,
      fullName: true,
      archivedAt: true,
      _count: { select: { payments: true } },
    },
  });

  if (!client) throw new ArchiveError("El cliente no existe.");
  if (client.archivedAt) {
    throw new ArchiveError(`"${client.fullName}" ya está archivado.`);
  }

  // Anything still alive, whatever its compliance status.
  const openLoans = await tx.loan.findMany({
    where: {
      clientId: client.id,
      organizationId: input.organizationId,
      lifecycle: "ACTIVE",
      archivedAt: null,
    },
    select: { code: true, outstandingPrincipal: true },
  });

  if (openLoans.length > 0) {
    const owed = openLoans.reduce(
      (sum, loan) => sum.plus(fromDb(loan.outstandingPrincipal)),
      Money.zero(),
    );
    throw new ArchiveError(
      `"${client.fullName}" todavía tiene ${openLoans.length} ` +
        `${openLoans.length === 1 ? "préstamo activo" : "préstamos activos"} ` +
        `(${openLoans.map((l) => l.code).join(", ")}) por $${owed.toString()} de capital. ` +
        "Liquidalos o cancelalos antes de archivarlo: esconder a alguien que " +
        "debe no salda la deuda, solo la saca de la vista.",
    );
  }

  const loansKept = await tx.loan.count({
    where: { clientId: client.id, organizationId: input.organizationId },
  });

  await tx.client.update({
    where: { id: client.id },
    data: { archivedAt: new Date() },
  });

  await recordAudit(tx, {
    organizationId: input.organizationId,
    action: "ARCHIVE",
    entity: "Client",
    entityId: client.id,
    summary: `${client.code} ${client.fullName} archivado`,
    reason: input.reason.trim(),
    actor: input.actor,
    beforeValues: { archivedAt: null },
    afterValues: { archivedAt: new Date().toISOString() },
  });

  return {
    clientId: client.id,
    clientName: client.fullName,
    archived: true,
    loansKept,
    paymentsKept: client._count.payments,
  };
}

/** Brings an archived client back into the day-to-day lists. */
export async function unarchiveClient(
  tx: Tx,
  input: ArchiveClientInput,
): Promise<ArchiveClientResult> {
  if (input.reason.trim().length < 3) {
    throw new ArchiveError("Escribí por qué lo reactivás.");
  }

  const client = await tx.client.findFirst({
    where: { id: input.clientId, organizationId: input.organizationId },
    select: {
      id: true,
      code: true,
      fullName: true,
      archivedAt: true,
      _count: { select: { payments: true, loans: true } },
    },
  });

  if (!client) throw new ArchiveError("El cliente no existe.");
  if (!client.archivedAt) {
    throw new ArchiveError(`"${client.fullName}" no está archivado.`);
  }

  await tx.client.update({
    where: { id: client.id },
    data: { archivedAt: null },
  });

  await recordAudit(tx, {
    organizationId: input.organizationId,
    action: "UPDATE",
    entity: "Client",
    entityId: client.id,
    summary: `${client.code} ${client.fullName} reactivado`,
    reason: input.reason.trim(),
    actor: input.actor,
    beforeValues: { archivedAt: client.archivedAt.toISOString() },
    afterValues: { archivedAt: null },
  });

  return {
    clientId: client.id,
    clientName: client.fullName,
    archived: false,
    loansKept: client._count.loans,
    paymentsKept: client._count.payments,
  };
}
