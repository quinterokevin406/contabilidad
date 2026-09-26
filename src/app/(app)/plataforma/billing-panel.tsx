"use client";

import {
  AlertCircle,
  CheckCircle2,
  CreditCard,
  Loader2,
  Settings2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, EmptyState } from "@/components/ui/card";
import { Modal, ModalField, modalInputClass } from "@/components/ui/modal";
import {
  recordPayment,
  saveSubscription,
  type BillingResult,
} from "@/server/platform/billing-actions";

const INITIAL: BillingResult = { ok: false, error: null, message: null };

/** Serialisable shape: Money never crosses to the client. */
export interface BillingRowView {
  organizationId: string;
  organizationName: string;
  price: string | null;
  currencyCode: string;
  billingDay: number;
  graceDays: number;
  renewalBasis: string;
  paidThrough: string | null;
  cutoffOn: string | null;
  state: string;
  daysPastDue: number;
  collected: string;
  paymentCount: number;
  lastPaidOn: string | null;
}

const STATE_LABEL: Record<string, { label: string; tone: BadgeTone }> = {
  NO_SUBSCRIPTION: { label: "Sin suscripción", tone: "neutral" },
  TRIAL: { label: "Prueba", tone: "info" },
  CURRENT: { label: "Al día", tone: "positive" },
  IN_GRACE: { label: "En gracia", tone: "warning" },
  OVERDUE: { label: "Vencido", tone: "danger" },
};

