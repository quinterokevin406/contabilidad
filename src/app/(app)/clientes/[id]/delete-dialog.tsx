"use client";

import { AlertCircle, CheckCircle2, Loader2, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Modal, ModalField, modalInputClass } from "@/components/ui/modal";
import {
  checkClientRemovable,
  removeClient,
  type ClientActionResult,
  type PurgePreviewResult,
} from "@/server/clients/actions";

const INITIAL: ClientActionResult = { ok: false, error: null, message: null };

/**
 * Deleting a client.
 *
 * Deliberately the quietest control on the page, and the only one that asks
 * the operator to type something. It shows exactly what would disappear before
 * it asks, and it refuses outright once there is a payment — a client who has
 * paid is evidence, not clutter.
 */
export function DeleteClientButton({
  clientId,
  clientCode,
}: {
  clientId: string;
  clientCode: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        title="Eliminar"
      >
        <Trash2 />
      </Button>

      {open && (
        <DeleteDialog
          clientId={clientId}
          clientCode={clientCode}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function DeleteDialog({
  clientId,
  clientCode,
  onClose,
}: {
  clientId: string;
  clientCode: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [preview, setPreview] = useState<PurgePreviewResult | null>(null);
  const [result, action, pending] = useActionState(removeClient, INITIAL);

  useEffect(() => {
    let alive = true;
    checkClientRemovable(clientId).then((p) => {
      if (alive) setPreview(p);
    });
    return () => {
      alive = false;
    };
  }, [clientId]);

  useEffect(() => {
    if (result.ok) router.push("/clientes");
  }, [result.ok, router]);

  if (!preview) {
    return (
      <Modal title="Eliminar cliente" onClose={onClose}>
        <div className="flex items-center gap-2 px-5 py-8 text-sm text-ink-muted">
          <Loader2 className="size-4 animate-spin" />
          Revisando qué tiene registrado…
        </div>
      </Modal>
    );
  }

  if (!preview.ok || preview.blockedBecause) {
    return (
      <Modal
        title="No se puede eliminar"
        onClose={onClose}
        footer={
          <Button variant="primary" onClick={onClose}>
            Entendido
          </Button>
        }
      >
        <div className="space-y-3 px-5 py-4">
          <p className="flex items-start gap-2 text-sm text-ink">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-warning" />
            {preview.blockedBecause ?? preview.error}
          </p>
          <p className="text-xs text-ink-muted">
            Archivarlo lo saca de las listas del día a día y conserva todo su
            historial. Es el botón de al lado.
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Eliminar cliente" onClose={onClose}>
      <form action={action} className="space-y-4 px-5 py-4">
        <input type="hidden" name="clientId" value={clientId} />

        <p className="text-sm text-ink">
          Vas a borrar a <strong>{preview.fullName}</strong> ({preview.code}) y
          todo lo que tiene registrado.
        </p>

        <div className="rounded-[var(--radius-control)] border border-danger/30 bg-danger-soft/20 px-3 py-2.5 text-xs text-ink-muted">
          <p className="font-medium text-ink">Se borra para siempre:</p>
          <ul className="mt-1.5 space-y-0.5">
            <li>· La ficha del cliente</li>
            {preview.loans.length > 0 && (
              <li>
                · {preview.loans.length} préstamo(s): {preview.loans.join(", ")}
              </li>
            )}
            {preview.periods > 0 && <li>· {preview.periods} período(s)</li>}
            {preview.disbursements > 0 && (
              <li>
                · {preview.disbursements} desembolso(s) — esa plata vuelve a tu
                caja
              </li>
            )}
          </ul>
          <p className="mt-2">
            <strong className="text-ink">Esto no se puede deshacer.</strong> Se
            permite solo porque este cliente nunca te pagó nada: no hay ningún
            recibo que destruir.
          </p>
        </div>

        <ModalField
          label={`Escribí ${preview.code} para confirmar`}
          htmlFor="confirmation"
          hint="A propósito: es la única acción del sistema sin vuelta atrás."
        >
          <input
            id="confirmation"
            name="confirmation"
            className={modalInputClass}
            placeholder={clientCode}
            autoComplete="off"
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

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="danger" disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : <Trash2 />}
            Eliminar definitivamente
          </Button>
        </div>
      </form>
    </Modal>
  );
}
