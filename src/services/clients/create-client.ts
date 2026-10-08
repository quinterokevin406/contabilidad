import { nextSequenceNumber, recordAudit, type Actor, type Tx } from "@/services/shared";

/**
 * Registering a client.
 *
 * The first thing anyone does with this system, and the record every loan,
 * payment and receipt will hang off for years. So the name is the only thing
 * demanded: a lender writing down a neighbour at the counter has a name and a
 * phone, not a filled form, and a system that refuses the entry is a system
 * they write around on paper.
 *
 * The document number is checked for duplicates when given, because two rows
 * for the same person is how a balance ends up split in half and neither half
 * looks wrong.
 */

export class ClientError extends Error {}

export interface CreateClientInput {
  organizationId: string;
  fullName: string;
  documentType?: string | null;
  documentNumber?: string | null;
  phone?: string | null;
  whatsappPhone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  referenceName?: string | null;
  referencePhone?: string | null;
  notes?: string | null;
  actor: Actor;
}

export interface CreateClientResult {
  clientId: string;
  code: string;
  fullName: string;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function createClient(
  tx: Tx,
  input: CreateClientInput,
): Promise<CreateClientResult> {
  const fullName = input.fullName.trim();

  if (fullName.length < 3) {
    throw new ClientError("Escribí el nombre completo del cliente.");
  }

  const documentNumber = clean(input.documentNumber);

  if (documentNumber) {
    const existing = await tx.client.findFirst({
      where: { organizationId: input.organizationId, documentNumber },
      select: { code: true, fullName: true, archivedAt: true },
    });

    if (existing) {
      throw new ClientError(
        `Ese documento ya está registrado a nombre de ${existing.fullName} ` +
          `(${existing.code})` +
          (existing.archivedAt ? ", que está archivado." : ".") +
          " Dos fichas de la misma persona parten su saldo en dos y ninguna " +
          "de las mitades se ve mal.",
      );
    }
  }

  // Gap-free and sequential, like the receipts: "CL-000012" has to mean the
  // twelfth client, not an opaque identifier.
  const { formatted: code } = await nextSequenceNumber(
    tx,
    input.organizationId,
    "CLIENT",
    "CL",
  );

  const client = await tx.client.create({
    data: {
      organizationId: input.organizationId,
      code,
      fullName,
      documentType: clean(input.documentType),
      documentNumber,
      phone: clean(input.phone),
      whatsappPhone: clean(input.whatsappPhone) ?? clean(input.phone),
      email: clean(input.email),
      address: clean(input.address),
      city: clean(input.city),
      referenceName: clean(input.referenceName),
      referencePhone: clean(input.referencePhone),
      notes: clean(input.notes),
      status: "ACTIVE",
    },
    select: { id: true, code: true, fullName: true },
  });

  await recordAudit(tx, {
    organizationId: input.organizationId,
    action: "CREATE",
    entity: "Client",
    entityId: client.id,
    summary: `${client.code} ${client.fullName} registrado`,
    actor: input.actor,
    afterValues: { code: client.code, fullName: client.fullName },
  });

  return {
    clientId: client.id,
    code: client.code,
    fullName: client.fullName,
  };
}
