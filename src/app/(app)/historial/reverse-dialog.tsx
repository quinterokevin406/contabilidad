"use client";

import { AlertTriangle, CheckCircle2, Loader2, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Modal, ModalField, modalInputClass } from "@/components/ui/modal";
import { formatMoney } from "@/core/money/format";
import { formatDate } from "@/core/time/format";
import { calendarDate } from "@/core/time/calendar-date";
import {
  reversePaymentAction,
  type ReversalResult,
} from "@/server/audit/actions";

const INITIAL: ReversalResult = { ok: false, error: null, message: null };

export interface ReversiblePayment {
  id: string;
  receiptNumber: string;
  amount: string;
  paidOn: string;
  clientName: string;
  loanCode: string;
}

/**
 * Reversing a payment (point 34).
 *
 * The confirmation is deliberately blunt about what a reversal is and is not: it
 * does not erase the payment, it posts the opposite entries. Both stay in the
 * history. An operator who expects "undo" to mean "make it never have happened"
 * needs to know that before pressing the button, not after.
 */
export function ReverseDialog({ payments }: { payments: ReversiblePayment[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [paymentId, setPaymentId] = useState("");
  const [reason, setReason] = useState("");
  const [result, action, pending] = useActionState(
    reversePaymentAction,
    INITIAL,
  );

  useEffect(() => {
    if (result.ok) router.refresh();
  }, [result.ok, router]);

  const selected = payments.find((p) => p.id === paymentId);

  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        <Undo2 />
        Anular un pago
      </Button>

      {open && (
        <Modal
          title={result.ok ? "Pago anulado" : "Anular un pago"}
          subtitle={
            result.ok ? undefined : "El pago no se borra: se revierte con asientos opuestos"
          }
          onClose={() => setOpen(false)}
          busy={pending}
          footer={
            result.ok ? (
              <Button variant="primary" onClick={() => setOpen(false)}>
                Listo
              </Button>
            ) : (
              <form action={action} className="flex w-full justify-end gap-2">
                <input type="hidden" name="paymentId" value={paymentId} />
                <input type="hidden" name="reason" value={reason} />
                <Button
                  variant="ghost"
                  onClick={() => setOpen(false)}
                  disabled={pending}
                >
                  Cancelar
                </Button>
                <Button
                  type="submit"
                  variant="danger"
                  disabled={pending || !paymentId || reason.trim().length < 5}
                >
                  {pending ? (
                    <>
                      <Loader2 className="animate-spin" />
                      Anulando…
                    </>
                  ) : (
                    <>
                      <Undo2 />
                      Confirmar anulación
                    </>
                  )}
                </Button>
              </form>
            )
          }
        >
          {result.ok ? (
            <div className="px-5 py-8 text-center">
              <div className="mx-auto grid size-12 place-items-center rounded-full bg-positive-soft text-positive">
                <CheckCircle2 className="size-6" />
              </div>
              <p className="mt-4 text-sm text-ink">{result.message}</p>
            </div>
          ) : payments.length === 0 ? (
            <div className="px-5 py-8 text-center">
              <p className="text-sm text-ink">No hay pagos anulables.</p>
              <p className="mt-1 text-xs text-ink-muted">
                Los pagos que forman parte de una renovación se anulan desde la
                renovación.
              </p>
            </div>
          ) : (
            <div className="space-y-4 px-5 py-4">
              <ModalField label="Pago a anular" htmlFor="payment">
                <select
                  id="payment"
                  value={paymentId}
                  onChange={(event) => setPaymentId(event.target.value)}
                  className={modalInputClass}
                  autoFocus
                >
                  <option value="">Elegí un recibo…</option>
                  {payments.map((payment) => (
                    <option key={payment.id} value={payment.id}>
                      {payment.receiptNumber} · {payment.clientName} ·{" "}
                      {formatMoney(payment.amount)}
                    </option>
                  ))}
                </select>
              </ModalField>

              {selected && (
                <dl className="space-y-2 rounded-[var(--radius-control)] border border-line bg-canvas px-4 py-3 text-sm">
                  <Row label="Cliente" value={selected.clientName} />
                  <Row label="Préstamo" value={selected.loanCode} />
                  <Row
                    label="Fecha"
                    value={formatDate(calendarDate(selected.paidOn))}
                  />
                  <Row label="Valor" value={formatMoney(selected.amount)} bold />
                </dl>
              )}

              <ModalField
                label="Motivo"
                htmlFor="reason"
                hint="Queda registrado de forma permanente"
              >
                <input
                  id="reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Se registró por error el monto equivocado"
                  className={modalInputClass}
                />
              </ModalField>

              <div className="flex items-start gap-2.5 rounded-[var(--radius-control)] border border-danger/30 bg-danger-soft px-3.5 py-3">
                <AlertTriangle className="mt-px size-4 shrink-0 text-danger" />
                <div className="text-xs text-danger">
                  <p>
                    Anular <strong>no borra</strong> el pago.
                  </p>
                  <p className="mt-1.5 opacity-90">
                    El recibo original queda marcado como anulado y se registran
                    movimientos de caja en sentido contrario. Los intereses
                    vuelven a quedar pendientes y el capital se restablece. Las
                    dos caras quedan visibles en el historial.
                  </p>
                </div>
              </div>

              {result.error && (
                <div
                  role="alert"
                  className="flex items-start gap-2.5 rounded-[var(--radius-control)] border border-danger/30 bg-danger-soft px-3.5 py-3"
                >
                  <AlertTriangle className="mt-px size-4 shrink-0 text-danger" />
                  <p className="text-sm text-danger">{result.error}</p>
                </div>
              )}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

function Row({
  label,
  value,
  bold,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-ink-muted">{label}</dt>
      <dd className={bold ? "cc-tabular font-semibold text-ink" : "text-ink"}>
        {value}
      </dd>
    </div>
  );
}
