import type { Tx, Actor } from "@/services/shared";

/**
 * Suspends or reactivates a customer's access (platform operation).
 *
 * Suspension is a lock on the door, never a deletion. Every client, loan,
 * payment, period and movement stays exactly where it is, and reactivating
 * restores the business untouched. A lender who lost their records because they
 * were late on a subscription would be entitled to sue, and would be right.
 *
 * It takes effect immediately rather than at token expiry: the data access
 * layer re-reads the organization's status from the database on every request.
 */

export type OrganizationAccess = "ACTIVE" | "SUSPENDED";

export interface SetOrganizationStatusInput {
  organizationId: string;
  status: OrganizationAccess;
  /** Mandatory, and recorded where the customer can read it. */
  reason: string;
  actor: Actor;
}

export interface SetOrganizationStatusResult {
  organizationId: string;
  organizationName: string;
  previousStatus: OrganizationAccess;
  status: OrganizationAccess;
}

export class PlatformError extends Error {}

export async function setOrganizationStatus(
  tx: Tx,
  input: SetOrganizationStatusInput,
): Promise<SetOrganizationStatusResult> {
  if (input.reason.trim().length < 5) {
    throw new PlatformError(
      "Escribí el motivo: queda en el historial del cliente.",
    );
  }

  const organization = await tx.organization.findUnique({
    where: { id: input.organizationId },
    select: { id: true, name: true, status: true },
  });

  if (!organization) {
    throw new PlatformError("La organización no existe.");
  }

  if (organization.status === input.status) {
    throw new PlatformError(
      `"${organization.name}" ya está ${
        input.status === "ACTIVE" ? "activa" : "suspendida"
      }.`,
    );
  }

  await tx.organization.update({
    where: { id: organization.id },
    data: { status: input.status },
  });

  // Recorded in the customer's OWN history rather than a private log. Being cut
  // off is something they are entitled to see, with the stated reason, and to
  // argue about.
  await tx.auditLog.create({
    data: {
      organizationId: organization.id,
      action: "SETTINGS_CHANGE",
      entity: "Organization",
      entityId: organization.id,
      beforeValues: { status: organization.status },
      afterValues: { status: input.status },
      summary:
        input.status === "SUSPENDED"
          ? `Acceso suspendido para ${organization.name}`
          : `Acceso reactivado para ${organization.name}`,
      reason: input.reason.trim(),
      actorId: input.actor.userId,
      actorEmail: input.actor.email,
    },
  });

  return {
    organizationId: organization.id,
    organizationName: organization.name,
    previousStatus: organization.status,
    status: input.status,
  };
}
