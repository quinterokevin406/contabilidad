import type { Actor, Tx } from "@/services/shared";

/**
 * Removing a client who never moved money (point 7).
 *
 * THE ONLY PLACE IN THE SYSTEM THAT DELETES A FINANCIAL ROW, and it is written
 * to be read by somebody deciding whether to trust it. `verify:no-deletion`
 * knows this file by name: a deletion anywhere else fails the build, and the
 * refusals below are asserted to still exist.
 *
 * It is for the entries everybody makes in the first hour. The moment there is
 * anything resembling a history — a payment received, a renewal, a settlement,
 * a cash movement that is not the loan's own disbursement — it refuses and says
 * that archiving is the right answer instead. Archiving hides somebody;
 * deleting erases the proof of what they owed, and those are not the same
 * decision.
 *
 * Removing a disbursement is safe here precisely because nothing was ever
 * repaid: the money goes back into the till exactly as it left, and
 * `verify:purge` checks that the cash position lands on the number it started
 * at.
 */

export class PurgeError extends Error {}

export interface PurgeClientInput {
  organizationId: string;
  clientId: string;
  actor: Actor;
}

export interface PurgeClientPreview {
  clientId: string;
  code: string;
  fullName: string;
  loans: { code: string; principal: string }[];
  periods: number;
  disbursements: number;
  /** Null when it can be removed; the reason it cannot, otherwise. */
  blockedBecause: string | null;
}

/**
 * What would go, and whether it is allowed to.
 *
 * Separate from the deletion itself so the interface can show the operator the
 * damage before they commit to it, and so the same rules decide both.
 */
export async function previewPurge(
  tx: Tx,
  input: PurgeClientInput,
): Promise<PurgeClientPreview> {
  const client = await tx.client.findFirst({
    where: { id: input.clientId, organizationId: input.organizationId },
    select: {
      id: true,
      code: true,
      fullName: true,
      _count: { select: { payments: true } },
    },
  });

  if (!client) throw new PurgeError("El cliente no existe.");

  const loans = await tx.loan.findMany({
    where: { clientId: client.id, organizationId: input.organizationId },
    select: {
      code: true,
      outstandingPrincipal: true,
      _count: { select: { periods: true, renewals: true } },
    },
  });

  const movements = await tx.cashMovement.findMany({
    where: { clientId: client.id, organizationId: input.organizationId },
    select: { type: true },
  });

  const base = {
    clientId: client.id,
    code: client.code,
    fullName: client.fullName,
    loans: loans.map((l) => ({
      code: l.code,
      principal: l.outstandingPrincipal.toString(),
    })),
    periods: loans.reduce((n, l) => n + l._count.periods, 0),
    disbursements: movements.length,
  };

  // The refusals, in the order a person would think of them.
  if (client._count.payments > 0) {
    return {
      ...base,
      blockedBecause:
        `${client.fullName} ya recibió ${client._count.payments} pago(s). ` +
        "El recibo existe, la plata entró a la caja y los reportes la cuentan: " +
        "borrarlo destruiría la prueba de algo que pasó. Archivalo.",
    };
  }

  const renewals = loans.reduce((n, l) => n + l._count.renewals, 0);
  if (renewals > 0) {
    return {
      ...base,
      blockedBecause: `Tiene ${renewals} renovación(es). Eso no es una prueba. Archivalo.`,
    };
  }

  const settlements = await tx.settlement.count({
    where: { loan: { clientId: client.id } },
  });
  if (settlements > 0) {
    return {
      ...base,
      blockedBecause: `Tiene ${settlements} liquidación(es). Archivalo.`,
    };
  }

  const unexpected = movements.filter((m) => m.type !== "LOAN_DISBURSEMENT");
  if (unexpected.length > 0) {
    const kinds = [...new Set(unexpected.map((m) => m.type))].join(", ");
    return {
      ...base,
      blockedBecause:
        `Tiene movimientos de caja que no son desembolsos (${kinds}). ` +
        "Archivalo en vez de borrarlo.",
    };
  }

  return { ...base, blockedBecause: null };
}

export interface PurgeClientResult {
  code: string;
  fullName: string;
  loansRemoved: number;
  periodsRemoved: number;
  disbursementsRemoved: number;
}

export async function purgeClient(
  tx: Tx,
  input: PurgeClientInput,
): Promise<PurgeClientResult> {
  // The same rules decide here, not a looser copy of them. Checking again
  // inside the transaction also closes the gap between what the operator was
  // shown and what is about to happen.
  const preview = await previewPurge(tx, input);

  if (preview.blockedBecause) throw new PurgeError(preview.blockedBecause);

  const loans = await tx.loan.findMany({
    where: { clientId: preview.clientId, organizationId: input.organizationId },
    select: { id: true },
  });
  const loanIds = loans.map((l) => l.id);

  if (loanIds.length > 0) {
    await tx.cashMovement.deleteMany({ where: { loanId: { in: loanIds } } });
    await tx.loanPeriod.deleteMany({ where: { loanId: { in: loanIds } } });
    await tx.loan.deleteMany({ where: { id: { in: loanIds } } });
  }
  await tx.cashMovement.deleteMany({ where: { clientId: preview.clientId } });
  await tx.clientTagLink.deleteMany({ where: { clientId: preview.clientId } });
  await tx.client.delete({ where: { id: preview.clientId } });

  // The client is gone; the note that they were removed is not. Somebody
  // reading the history in a year should find out what happened to CL-000003
  // rather than wonder why the numbering skips one.
  await tx.auditLog.create({
    data: {
      organizationId: input.organizationId,
      action: "ARCHIVE",
      entity: "Client",
      entityId: preview.clientId,
      summary: `${preview.code} ${preview.fullName} eliminado (dato de prueba)`,
      reason:
        `Sin pagos recibidos. Se borraron ${preview.loans.length} préstamo(s), ` +
        `${preview.periods} período(s) y ${preview.disbursements} desembolso(s).`,
      actorId: input.actor.userId,
      actorEmail: input.actor.email,
      beforeValues: {
        code: preview.code,
        fullName: preview.fullName,
        loans: preview.loans.map((l) => l.code),
      },
    },
  });

  return {
    code: preview.code,
    fullName: preview.fullName,
    loansRemoved: preview.loans.length,
    periodsRemoved: preview.periods,
    disbursementsRemoved: preview.disbursements,
  };
}
