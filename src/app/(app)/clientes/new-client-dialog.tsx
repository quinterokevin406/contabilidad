"use client";

import { AlertCircle, CheckCircle2, Loader2, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Modal, ModalField, modalInputClass } from "@/components/ui/modal";
import {
  registerClient,
  type CreateClientActionResult,
} from "@/server/clients/actions";

const INITIAL: CreateClientActionResult = {
  ok: false,
  error: null,
  message: null,
  clientId: null,
};

/**
 * Registering a client.
 *
 * Only the name is required, and the form says so. Everything else can be
 * filled in later from the client's own page — somebody standing at the
 * counter with a person in front of them should be able to write a name and
 * get on with the loan.
 */
export function NewClientButton({
  label = "Nuevo cliente",
  size = "md",
}: {
  label?: string;
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="primary" size={size} onClick={() => setOpen(true)}>
        <UserPlus />
        {label}
      </Button>

      {open && <NewClientDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function NewClientDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [result, action, pending] = useActionState(registerClient, INITIAL);

  useEffect(() => {
    if (result.ok && result.clientId) {
      // Straight to the new client's page: the next thing anybody does after
      // registering somebody is lend them money.
      router.push(`/clientes/${result.clientId}`);
    }
  }, [result.ok, result.clientId, router]);

  return (
    <Modal title="Nuevo cliente" onClose={onClose}>
      <form action={action} className="space-y-4 px-5 py-4">
        <ModalField
          label="Nombre completo"
          htmlFor="fullName"
          hint="Lo único obligatorio. El resto lo podés completar después."
        >
          <input
            id="fullName"
            name="fullName"
            className={modalInputClass}
            placeholder="María Rodríguez Peña"
            required
            autoFocus
          />
        </ModalField>

        <div className="grid gap-4 sm:grid-cols-2">
          <ModalField label="Tipo de documento" htmlFor="documentType">
            <select
              id="documentType"
              name="documentType"
              defaultValue="CC"
              className={modalInputClass}
            >
              <option value="CC">Cédula de ciudadanía</option>
              <option value="CE">Cédula de extranjería</option>
              <option value="NIT">NIT</option>
              <option value="PAS">Pasaporte</option>
              <option value="">Sin documento</option>
            </select>
          </ModalField>

          <ModalField
            label="Número de documento"
            htmlFor="documentNumber"
            hint="Si lo cargás, el sistema evita fichas duplicadas."
          >
            <input
              id="documentNumber"
              name="documentNumber"
              inputMode="numeric"
              className={modalInputClass}
            />
          </ModalField>

          <ModalField label="Teléfono" htmlFor="phone">
            <input
              id="phone"
              name="phone"
              inputMode="tel"
              className={modalInputClass}
              placeholder="300 123 4567"
            />
          </ModalField>

          <ModalField
            label="WhatsApp"
            htmlFor="whatsappPhone"
            hint="Vacío usa el teléfono de al lado."
          >
            <input
              id="whatsappPhone"
              name="whatsappPhone"
              inputMode="tel"
              className={modalInputClass}
            />
          </ModalField>

          <ModalField label="Ciudad" htmlFor="city">
            <input id="city" name="city" className={modalInputClass} />
          </ModalField>

          <ModalField label="Dirección" htmlFor="address">
            <input id="address" name="address" className={modalInputClass} />
          </ModalField>

          <ModalField
            label="Nombre de referencia"
            htmlFor="referenceName"
            hint="Alguien que sepa dónde encontrarlo."
          >
            <input
              id="referenceName"
              name="referenceName"
              className={modalInputClass}
            />
          </ModalField>

          <ModalField label="Teléfono de la referencia" htmlFor="referencePhone">
            <input
              id="referencePhone"
              name="referencePhone"
              inputMode="tel"
              className={modalInputClass}
            />
          </ModalField>
        </div>

        <ModalField label="Observaciones" htmlFor="notes">
          <input id="notes" name="notes" className={modalInputClass} />
        </ModalField>

        {result.error && (
          <p className="flex items-start gap-2 text-sm text-danger">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            {result.error}
          </p>
        )}
        {result.ok && result.message && (
          <p className="flex items-start gap-2 text-sm text-positive">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            {result.message}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : <UserPlus />}
            Registrar cliente
          </Button>
        </div>
      </form>
    </Modal>
  );
}
