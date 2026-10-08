"use client";

import { AlertCircle, CheckCircle2, Loader2, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Modal, ModalField, modalInputClass } from "@/components/ui/modal";
import {
  registerLoan,
  type CreateLoanActionResult,
} from "@/server/loans/actions";

const INITIAL: CreateLoanActionResult = {
  ok: false,
  error: null,
  message: null,
  loanId: null,
};

export interface LoanClientOption {
  id: string;
  code: string;
  fullName: string;
}

/** Days a period lasts, for showing the first due date before it is saved. */
const PERIOD_DAYS: Record<string, number> = {
  DAILY: 1,
  WEEKLY: 7,
  BIWEEKLY: 15,
  MONTHLY: 30,
};

const PERIOD_LABEL: Record<string, string> = {
  DAILY: "diario",
  WEEKLY: "semanal",
  BIWEEKLY: "quincenal",
  MONTHLY: "mensual",
  CUSTOM: "por período",
};

export function NewLoanButton({
  clients,
  today,
  defaultInterestMethod,
  defaultPeriodicity,
  fixedClientId,
  label = "Nuevo préstamo",
  size = "md",
}: {
  clients: LoanClientOption[];
  today: string;
  defaultInterestMethod: string;
  defaultPeriodicity: string;
  /** Set when opening from a client's own page. */
  fixedClientId?: string;
  label?: string;
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="primary" size={size} onClick={() => setOpen(true)}>
        <Plus />
        {label}
      </Button>

      {open && (
        <NewLoanDialog
          clients={clients}
          today={today}
          defaultInterestMethod={defaultInterestMethod}
          defaultPeriodicity={defaultPeriodicity}
          fixedClientId={fixedClientId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d! + days));
  return date.toISOString().slice(0, 10);
}

function NewLoanDialog({
  clients,
  today,
  defaultInterestMethod,
  defaultPeriodicity,
  fixedClientId,
  onClose,
}: {
  clients: LoanClientOption[];
  today: string;
  defaultInterestMethod: string;
  defaultPeriodicity: string;
  fixedClientId?: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [result, action, pending] = useActionState(registerLoan, INITIAL);

  const [periodicity, setPeriodicity] = useState(defaultPeriodicity);
  const [customDays, setCustomDays] = useState(30);
  const [disbursedOn, setDisbursedOn] = useState(today);
  const [principal, setPrincipal] = useState("");
  const [ratePercent, setRatePercent] = useState("");
  const [firstDueOn, setFirstDueOn] = useState(
    addDays(today, PERIOD_DAYS[defaultPeriodicity] ?? 30),
  );

  // One key per dialog: a double click or a lost connection must not disburse
  // the same loan twice.
  const idempotencyKey = useMemo(() => `loan_${crypto.randomUUID()}`, []);

  // Keep the suggested due date in step with the rhythm, until the operator
  // edits it themselves — then it is theirs and nothing moves it.
  const [dueTouched, setDueTouched] = useState(false);
  useEffect(() => {
    if (dueTouched) return;
    const days =
      periodicity === "CUSTOM" ? customDays : (PERIOD_DAYS[periodicity] ?? 30);
    setFirstDueOn(addDays(disbursedOn, days));
  }, [periodicity, customDays, disbursedOn, dueTouched]);

  useEffect(() => {
    if (result.ok && result.loanId) router.push(`/prestamos/${result.loanId}`);
  }, [result.ok, result.loanId, router]);

  const interest = useMemo(() => {
    const p = Number(principal.replace(/\./g, "").replace(",", "."));
    const r = Number(ratePercent.replace(",", "."));
    if (!Number.isFinite(p) || !Number.isFinite(r) || p <= 0 || r <= 0) {
      return null;
    }
    return Math.round((p * r) / 100);
  }, [principal, ratePercent]);

  if (clients.length === 0) {
    return (
      <Modal
        title="Nuevo préstamo"
        onClose={onClose}
        footer={
          <Button variant="primary" onClick={onClose}>
            Entendido
          </Button>
        }
      >
        <div className="px-5 py-8 text-center">
          <p className="text-sm text-ink">Todavía no hay clientes.</p>
          <p className="mt-1 text-xs text-ink-muted">
            Registrá uno primero desde la pantalla de Clientes.
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Nuevo préstamo" onClose={onClose}>
      <form action={action} className="space-y-4 px-5 py-4">
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

        {fixedClientId ? (
          <input type="hidden" name="clientId" value={fixedClientId} />
        ) : (
          <ModalField label="Cliente" htmlFor="clientId">
            <select
              id="clientId"
              name="clientId"
              className={modalInputClass}
              required
              defaultValue=""
            >
              <option value="" disabled>
                Elegí un cliente
              </option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} · {c.fullName}
                </option>
              ))}
            </select>
          </ModalField>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <ModalField
            label="Monto a prestar"
            htmlFor="principal"
            hint="Lo que sale de tu caja hoy."
          >
            <input
              id="principal"
              name="principal"
              inputMode="decimal"
              value={principal}
              onChange={(e) => setPrincipal(e.target.value)}
              className={modalInputClass}
              placeholder="1.000.000"
              required
              autoFocus
            />
          </ModalField>

          <ModalField
            label={`Tasa de interés (% ${PERIOD_LABEL[periodicity] ?? ""})`}
            htmlFor="ratePercent"
            hint="Por período, no anual."
          >
            <input
              id="ratePercent"
              name="ratePercent"
              inputMode="decimal"
              value={ratePercent}
              onChange={(e) => setRatePercent(e.target.value)}
              className={modalInputClass}
              placeholder="10"
              required
            />
          </ModalField>

          <ModalField label="Periodicidad del cobro" htmlFor="periodicity">
            <select
              id="periodicity"
              name="periodicity"
              value={periodicity}
              onChange={(e) => setPeriodicity(e.target.value)}
              className={modalInputClass}
            >
              <option value="DAILY">Diaria</option>
              <option value="WEEKLY">Semanal</option>
              <option value="BIWEEKLY">Quincenal</option>
              <option value="MONTHLY">Mensual</option>
              <option value="CUSTOM">Personalizada</option>
            </select>
          </ModalField>

          {periodicity === "CUSTOM" && (
            <ModalField label="Días por período" htmlFor="customPeriodDays">
              <input
                id="customPeriodDays"
                name="customPeriodDays"
                type="number"
                min={1}
                max={365}
                value={customDays}
                onChange={(e) => setCustomDays(Number(e.target.value))}
                className={modalInputClass}
              />
            </ModalField>
          )}

          <ModalField label="Fecha del desembolso" htmlFor="disbursedOn">
            <input
              id="disbursedOn"
              name="disbursedOn"
              type="date"
              value={disbursedOn}
              onChange={(e) => setDisbursedOn(e.target.value)}
              className={modalInputClass}
              required
            />
          </ModalField>

          <ModalField
            label="Primer vencimiento"
            htmlFor="firstDueOn"
            hint="Se sugiere solo. Cambialo si acordaste otra fecha."
          >
            <input
              id="firstDueOn"
              name="firstDueOn"
              type="date"
              value={firstDueOn}
              onChange={(e) => {
                setDueTouched(true);
                setFirstDueOn(e.target.value);
              }}
              className={modalInputClass}
              required
            />
          </ModalField>
        </div>

        <ModalField
          label="Cómo se calcula el interés"
          htmlFor="interestMethod"
          hint="Sobre capital original: la cuota no baja al abonar. Sobre saldo: baja."
        >
          <select
            id="interestMethod"
            name="interestMethod"
            defaultValue={defaultInterestMethod}
            className={modalInputClass}
          >
            <option value="SIMPLE_ON_ORIGINAL_PRINCIPAL">
              Sobre el capital original
            </option>
            <option value="SIMPLE_ON_OUTSTANDING_PRINCIPAL">
              Sobre el saldo de capital
            </option>
          </select>
        </ModalField>

        {interest !== null && (
          <div className="rounded-[var(--radius-control)] border border-line bg-canvas px-3 py-2.5 text-xs text-ink-muted">
            Interés del primer período:{" "}
            <strong className="cc-tabular text-ink">
              ${interest.toLocaleString("es-CO")}
            </strong>
            . Es una cuenta rápida para que confirmes la tasa antes de guardar —
            el sistema la recalcula con su propio redondeo al registrarla.
          </div>
        )}

        <ModalField label="Observaciones" htmlFor="notes">
          <input id="notes" name="notes" className={modalInputClass} />
        </ModalField>

        <div className="rounded-[var(--radius-control)] border border-warning/25 bg-warning-soft/20 px-3 py-2.5 text-xs text-ink-muted">
          Al guardar, <strong className="text-ink">la plata sale de tu caja</strong>{" "}
          y el préstamo congela estas reglas. Cambiar la configuración después no
          toca este préstamo nunca.
        </div>

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
            {pending ? <Loader2 className="animate-spin" /> : <Plus />}
            Desembolsar préstamo
          </Button>
        </div>
      </form>
    </Modal>
  );
}
