"use client";

import { AlertCircle, CheckCircle2, Loader2, Lock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Modal, ModalField, modalInputClass } from "@/components/ui/modal";
import { closeMonthlyPeriod, type CloseResult } from "@/server/analytics/actions";

const INITIAL: CloseResult = { ok: false, error: null, message: null };

/**
 * Closing a month (point 70).
 *
 * The confirmation spells out that a closed snapshot is permanent, because it
 * is: every later comparison reads those frozen figures, and recalculating them
 * under a future configuration is exactly what point 70 forbids.
 */
export function ClosePeriodButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState("");
  const [result, action, pending] = useActionState(
    closeMonthlyPeriod,
    INITIAL,
  );

  useEffect(() => {
    if (result.ok) router.refresh();
  }, [result.ok, router]);

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Lock />
        Cerrar mes
      </Button>

      {open && (
        <Modal
          title={result.ok ? "Período cerrado" : "Cerrar período mensual"}
          subtitle={
            result.ok ? undefined : "El snapshot queda congelado para siempre"
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
                <input type="hidden" name="month" value={`${month}-01`} />
                <Button
                  variant="ghost"
                  onClick={() => setOpen(false)}
                  disabled={pending}
                >
                  Cancelar
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={pending || month === ""}
                >
                  {pending ? (
                    <>
                      <Loader2 className="animate-spin" />
                      Cerrando…
                    </>
                  ) : (
                    <>
                      <Lock />
                      Cerrar período
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
          ) : (
            <div className="space-y-4 px-5 py-4">
              <ModalField
                label="Mes a cerrar"
                htmlFor="close-month"
                hint="Solo se pueden cerrar meses que ya terminaron"
              >
                <input
                  id="close-month"
                  type="month"
                  value={month}
                  onChange={(event) => setMonth(event.target.value)}
                  className={modalInputClass}
                  autoFocus
                />
              </ModalField>

              <div className="flex items-start gap-2.5 rounded-[var(--radius-control)] border border-warning/30 bg-warning-soft px-3.5 py-3">
                <AlertCircle className="mt-px size-4 shrink-0 text-warning" />
                <div className="text-xs text-warning">
                  <p>
                    Un período cerrado <strong>no se vuelve a calcular</strong>.
                  </p>
                  <p className="mt-1.5 opacity-90">
                    Sus cifras quedan congeladas, y todas las comparaciones
                    futuras las leen de ahí. Eso es lo que permite comparar meses
                    sin que una configuración cambiada hoy altere lo que pasó.
                  </p>
                </div>
              </div>

              {result.error && (
                <div
                  role="alert"
                  className="flex items-start gap-2.5 rounded-[var(--radius-control)] border border-danger/30 bg-danger-soft px-3.5 py-3"
                >
                  <AlertCircle className="mt-px size-4 shrink-0 text-danger" />
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
