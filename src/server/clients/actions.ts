"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { tenantTransaction } from "@/infra/db/client";
import { requireAdmin, requireWriteAccess } from "@/server/auth/dal";
import {
  archiveClient,
  unarchiveClient,
} from "@/services/clients/archive-client";
import { createClient } from "@/services/clients/create-client";
import {
  previewPurge,
  purgeClient,
} from "@/services/clients/purge-client";

/**
 * Archiving and reactivating a client.
 *
 * Restricted to administrators. Taking somebody out of the daily lists is not
 * destructive, but it is the kind of thing that should be traceable to a
 * person, and a collector has no reason to do it.
 */

export interface ClientActionResult {
  ok: boolean;
  error: string | null;
  message: string | null;
}

const schema = z.object({
  clientId: z.string().min(1),
  action: z.enum(["ARCHIVE", "UNARCHIVE"]),
  reason: z
    .string()
    .trim()
    .min(3, "Escribí por qué. Queda en el historial del cliente."),
});

export async function setClientArchived(
  _previous: ClientActionResult,
  formData: FormData,
): Promise<ClientActionResult> {
  try {
    const user = await requireAdmin();
    const parsed = schema.safeParse(Object.fromEntries(formData));

    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Datos inválidos.",
        message: null,
      };
    }

    const { clientId, action, reason } = parsed.data;
    const actor = { userId: user.id, email: user.email };

    const result = await tenantTransaction((tx) =>
      action === "ARCHIVE"
        ? archiveClient(tx, {
            organizationId: user.organizationId,
            clientId,
            reason,
            actor,
          })
        : unarchiveClient(tx, {
            organizationId: user.organizationId,
            clientId,
            reason,
            actor,
          }),
    );

    revalidatePath("/clientes");
    revalidatePath(`/clientes/${clientId}`);

    return {
      ok: true,
      error: null,
      message: result.archived
        ? `${result.clientName} salió de las listas del día a día. ` +
          `Sus ${result.loansKept} préstamos y ${result.paymentsKept} pagos siguen intactos.`
        : `${result.clientName} vuelve a aparecer en las listas.`,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error:
        error instanceof Error && error.message
          ? error.message
          : "Ocurrió un error y no se cambió nada.",
      message: null,
    };
  }
}

/**
 * Registering a client.
 *
 * Only the name is required. A lender writing down a neighbour at the counter
 * has a name and a phone, not a completed form, and a system that refuses that
 * entry is a system they work around on paper.
 */
const createSchema = z.object({
  fullName: z.string().trim().min(3, "Escribí el nombre completo."),
  documentType: z.string().optional(),
  documentNumber: z.string().optional(),
  phone: z.string().optional(),
  whatsappPhone: z.string().optional(),
  email: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  referenceName: z.string().optional(),
  referencePhone: z.string().optional(),
  notes: z.string().optional(),
});

export interface CreateClientActionResult extends ClientActionResult {
  clientId: string | null;
}

export async function registerClient(
  _previous: CreateClientActionResult,
  formData: FormData,
): Promise<CreateClientActionResult> {
  try {
    const user = await requireWriteAccess();
    const parsed = createSchema.safeParse(Object.fromEntries(formData));

    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Datos inválidos.",
        message: null,
        clientId: null,
      };
    }

    const result = await tenantTransaction((tx) =>
      createClient(tx, {
        organizationId: user.organizationId,
        ...parsed.data,
        actor: { userId: user.id, email: user.email },
      }),
    );

    revalidatePath("/clientes");

    return {
      ok: true,
      error: null,
      message: `${result.fullName} quedó registrado como ${result.code}.`,
      clientId: result.clientId,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error:
        error instanceof Error && error.message
          ? error.message
          : "Ocurrió un error y no se guardó nada.",
      message: null,
      clientId: null,
    };
  }
}

/**
 * Deleting a client who never moved money.
 *
 * Administrators only, and it refuses the moment there is a payment, a
 * renewal, a settlement or a cash movement that is not the loan's own
 * disbursement. The rules live in the service; this layer only asks who is
 * calling and hands back what the service decided.
 */
export interface PurgePreviewResult {
  ok: boolean;
  error: string | null;
  code: string | null;
  fullName: string | null;
  loans: string[];
  periods: number;
  disbursements: number;
  blockedBecause: string | null;
}

export async function checkClientRemovable(
  clientId: string,
): Promise<PurgePreviewResult> {
  try {
    const user = await requireAdmin();
    const preview = await tenantTransaction((tx) =>
      previewPurge(tx, {
        organizationId: user.organizationId,
        clientId,
        actor: { userId: user.id, email: user.email },
      }),
    );

    return {
      ok: true,
      error: null,
      code: preview.code,
      fullName: preview.fullName,
      loans: preview.loans.map((l) => l.code),
      periods: preview.periods,
      disbursements: preview.disbursements,
      blockedBecause: preview.blockedBecause,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error:
        error instanceof Error && error.message
          ? error.message
          : "No se pudo revisar el cliente.",
      code: null,
      fullName: null,
      loans: [],
      periods: 0,
      disbursements: 0,
      blockedBecause: null,
    };
  }
}

export async function removeClient(
  _previous: ClientActionResult,
  formData: FormData,
): Promise<ClientActionResult> {
  try {
    const user = await requireAdmin();
    const clientId = String(formData.get("clientId") ?? "");
    const confirmation = String(formData.get("confirmation") ?? "").trim();

    if (!clientId) return { ok: false, error: "Cliente no indicado.", message: null };

    // Typing the code out is the confirmation. A dialog nobody reads is not a
    // safeguard, and this is the one action in the system with no undo.
    const result = await tenantTransaction(async (tx) => {
      const preview = await previewPurge(tx, {
        organizationId: user.organizationId,
        clientId,
        actor: { userId: user.id, email: user.email },
      });

      if (confirmation.toUpperCase() !== preview.code.toUpperCase()) {
        throw new Error(
          `Escribí ${preview.code} para confirmar. Esto no se puede deshacer.`,
        );
      }

      return purgeClient(tx, {
        organizationId: user.organizationId,
        clientId,
        actor: { userId: user.id, email: user.email },
      });
    });

    revalidatePath("/clientes");
    revalidatePath("/prestamos");
    revalidatePath("/caja");

    return {
      ok: true,
      error: null,
      message:
        `${result.code} ${result.fullName} eliminado. ` +
        (result.loansRemoved > 0
          ? `Se borraron ${result.loansRemoved} préstamo(s) y la plata volvió a la caja.`
          : "No tenía préstamos."),
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error:
        error instanceof Error && error.message
          ? error.message
          : "Ocurrió un error y no se borró nada.",
      message: null,
    };
  }
}
