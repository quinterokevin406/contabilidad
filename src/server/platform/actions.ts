"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { tenantTransaction } from "@/infra/db/client";
import { withSystemAccess } from "@/infra/db/tenancy";
import { requirePlatformOwner } from "@/server/auth/dal";
import { setOrganizationStatus as applyStatus } from "@/services/platform/set-organization-status";

/**
 * Suspending and reactivating a customer's access.
 *
 * The rule itself lives in the service, which is what the verification suite
 * exercises against a real database. This layer does what every other action
 * layer here does: check who is asking, parse the form, open the transaction.
 */

export interface PlatformResult {
  ok: boolean;
  error: string | null;
  message: string | null;
}

const schema = z.object({
  organizationId: z.string().min(1),
  action: z.enum(["SUSPEND", "ACTIVATE"]),
  reason: z
    .string()
    .trim()
    .min(5, "Escribí el motivo: queda en el historial del cliente."),
});

export async function setOrganizationStatus(
  _previous: PlatformResult,
  formData: FormData,
): Promise<PlatformResult> {
  try {
    const owner = await requirePlatformOwner();
    const parsed = schema.safeParse(Object.fromEntries(formData));

    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Datos inválidos.",
        message: null,
      };
    }

    const { organizationId, action, reason } = parsed.data;

    // Suspending the organization you are signed in through would log you out
    // and leave nobody able to undo it from the interface.
    if (organizationId === owner.organizationId && action === "SUSPEND") {
      return {
        ok: false,
        error:
          "No podés suspender la organización desde la que estás conectado: " +
          "quedarías afuera y sin forma de revertirlo.",
        message: null,
      };
    }

    const result = await withSystemAccess(() =>
      tenantTransaction((tx) =>
        applyStatus(tx, {
          organizationId,
          status: action === "SUSPEND" ? "SUSPENDED" : "ACTIVE",
          reason,
          actor: { userId: owner.id, email: owner.email },
        }),
      ),
    );

    revalidatePath("/plataforma");

    return {
      ok: true,
      error: null,
      message:
        result.status === "SUSPENDED"
          ? `"${result.organizationName}" quedó suspendida. Sus datos siguen intactos.`
          : `"${result.organizationName}" vuelve a tener acceso.`,
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
