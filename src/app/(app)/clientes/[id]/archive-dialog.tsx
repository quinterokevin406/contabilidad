"use client";

import { AlertCircle, Archive, CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Modal, ModalField, modalInputClass } from "@/components/ui/modal";
import {
  setClientArchived,
  type ClientActionResult,
} from "@/server/clients/actions";

const INITIAL: ClientActionResult = { ok: false, error: null, message: null };

export function ArchiveClientButton({
  clientId,
  clientName,
  archived,
}: {
  clientId: string;
  clientName: string;
  archived: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {archived ? <RotateCcw /> : <Archive />}
        {archived ? "Reactivar" : "Archivar"}
      </Button>

      {open && (
        <ArchiveDialog
          clientId={clientId}
          clientName={clientName}
          archived={archived}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ArchiveDialog({
  clientId,
  clientName,
  archived,
  onClose,
}: {
  clientId: string;
  clientName: string;
  archived: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [result, action, pending] = useActionState(setClientArchived, INITIAL);

  useEffect(() => {
    if (result.ok) {
      router.refresh();
      const timer = setTimeout(onClose, 2200);
      return () => clearTimeout(timer);
    }
  }, [result.ok, router, onClose]);

  return (
    <Modal
      title={archived ? "Reactivar cliente" : "Archivar cliente"}
      onClose={onClose}
    >
      <form action={action} className="space-y-4 px-5 py-4">
        <input type="hidden" name="clientId" value={clientId} />
        <input
          type="hidden"
          name="action"
          value={archived ? "UNARCHIVE" : "ARCHIVE"}
        />

        {archived ? (
          <p className="text-sm text-ink">
            <strong>{clientName}</strong> va a volver a aparecer en las listas
            del día a día y en los cobros.
          </p>
        ) : (
          <>
            <p className="text-sm text-ink">
              <strong>{clientName}</strong> sale de las listas del día a día.
            </p>
            <div className="rounded-[var(--radius-control)] border border-info/25 bg-info-soft/20 px-3 py-2.5 text-xs text-ink-muted">
              <strong className="text-ink">No se borra nada.</strong> Sus
              préstamos, sus pagos, sus recibos y cada movimiento de caja quedan
              intactos y siguen contando en todos los reportes históricos.
              <br />
              <br />
              Su ficha se sigue pudiendo abrir, y lo podés reactivar cuando
              quieras.
              <br />
              <br />
              Si todavía tiene un préstamo activo, el sistema se va a negar:
              esconder a alguien que debe no salda la deuda.
            </div>
          </>
        )}

        <ModalField
          label="Motivo"
          htmlFor="reason"
          hint="Queda en el historial. Por ejemplo: “ya no trabaja con nosotros”."
        >
          <input
            id="reason"
            name="reason"
            className={modalInputClass}
            placeholder={archived ? "Vuelve a pedir" : "Terminó de pagar"}
            required
            autoFocus
          />
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

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="submit"
            variant={archived ? "primary" : "secondary"}
            disabled={pending}
          >
            {pending && <Loader2 className="animate-spin" />}
            {archived ? "Reactivar" : "Archivar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
