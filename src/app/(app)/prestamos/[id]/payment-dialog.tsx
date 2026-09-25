"use client";

import { AlertCircle, CheckCircle2, Loader2, Receipt, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { formatMoney } from "@/core/money/format";
import { formatDate } from "@/core/time/format";
import { calendarDate } from "@/core/time/calendar-date";
import { cn } from "@/lib/cn";
import {
  previewPayment,
  registerPayment,
  type PreviewResult,
  type RegisterResult,
} from "@/server/loans/actions";

/**
 * Payment registration.
 *
 * Three steps, and the middle one is the point: the operator sees exactly where
 * every peso will land, computed by the server's own allocation engine, BEFORE
 * anything is written (point 52). Registering a payment is the action that moves
 * a client's balance, and it should never happen from a single blind click.
 *
 * The idempotency key is generated once when the dialog opens and travels with
 * the submission, so a double click, a slow network retry or a refresh cannot
 * post the same payment twice (point 51).
 */

export interface PaymentDialogProps {
  loanId: string;
  loanCode: string;
  clientName: string;
  outstandingPrincipal: string;
  outstandingInterest: string;
  allocationStrategy: string;
  today: string;
  methods: { id: string; name: string }[];
}

const PREVIEW_INITIAL: PreviewResult = {
  ok: false,
  error: null,
  breakdown: null,
};
const REGISTER_INITIAL: RegisterResult = {
  ok: false,
  error: null,
  receiptNumber: null,
};

export function PaymentDialog(props: PaymentDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        <Receipt />
        Registrar pago
      </Button>
      {open && <Dialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

function Dialog({
  loanId,
  loanCode,
  clientName,
  outstandingPrincipal,
  outstandingInterest,
  allocationStrategy,
  today,
  methods,
  onClose,
}: PaymentDialogProps & { onClose: () => void }) {
  const router = useRouter();

  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(today);
  const [methodId, setMethodId] = useState(methods[0]?.id ?? "");
  const [mode, setMode] = useState<"AUTO" | "MANUAL">("AUTO");
  const [manualInterest, setManualInterest] = useState("");
  const [manualPrincipal, setManualPrincipal] = useState("");
  const [notes, setNotes] = useState("");

  const [preview, previewAction, previewPending] = useActionState(
    previewPayment,
    PREVIEW_INITIAL,
  );
  const [register, registerAction, registerPending] = useActionState(
    registerPayment,
    REGISTER_INITIAL,
  );

  // One key per dialog opening. Regenerating it on every submit would defeat the
  // purpose; keeping it stable is what makes a retry idempotent.
  const idempotencyKey = useMemo(
    () => `pay_${loanId}_${crypto.randomUUID()}`,
    [loanId],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !registerPending) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, registerPending]);

  useEffect(() => {
    if (register.ok) router.refresh();
  }, [register.ok, router]);

  const breakdown = preview.breakdown;
  const showConfirmation = preview.ok && breakdown !== null && !register.ok;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <button
        type="button"
        aria-label="Cerrar"
        onClick={() => !registerPending && onClose()}
        className="absolute inset-0 bg-overlay backdrop-blur-sm"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pay-title"
        className="cc-card relative flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-b-none sm:rounded-b-[var(--radius-card)]"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 id="pay-title" className="text-sm font-semibold text-ink">
              {register.ok
                ? "Pago registrado"
                : showConfirmation
                  ? "¿Confirmar pago?"
                  : "Registrar pago"}
            </h2>
            <p className="mt-0.5 text-xs text-ink-muted">
              {clientName} · {loanCode}
            </p>
          </div>
          <button
            type="button"
            onClick={() => !registerPending && onClose()}
            className="rounded-md p-1 text-ink-subtle hover:bg-surface-hover hover:text-ink"
          >
            <X className="size-4" />
            <span className="sr-only">Cerrar</span>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {register.ok ? (
            <Success
              receiptNumber={register.receiptNumber}
              breakdown={breakdown}
            />
          ) : showConfirmation ? (
            <Confirmation
              clientName={clientName}
              breakdown={breakdown}
              outstandingPrincipal={outstandingPrincipal}
            />
          ) : (
            <form id="preview-form" action={previewAction} className="space-y-4 px-5 py-4">
              <input type="hidden" name="loanId" value={loanId} />
              <input type="hidden" name="mode" value={mode} />

              <div className="grid grid-cols-2 gap-3 rounded-[var(--radius-control)] border border-line bg-canvas px-4 py-3">
                <Figure label="Capital pendiente" value={outstandingPrincipal} />
                <Figure label="Interés pendiente" value={outstandingInterest} />
              </div>

              <Field label="Valor recibido" htmlFor="amount">
                <input
                  id="amount"
                  name="amount"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  inputMode="numeric"
                  placeholder="300.000"
                  autoFocus
                  required
                  className={inputClass}
                />
              </Field>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Fecha" htmlFor="paidOn">
                  <input
                    id="paidOn"
                    name="paidOn"
                    type="date"
                    value={paidOn}
                    max={today}
                    onChange={(event) => setPaidOn(event.target.value)}
                    required
                    className={inputClass}
                  />
                </Field>

                <Field label="Método" htmlFor="paymentMethodId">
                  <select
                    id="paymentMethodId"
                    name="paymentMethodId"
                    value={methodId}
                    onChange={(event) => setMethodId(event.target.value)}
                    className={inputClass}
                  >
                    {methods.map((method) => (
                      <option key={method.id} value={method.id}>
                        {method.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <div>
                <p className="mb-1.5 text-sm text-ink-muted">Aplicación</p>
                <div className="flex gap-1 rounded-[var(--radius-control)] border border-line bg-surface p-1">
                  <ModeButton
                    active={mode === "AUTO"}
                    onClick={() => setMode("AUTO")}
                    label="Automática"
                  />
                  <ModeButton
                    active={mode === "MANUAL"}
                    onClick={() => setMode("MANUAL")}
                    label="Manual"
                  />
                </div>
                <p className="mt-1.5 text-xs text-ink-subtle">
                  {mode === "AUTO"
                    ? allocationStrategy === "INTEREST_FIRST"
                      ? "Se aplica primero a intereses y el resto a capital."
                      : "Se aplica primero a capital y el resto a intereses."
                    : "Vos decidís cuánto va a cada concepto. Debe sumar el valor recibido."}
                </p>
              </div>

              {mode === "MANUAL" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="A intereses" htmlFor="manualInterest">
                    <input
                      id="manualInterest"
                      name="manualInterest"
                      value={manualInterest}
                      onChange={(event) => setManualInterest(event.target.value)}
                      inputMode="numeric"
                      placeholder="0"
                      className={inputClass}
                    />
                  </Field>
                  <Field label="A capital" htmlFor="manualPrincipal">
                    <input
                      id="manualPrincipal"
                      name="manualPrincipal"
                      value={manualPrincipal}
                      onChange={(event) => setManualPrincipal(event.target.value)}
                      inputMode="numeric"
                      placeholder="0"
                      className={inputClass}
                    />
                  </Field>
                </div>
              )}

              <Field label="Notas (opcional)" htmlFor="notes">
                <input
                  id="notes"
                  name="notes"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Observaciones del pago"
                  className={inputClass}
                />
              </Field>

              {preview.error && <ErrorBox message={preview.error} />}
            </form>
          )}

          {showConfirmation && register.error && (
            <div className="px-5 pb-4">
              <ErrorBox message={register.error} />
            </div>
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-line px-5 py-3">
          {register.ok ? (
            <Button variant="primary" onClick={onClose}>
              Listo
            </Button>
          ) : showConfirmation ? (
            <form action={registerAction} className="flex w-full justify-end gap-2">
              <input type="hidden" name="loanId" value={loanId} />
              <input type="hidden" name="amount" value={amount} />
              <input type="hidden" name="paidOn" value={paidOn} />
              <input type="hidden" name="mode" value={mode} />
              <input type="hidden" name="manualInterest" value={manualInterest} />
              <input type="hidden" name="manualPrincipal" value={manualPrincipal} />
              <input type="hidden" name="paymentMethodId" value={methodId} />
              <input type="hidden" name="notes" value={notes} />
              <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

              <Button
                variant="ghost"
                onClick={onClose}
                disabled={registerPending}
              >
                Cancelar
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={registerPending}
              >
                {registerPending ? (
                  <>
                    <Loader2 className="animate-spin" />
                    Registrando…
                  </>
                ) : (
                  <>
                    <CheckCircle2 />
                    Confirmar pago
                  </>
                )}
              </Button>
            </form>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                Cancelar
              </Button>
              <Button
                type="submit"
                form="preview-form"
                variant="primary"
                disabled={previewPending || amount.trim() === ""}
              >
                {previewPending ? (
                  <>
                    <Loader2 className="animate-spin" />
                    Calculando…
                  </>
                ) : (
                  "Continuar"
                )}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Confirmation({
  clientName,
  breakdown,
  outstandingPrincipal,
}: {
  clientName: string;
  breakdown: NonNullable<PreviewResult["breakdown"]>;
  outstandingPrincipal: string;
}) {
  return (
    <div className="space-y-4 px-5 py-4">
      <dl className="space-y-2.5">
        <ConfirmRow label="Cliente" value={clientName} />
        <ConfirmRow label="Recibido" value={formatMoney(breakdown.amount)} bold />
        <div className="border-t border-line pt-2.5" />
        <ConfirmRow
          label="A intereses"
          value={formatMoney(breakdown.interest)}
          tone="positive"
        />
        <ConfirmRow
          label="A capital"
          value={formatMoney(breakdown.principal)}
          tone="info"
        />
        {Number(breakdown.fees) > 0 && (
          <ConfirmRow label="Otros conceptos" value={formatMoney(breakdown.fees)} />
        )}
        <div className="border-t border-line pt-2.5" />
        <ConfirmRow
          label="Capital antes"
          value={formatMoney(outstandingPrincipal)}
        />
        <ConfirmRow
          label="Capital después"
          value={formatMoney(breakdown.resultingPrincipal)}
          bold
        />
      </dl>

      {breakdown.periodOutcomes.length > 0 && (
        <div className="rounded-[var(--radius-control)] border border-line bg-canvas px-4 py-3">
          <p className="mb-2 text-xs font-medium tracking-wide text-ink-subtle uppercase">
            Períodos afectados
          </p>
          <ul className="space-y-1.5">
            {breakdown.periodOutcomes.map((outcome) => (
              <li
                key={outcome.periodIndex}
                className="flex items-center justify-between gap-3 text-xs"
              >
                <span className="text-ink-muted">
                  Período {outcome.periodIndex} · {formatDate(calendarDate(outcome.dueOn))}
                </span>
                <span
                  className={cn(
                    "cc-tabular",
                    outcome.fullySettled ? "text-positive" : "text-warning",
                  )}
                >
                  {formatMoney(outcome.applied)}
                  {!outcome.fullySettled &&
                    ` · quedan ${formatMoney(outcome.after)}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {Number(breakdown.unapplied) > 0 && (
        <div className="flex items-start gap-2.5 rounded-[var(--radius-control)] border border-warning/30 bg-warning-soft px-3.5 py-3">
          <AlertCircle className="mt-px size-4 shrink-0 text-warning" />
          <p className="text-xs text-warning">
            Sobran {formatMoney(breakdown.unapplied)} por encima de la deuda
            total. Usá la liquidación para cerrar el préstamo.
          </p>
        </div>
      )}
    </div>
  );
}

function Success({
  receiptNumber,
  breakdown,
}: {
  receiptNumber: string | null;
  breakdown: PreviewResult["breakdown"];
}) {
  return (
    <div className="px-5 py-8 text-center">
      <div className="mx-auto grid size-12 place-items-center rounded-full bg-positive-soft text-positive">
        <CheckCircle2 className="size-6" />
      </div>
      <p className="mt-4 text-sm font-medium text-ink">Pago registrado</p>
      {receiptNumber && (
        <p className="mt-1 text-xs text-ink-muted">Recibo {receiptNumber}</p>
      )}
      {breakdown && (
        <p className="cc-figure mt-4 text-2xl text-ink">
          {formatMoney(breakdown.amount)}
        </p>
      )}
    </div>
  );
}

const inputClass = cn(
  "h-10 w-full rounded-[var(--radius-control)] border border-line bg-canvas px-3",
  "text-sm text-ink placeholder:text-ink-subtle",
  "transition-colors outline-none focus:border-accent/50",
);

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm text-ink-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[0.6875rem] tracking-wide text-ink-subtle uppercase">
        {label}
      </p>
      <p className="cc-tabular mt-0.5 text-sm text-ink">{formatMoney(value)}</p>
    </div>
  );
}

function ConfirmRow({
  label,
  value,
  bold,
  tone,
}: {
  label: string;
  value: string;
  bold?: boolean;
  tone?: "positive" | "info";
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd
        className={cn(
          "cc-tabular text-sm",
          bold && "font-semibold text-ink",
          tone === "positive" && "text-positive",
          tone === "info" && "text-info",
          !bold && !tone && "text-ink",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
        active
          ? "bg-accent-soft text-accent"
          : "text-ink-muted hover:bg-surface-raised hover:text-ink",
      )}
    >
      {label}
    </button>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-[var(--radius-control)] border border-danger/30 bg-danger-soft px-3.5 py-3"
    >
      <AlertCircle className="mt-px size-4 shrink-0 text-danger" />
      <p className="text-sm text-danger">{message}</p>
    </div>
  );
}
