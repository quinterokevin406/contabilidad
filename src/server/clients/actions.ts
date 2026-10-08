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