export function BillingPanel({
  rows,
  today,
}: {
  rows: BillingRowView[];
  today: string;
}) {
  const [paying, setPaying] = useState<BillingRowView | null>(null);
  const [editing, setEditing] = useState<BillingRowView | null>(null);

  const owing = rows.filter(
    (r) => r.state === "IN_GRACE" || r.state === "OVERDUE",
  );

  return (
    <Card>
      <CardHeader
        title="Cobros"
        description={
          owing.length > 0
            ? `${owing.length} con la mensualidad vencida`
            : "Todos al día"
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={<CreditCard className="size-8" />}
          title="No hay negocios que cobrar"
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-subtle">
                <th className="px-5 py-2.5 font-medium">Negocio</th>
                <th className="px-3 py-2.5 text-right font-medium">Mensual</th>
                <th className="px-3 py-2.5 font-medium">Pago hasta</th>
                <th className="px-3 py-2.5 font-medium">Estado</th>
                <th className="px-3 py-2.5 text-right font-medium">Cobrado</th>
                <th className="px-5 py-2.5 text-right font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((row) => {
                const state =
                  STATE_LABEL[row.state] ?? STATE_LABEL.NO_SUBSCRIPTION!;
                return (
                  <tr key={row.organizationId}>
                    <td className="px-5 py-3 text-ink">
                      {row.organizationName}
                    </td>
                    <td className="cc-tabular px-3 py-3 text-right text-ink-muted">
                      {row.price
                        ? `${row.price} ${row.currencyCode}`
                        : "—"}
                    </td>
                    <td className="cc-tabular px-3 py-3 text-xs text-ink-muted">
                      {row.paidThrough ?? "—"}
                      {row.cutoffOn && row.state !== "CURRENT" && (
                        <span className="block text-ink-subtle">
                          corte {row.cutoffOn}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <Badge tone={state.tone}>{state.label}</Badge>
                      {row.daysPastDue > 0 && (
                        <span className="ml-2 text-xs text-ink-subtle">
                          {row.daysPastDue} d
                        </span>
                      )}
                    </td>
                    <td className="cc-tabular px-3 py-3 text-right text-ink-muted">
                      {row.collected}
                      {row.paymentCount > 0 && (
                        <span className="block text-xs text-ink-subtle">
                          {row.paymentCount} pagos
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right whitespace-nowrap">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditing(row)}
                        title="Configurar"
                      >
                        <Settings2 />
                      </Button>
                      {row.state !== "NO_SUBSCRIPTION" && (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="ml-1"
                          onClick={() => setPaying(row)}
                        >
                          Registrar pago
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {paying && (
        <PaymentDialog
          row={paying}
          today={today}
          onClose={() => setPaying(null)}
        />
      )}
      {editing && (
        <SubscriptionDialog
          row={editing}
          today={today}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

function PaymentDialog({
  row,
  today,
  onClose,
}: {
  row: BillingRowView;
  today: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [result, action, pending] = useActionState(recordPayment, INITIAL);

  useEffect(() => {
    if (result.ok) {
      router.refresh();
      const timer = setTimeout(onClose, 1800);
      return () => clearTimeout(timer);
    }
  }, [result.ok, router, onClose]);

  return (
    <Modal title={`Registrar pago — ${row.organizationName}`} onClose={onClose}>
      <form action={action} className="space-y-4 px-5 py-4">
        <input
          type="hidden"
          name="organizationId"
          value={row.organizationId}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <ModalField label={`Valor (${row.currencyCode})`} htmlFor="amount">
            <input
              id="amount"
              name="amount"
              inputMode="decimal"
              defaultValue={row.price ?? ""}
              className={modalInputClass}
              required
              autoFocus
            />
          </ModalField>

          <ModalField label="Fecha del pago" htmlFor="paidOn">
            <input
              id="paidOn"
              name="paidOn"
              type="date"
              defaultValue={today}
              className={modalInputClass}
              required
            />
          </ModalField>

          <ModalField
            label="Cómo llegó"
            htmlFor="method"
            hint="Transferencia, Nequi, efectivo…"
          >
            <input
              id="method"
              name="method"
              className={modalInputClass}
              placeholder="Transferencia"
              required
            />
          </ModalField>

          <ModalField
            label="Meses que cubre"
            htmlFor="periods"
            hint="Un pago puede cubrir varios."
          >
            <input
              id="periods"
              name="periods"
              type="number"
              min={1}
              max={36}
              defaultValue={1}
              className={modalInputClass}
              required
            />
          </ModalField>
        </div>

        <ModalField
          label="Referencia"
          htmlFor="reference"
          hint="Número de transferencia, comprobante. Opcional."
        >
          <input id="reference" name="reference" className={modalInputClass} />
        </ModalField>

        <div className="rounded-[var(--radius-control)] border border-line bg-canvas px-3 py-2.5 text-xs text-ink-muted">
          {row.paidThrough ? (
            <>
              Hoy está cubierto hasta{" "}
              <strong className="text-ink">{row.paidThrough}</strong>. El nuevo
              período arranca donde terminó ese, así que pagar tarde no corre la
              fecha.
            </>
          ) : (
            <>Es el primer pago: el período arranca donde arrancó la suscripción.</>
          )}
          {row.state === "OVERDUE" && (
            <>
              <br />
              <br />
              Este negocio está suspendido.{" "}
              <strong className="text-ink">
                Registrar el pago le devuelve el acceso de inmediato.
              </strong>
            </>
          )}
        </div>

        <Feedback result={result} />

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending && <Loader2 className="animate-spin" />}
            Registrar pago
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function SubscriptionDialog({
  row,
  today,
  onClose,
}: {
  row: BillingRowView;
  today: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [result, action, pending] = useActionState(saveSubscription, INITIAL);

  useEffect(() => {
    if (result.ok) {
      router.refresh();
      const timer = setTimeout(onClose, 1800);
      return () => clearTimeout(timer);
    }
  }, [result.ok, router, onClose]);

  const isNew = row.state === "NO_SUBSCRIPTION";

  return (
    <Modal
      title={`${isNew ? "Crear" : "Configurar"} suscripción — ${row.organizationName}`}
      onClose={onClose}
    >
      <form action={action} className="space-y-4 px-5 py-4">
        <input
          type="hidden"
          name="organizationId"
          value={row.organizationId}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <ModalField label="Precio mensual" htmlFor="price">
            <input
              id="price"
              name="price"
              inputMode="decimal"
              defaultValue={row.price ?? ""}
              className={modalInputClass}
              placeholder="20"
              required
              autoFocus
            />
          </ModalField>

          <ModalField label="Moneda" htmlFor="currencyCode">
            <select
              id="currencyCode"
              name="currencyCode"
              defaultValue={row.currencyCode}
              className={modalInputClass}
            >
              <option value="USD">USD</option>
              <option value="COP">COP</option>
            </select>
          </ModalField>

          <ModalField
            label="Día de cobro"
            htmlFor="billingDay"
            hint="1 a 28, para que exista en todos los meses."
          >
            <input
              id="billingDay"
              name="billingDay"
              type="number"
              min={1}
              max={28}
              defaultValue={row.billingDay}
              className={modalInputClass}
              required
            />
          </ModalField>

          <ModalField
            label="Días de gracia"
            htmlFor="graceDays"
            hint="Cuántos días de atraso tolerás antes de cortar."
          >
            <input
              id="graceDays"
              name="graceDays"
              type="number"
              min={0}
              max={60}
              defaultValue={row.graceDays}
              className={modalInputClass}
              required
            />
          </ModalField>
        </div>

        <ModalField
          label="Si paga tarde, el nuevo período arranca…"
          htmlFor="renewalBasis"
        >
          <select
            id="renewalBasis"
            name="renewalBasis"
            defaultValue={row.renewalBasis}
            className={modalInputClass}
          >
            <option value="PREVIOUS_DUE_DATE">
              Donde terminó el anterior (atrasarse no regala días)
            </option>
            <option value="EFFECTIVE_DATE">
              El día que llegó la plata (los días de atraso quedan gratis)
            </option>
          </select>
        </ModalField>

        {isNew && (
          <ModalField
            label="Desde cuándo"
            htmlFor="startedAt"
            hint="El primer pago se cuenta desde esta fecha."
          >
            <input
              id="startedAt"
              name="startedAt"
              type="date"
              defaultValue={today}
              className={modalInputClass}
              required
            />
          </ModalField>
        )}
        {!isNew && (
          <input type="hidden" name="startedAt" value={today} />
        )}

        {!isNew && (
          <p className="text-xs text-ink-subtle">
            Cambiar el precio no altera lo que ya está pago: la cobertura
            vigente se respeta hasta {row.paidThrough ?? "su vencimiento"}.
          </p>
        )}

        <Feedback result={result} />

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending && <Loader2 className="animate-spin" />}
            Guardar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Feedback({ result }: { result: BillingResult }) {
  if (result.error) {
    return (
      <p className="flex items-start gap-2 text-sm text-danger">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        {result.error}
      </p>
    );
  }
  if (result.ok && result.message) {
    return (
      <p className="flex items-start gap-2 text-sm text-positive">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
        {result.message}
      </p>
    );
  }
  return null;
}
