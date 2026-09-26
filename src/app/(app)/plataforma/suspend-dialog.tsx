"use client";

import { AlertCircle, CheckCircle2, Loader2, Lock, Unlock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Modal, ModalField, modalInputClass } from "@/components/ui/modal";
import {
  setOrganizationStatus,
  type PlatformResult,
} from "@/server/platform/actions";

const INITIAL: PlatformResult = { ok: false, error: null, message: null };

export function StatusButton({
  organizationId,
  organizationName,
  suspended,
  isOwnOrganization,
}: {
  organizationId: string;
  organizationName: string;
  suspended: boolean;
  isOwnOrganization: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (isOwnOrganization && !suspended) {
    return (
      <span className="text-xs text-ink-subtle">Tu organización</span>
    );
  }

  return (
    <>
      <Button
        variant={suspended ? "primary" : "secondary"}
        size="sm"
        onClick={() => setOpen(true)}
      >
        {suspended ? <Unlock /> : <Lock />}
        {suspended ? "Reactivar" : "Suspender"}
      </Button>

      {open && (
        <StatusDialog
          organizationId={organizationId}
          organizationName={organizationName}
          suspended={suspended}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function StatusDialog({
  organizationId,
  organizationName,
  suspended,
  onClose,
}: {
  organizationId: string;
  organizationName: string;
  suspended: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [result, action, pending] = useActionState(
    setOrganizationStatus,
    INITIAL,
  );

  useEffect(() => {
    if (result.ok) {
      router.refresh();
      onClose();
    }
  }, [result.ok, router, onClose]);

  return (
    <Modal
      title={suspended ? "Reactivar acceso" : "Suspender acceso"}
      onClose={onClose}
    >
      <form action={action} className="space-y-4 px-5 py-4">
        <input type="hidden" name="organizationId" value={organizationId} />
        <input
          type="hidden"
          name="action"
          value={suspended ? "ACTIVATE" : "SUSPEND"}
        />

        <p className="text-sm text-ink">
          {suspended ? (
            <>
              <strong>{organizationName}</strong> va a poder volver a entrar. Su
              información está intacta: nunca se borró nada.
            </>
          ) : (
            <>
              Nadie de <strong>{organizationName}</strong> va a poder entrar
              hasta que lo reactives.
            </>
          )}
        </p>

        {!suspended && (
          <div className="rounded-[var(--radius-control)] border border-warning/25 bg-warning-soft/20 px-3 py-2.5 text-xs text-ink-muted">
            Sus clientes, préstamos, pagos y movimientos{" "}
            <strong className="text-ink">no se tocan</strong>. La suspensión es
            una puerta cerrada, no un borrado — el día que pague, reactivás y el
            negocio sigue exactamente donde estaba.
            <br />
            <br />
            Las sesiones abiertas se cortan en el próximo clic, no cuando venza
            el token.
          </div>
        )}

        <ModalField
          label="Motivo"
          htmlFor="reason"
          hint="Queda en el historial de ese cliente, visible para él."
        >
          <input
            id="reason"
            name="reason"
            className={modalInputClass}
            placeholder={
              suspended ? "Pago recibido" : "Mensualidad vencida hace 15 días"
            }
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
          <Button
            type="submit"
            variant={suspended ? "primary" : "danger"}
            disabled={pending}
          >
            {pending && <Loader2 className="animate-spin" />}
            {suspended ? "Reactivar" : "Suspender"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
