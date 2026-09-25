"use client";

import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { formatMoney } from "@/core/money/format";
import { calendarDate } from "@/core/time/calendar-date";
import { formatDate } from "@/core/time/format";
import { cn } from "@/lib/cn";
import {
  confirmRenewal,
  confirmSettlement,
  previewRenewal,
  previewSettlement,
  type ConfirmResult,
  type RenewalPreviewResult,
  type SettlementPreviewResult,
} from "@/server/loans/lifecycle-actions";

/**
 * Renewal and settlement dialogs (points 13, 14 and 16).
 *
 * Both follow the payment dialog's shape: state what you intend, see exactly what
 * the engine will do, then confirm. These two operations change a client's
 * capital and close their loan, so a blind single click is not an option.
 */

const CONFIRM_INITIAL: ConfirmResult = { ok: false, error: null, summary: null };

export interface LifecycleDialogsProps {
  loanId: string;
  loanCode: string;
  clientName: string;
  today: string;
  outstandingPrincipal: string;
  outstandingInterest: string;
  openPeriodPolicy: string;
  methods: { id: string; name: string }[];
}

export function LifecycleActions(props: LifecycleDialogsProps) {
  const [dialog, setDialog] = useState<"renew" | "settle" | null>(null);

  return (
    <>
      <Button variant="secondary" onClick={() => setDialog("renew")}>
        <RefreshCw />
        Renovar
      </Button>
      <Button variant="outline" onClick={() => setDialog("settle")}>
        <ShieldCheck />
        Liquidar
      </Button>

      {dialog === "renew" && (
        <RenewalDialog {...props} onClose={() => setDialog(null)} />
      )}
      {dialog === "settle" && (
        <SettlementDialog {...props} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

// --- Renewal ----------------------------------------------------------------

const RENEWAL_INITIAL: RenewalPreviewResult = {
  ok: false,
  error: null,
  data: null,
};

function RenewalDialog({
  loanId,
  loanCode,
  clientName,
  today,
  outstandingInterest,
  methods,
  onClose,
}: LifecycleDialogsProps & { onClose: () => void }) {
  const router = useRouter();

  const [effectiveOn, setEffectiveOn] = useState(today);
  const [interestPaid, setInterestPaid] = useState(
    stripZeros(outstandingInterest),
  );
  const [capitalMode, setCapitalMode] = useState<
    "UNCHANGED" | "INCREASE" | "DECREASE"
  >("UNCHANGED");
  const [capitalAmount, setCapitalAmount] = useState("");
  const [allowPartial, setAllowPartial] = useState(false);
  const [methodId, setMethodId] = useState(methods[0]?.id ?? "");
  const [notes, setNotes] = useState("");

  const [preview, previewAction, previewPending] = useActionState(
    previewRenewal,
    RENEWAL_INITIAL,
  );
  const [confirm, confirmAction, confirmPending] = useActionState(
    confirmRenewal,
    CONFIRM_INITIAL,
  );

  const idempotencyKey = useMemo(
    () => `renew_${loanId}_${crypto.randomUUID()}`,
    [loanId],
  );

  useEffect(() => {
    if (confirm.ok) router.refresh();
  }, [confirm.ok, router]);

  const data = preview.data;
  const showConfirm = preview.ok && data !== null && !confirm.ok;

  const hidden = (
    <>
      <input type="hidden" name="loanId" value={loanId} />
      <input type="hidden" name="effectiveOn" value={effectiveOn} />
      <input type="hidden" name="interestPaid" value={interestPaid} />
      <input type="hidden" name="capitalMode" value={capitalMode} />
      <input type="hidden" name="capitalAmount" value={capitalAmount} />
      {allowPartial && (
        <input type="hidden" name="allowPartialInterest" value="on" />
      )}
    </>
  );

  return (
    <Shell
      title={
        confirm.ok
          ? "Renovación registrada"
          : showConfirm
            ? "¿Confirmar renovación?"
            : "Renovar préstamo"
      }
      subtitle={`${clientName} · ${loanCode}`}
      onClose={onClose}
      busy={confirmPending}
      footer={
        confirm.ok ? (
          <Button variant="primary" onClick={onClose}>
            Listo
          </Button>
        ) : showConfirm ? (
          <form action={confirmAction} className="flex w-full justify-end gap-2">
            {hidden}
            <input type="hidden" name="paymentMethodId" value={methodId} />
            <input type="hidden" name="notes" value={notes} />
            <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
            <Button variant="ghost" onClick={onClose} disabled={confirmPending}>
              Cancelar
            </Button>
            <Button type="submit" variant="primary" disabled={confirmPending}>
              {confirmPending ? (
                <>
                  <Loader2 className="animate-spin" />
                  Registrando…
                </>
              ) : (
                <>
                  <CheckCircle2 />
                  Confirmar renovación
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
              form="renew-form"
              variant="primary"
              disabled={previewPending}
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
        )
      }
    >
      {confirm.ok ? (
        <Success message={confirm.summary} />
      ) : showConfirm ? (
        <div className="space-y-4 px-5 py-4">
          <dl className="space-y-2.5">
            <Row label="Interés causado" value={formatMoney(data.interestDue)} />
            <Row
              label="Interés cobrado"
              value={formatMoney(data.interestCollected)}
              tone="positive"
            />
            {Number(data.interestCarried) > 0 && (
              <Row
                label="Interés que queda debiendo"
                value={formatMoney(data.interestCarried)}
                tone="warning"
              />
            )}
            <div className="border-t border-line pt-2.5" />
            <Row
              label="Capital antes"
              value={formatMoney(data.previousPrincipal)}
            />
            {Number(data.additionalDisbursed) > 0 && (
              <Row
                label="Capital adicional entregado"
                value={formatMoney(data.additionalDisbursed)}
                tone="info"
              />
            )}
            {Number(data.principalCollected) > 0 && (
              <Row
                label="Capital recibido"
                value={formatMoney(data.principalCollected)}
                tone="positive"
              />
            )}
            <Row
              label="Capital después"
              value={formatMoney(data.newPrincipal)}
              bold
            />
            <div className="border-t border-line pt-2.5" />
            <Row
              label="Próximo vencimiento"
              value={formatDate(calendarDate(data.newDueOn))}
              bold
            />
            <Row
              label="Períodos que se cierran"
              value={String(data.closedPeriods)}
            />
          </dl>

          <div
            className={cn(
              "rounded-[var(--radius-control)] border px-4 py-3",
              Number(data.netCash) < 0
                ? "border-info/30 bg-info-soft"
                : "border-positive/30 bg-positive-soft",
            )}
          >
            <p className="text-xs text-ink-muted">Efecto en caja</p>
            <p
              className={cn(
                "cc-figure mt-1 text-lg",
                Number(data.netCash) < 0 ? "text-info" : "text-positive",
              )}
            >
              {Number(data.netCash) >= 0 ? "+" : ""}
              {formatMoney(data.netCash)}
            </p>
            <p className="mt-1 text-xs text-ink-subtle">
              Entra {formatMoney(data.cashIn)} · sale {formatMoney(data.cashOut)}
            </p>
          </div>

          {confirm.error && <ErrorBox message={confirm.error} />}
        </div>
      ) : (
        <form id="renew-form" action={previewAction} className="space-y-4 px-5 py-4">
          {hidden}

          <div className="rounded-[var(--radius-control)] border border-line bg-canvas px-4 py-3">
            <p className="text-[0.6875rem] tracking-wide text-ink-subtle uppercase">
              Interés pendiente
            </p>
            <p className="cc-tabular mt-0.5 text-sm text-ink">
              {formatMoney(outstandingInterest)}
            </p>
          </div>

          <Field label="Fecha de la renovación" htmlFor="effectiveOn">
            <input
              id="effectiveOn"
              type="date"
              value={effectiveOn}
              max={today}
              onChange={(event) => setEffectiveOn(event.target.value)}
              className={inputClass}
              required
            />
          </Field>

          <Field label="Interés que recibís" htmlFor="interestPaid">
            <input
              id="interestPaid"
              value={interestPaid}
              onChange={(event) => setInterestPaid(event.target.value)}
              inputMode="numeric"
              className={inputClass}
              required
            />
          </Field>

          <label className="flex items-start gap-2.5 text-sm text-ink-muted">
            <input
              type="checkbox"
              checked={allowPartial}
              onChange={(event) => setAllowPartial(event.target.checked)}
              className="mt-0.5 size-4 accent-[var(--color-accent)]"
            />
            <span>
              Permitir renovar con interés pendiente
              <span className="mt-0.5 block text-xs text-ink-subtle">
                El faltante queda registrado como deuda, nunca se borra.
              </span>
            </span>
          </label>

          <div>
            <p className="mb-1.5 text-sm text-ink-muted">Capital</p>
            <div className="flex gap-1 rounded-[var(--radius-control)] border border-line bg-surface p-1">
              <Segment
                active={capitalMode === "UNCHANGED"}
                onClick={() => setCapitalMode("UNCHANGED")}
                label="Sigue igual"
              />
              <Segment
                active={capitalMode === "INCREASE"}
                onClick={() => setCapitalMode("INCREASE")}
                label="Aumenta"
              />
              <Segment
                active={capitalMode === "DECREASE"}
                onClick={() => setCapitalMode("DECREASE")}
                label="Disminuye"
              />
            </div>
          </div>

          {capitalMode !== "UNCHANGED" && (
            <Field
              label={
                capitalMode === "INCREASE"
                  ? "Capital adicional que entregás"
                  : "Capital que recibís"
              }
              htmlFor="capitalAmount"
            >
              <input
                id="capitalAmount"
                value={capitalAmount}
                onChange={(event) => setCapitalAmount(event.target.value)}
                inputMode="numeric"
                placeholder="500.000"
                className={inputClass}
                required
              />
            </Field>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Método" htmlFor="renew-method">
              <select
                id="renew-method"
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
            <Field label="Notas (opcional)" htmlFor="renew-notes">
              <input
                id="renew-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                className={inputClass}
              />
            </Field>
          </div>

          {preview.error && <ErrorBox message={preview.error} />}
        </form>
      )}
    </Shell>
  );
}

// --- Settlement -------------------------------------------------------------

const SETTLEMENT_INITIAL: SettlementPreviewResult = {
  ok: false,
  error: null,
  data: null,
};

const POLICY_LABEL: Record<string, string> = {
  NOT_CHARGED: "No cobrar el período en curso",
  FULL_PERIOD: "Cobrar el período completo",
  PRORATED: "Cobrar proporcional a los días",
};

function SettlementDialog({
  loanId,
  loanCode,
  clientName,
  today,
  openPeriodPolicy,
  methods,
  onClose,
}: LifecycleDialogsProps & { onClose: () => void }) {
  const router = useRouter();

  const [asOf, setAsOf] = useState(today);
  const [policy, setPolicy] = useState(openPeriodPolicy);
  const [methodId, setMethodId] = useState(methods[0]?.id ?? "");
  const [notes, setNotes] = useState("");
  const [kind, setKind] = useState<"FULL_PAYMENT" | "WRITE_OFF">("FULL_PAYMENT");
  const [received, setReceived] = useState("");
  const [reason, setReason] = useState("");

  const [preview, previewAction, previewPending] = useActionState(
    previewSettlement,
    SETTLEMENT_INITIAL,
  );
  const [confirm, confirmAction, confirmPending] = useActionState(
    confirmSettlement,
    CONFIRM_INITIAL,
  );

  const idempotencyKey = useMemo(
    () => `settle_${loanId}_${crypto.randomUUID()}`,
    [loanId],
  );

  useEffect(() => {
    if (confirm.ok) router.refresh();
  }, [confirm.ok, router]);

  const data = preview.data;
  const showConfirm = preview.ok && data !== null && !confirm.ok;

  return (
    <Shell
      title={
        confirm.ok
          ? "Préstamo liquidado"
          : showConfirm
            ? "¿Confirmar liquidación?"
            : "Liquidar préstamo"
      }
      subtitle={`${clientName} · ${loanCode}`}
      onClose={onClose}
      busy={confirmPending}
      footer={
        confirm.ok ? (
          <Button variant="primary" onClick={onClose}>
            Listo
          </Button>
        ) : showConfirm ? (
          <form action={confirmAction} className="flex w-full justify-end gap-2">
            <input type="hidden" name="loanId" value={loanId} />
            <input type="hidden" name="asOf" value={asOf} />
            <input type="hidden" name="policyOverride" value={policy} />
            <input type="hidden" name="kind" value={kind} />
            <input
              type="hidden"
              name="amountReceived"
              value={kind === "WRITE_OFF" ? received || "0" : data.total}
            />
            <input type="hidden" name="reason" value={reason} />
            <input type="hidden" name="paymentMethodId" value={methodId} />
            <input type="hidden" name="notes" value={notes} />
            <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
            <Button variant="ghost" onClick={onClose} disabled={confirmPending}>
              Cancelar
            </Button>
            <Button
              type="submit"
              variant={kind === "WRITE_OFF" ? "danger" : "primary"}
              disabled={confirmPending}
            >
              {confirmPending ? (
                <>
                  <Loader2 className="animate-spin" />
                  Procesando…
                </>
              ) : (
                <>
                  <ShieldCheck />
                  {kind === "WRITE_OFF"
                    ? "Confirmar castigo"
                    : "Confirmar liquidación"}
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
              form="settle-form"
              variant="primary"
              disabled={previewPending}
            >
              {previewPending ? (
                <>
                  <Loader2 className="animate-spin" />
                  Calculando…
                </>
              ) : (
                "Calcular liquidación"
              )}
            </Button>
          </>
        )
      }
    >
      {confirm.ok ? (
        <Success message={confirm.summary} />
      ) : showConfirm ? (
        <div className="space-y-4 px-5 py-4">
          <dl className="space-y-2.5">
            <Row
              label="Capital pendiente"
              value={formatMoney(data.principalOutstanding)}
            />
            <Row
              label="Interés causado"
              value={formatMoney(data.accruedInterest)}
            />
            <Row
              label="Período en curso"
              value={formatMoney(data.openPeriodCharge)}
            />
            <div className="border-t border-line pt-2.5" />
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium text-ink">
                Total para liquidar
              </span>
              <span className="cc-figure text-xl text-accent">
                {formatMoney(data.total)}
              </span>
            </div>
          </dl>

          <p className="rounded-[var(--radius-control)] border border-line bg-canvas px-4 py-3 text-xs text-ink-subtle">
            {data.openPeriodExplanation}
          </p>

          <div>
            <p className="mb-1.5 text-sm text-ink-muted">Cierre</p>
            <div className="flex gap-1 rounded-[var(--radius-control)] border border-line bg-surface p-1">
              <Segment
                active={kind === "FULL_PAYMENT"}
                onClick={() => setKind("FULL_PAYMENT")}
                label="Paga completo"
              />
              <Segment
                active={kind === "WRITE_OFF"}
                onClick={() => setKind("WRITE_OFF")}
                label="Castigar cartera"
              />
            </div>
          </div>

          {kind === "WRITE_OFF" ? (
            <>
              <Field label="Cuánto recibís (puede ser 0)" htmlFor="received">
                <input
                  id="received"
                  value={received}
                  onChange={(event) => setReceived(event.target.value)}
                  inputMode="numeric"
                  placeholder="0"
                  className={inputClass}
                />
              </Field>

              <Field label="Motivo del castigo" htmlFor="reason">
                <input
                  id="reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Acuerdo con el cliente por incapacidad de pago"
                  className={inputClass}
                  required
                />
              </Field>

              <div className="flex items-start gap-2.5 rounded-[var(--radius-control)] border border-danger/30 bg-danger-soft px-3.5 py-3">
                <AlertCircle className="mt-px size-4 shrink-0 text-danger" />
                <div className="text-xs text-danger">
                  <p>
                    El capital no recuperado se registra como{" "}
                    <strong>gasto operativo</strong> y baja tu utilidad del mes.
                  </p>
                  <p className="mt-1.5 opacity-90">
                    No mueve la caja: esa plata salió cuando desembolsaste. El
                    interés no cobrado se condona y no cuesta nada, porque tu
                    utilidad cuenta intereses cuando se cobran.
                  </p>
                </div>
              </div>
            </>
          ) : (
            <div className="flex items-start gap-2.5 rounded-[var(--radius-control)] border border-warning/30 bg-warning-soft px-3.5 py-3">
              <AlertCircle className="mt-px size-4 shrink-0 text-warning" />
              <p className="text-xs text-warning">
                Al confirmar, el préstamo queda cerrado y el cliente debe
                entregar exactamente {formatMoney(data.total)}. El historial se
                conserva completo.
              </p>
            </div>
          )}

          {confirm.error && <ErrorBox message={confirm.error} />}
        </div>
      ) : (
        <form
          id="settle-form"
          action={previewAction}
          className="space-y-4 px-5 py-4"
        >
          <input type="hidden" name="loanId" value={loanId} />
          <input type="hidden" name="asOf" value={asOf} />
          <input type="hidden" name="policyOverride" value={policy} />

          <Field label="Fecha de liquidación" htmlFor="asOf">
            <input
              id="asOf"
              type="date"
              value={asOf}
              max={today}
              onChange={(event) => setAsOf(event.target.value)}
              className={inputClass}
              required
            />
          </Field>

          <div>
            <label
              htmlFor="policy"
              className="mb-1.5 block text-sm text-ink-muted"
            >
              Período en curso
            </label>
            <select
              id="policy"
              value={policy}
              onChange={(event) => setPolicy(event.target.value)}
              className={inputClass}
            >
              {Object.entries(POLICY_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-ink-subtle">
              El préstamo quedó configurado con{" "}
              <strong className="text-ink-muted">
                {POLICY_LABEL[openPeriodPolicy]?.toLowerCase()}
              </strong>
              . Cambiarlo acá aplica solo a esta liquidación y queda registrado.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Método" htmlFor="settle-method">
              <select
                id="settle-method"
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
            <Field label="Notas (opcional)" htmlFor="settle-notes">
              <input
                id="settle-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                className={inputClass}
              />
            </Field>
          </div>

          {preview.error && <ErrorBox message={preview.error} />}
        </form>
      )}
    </Shell>
  );
}

// --- Shared primitives ------------------------------------------------------

function Shell({
  title,
  subtitle,
  onClose,
  busy,
  footer,
  children,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  busy: boolean;
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, busy]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <button
        type="button"
        aria-label="Cerrar"
        onClick={() => !busy && onClose()}
        className="absolute inset-0 bg-overlay backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="cc-card relative flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-b-none sm:rounded-b-[var(--radius-card)]"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={() => !busy && onClose()}
            className="rounded-md p-1 text-ink-subtle hover:bg-surface-hover hover:text-ink"
          >
            <X className="size-4" />
            <span className="sr-only">Cerrar</span>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-line px-5 py-3">
          {footer}
        </div>
      </div>
    </div>
  );
}

function Success({ message }: { message: string | null }) {
  return (
    <div className="px-5 py-8 text-center">
      <div className="mx-auto grid size-12 place-items-center rounded-full bg-positive-soft text-positive">
        <CheckCircle2 className="size-6" />
      </div>
      <p className="mt-4 text-sm text-ink">{message ?? "Operación registrada"}</p>
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

function Row({
  label,
  value,
  bold,
  tone,
}: {
  label: string;
  value: string;
  bold?: boolean;
  tone?: "positive" | "info" | "warning";
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
          tone === "warning" && "text-warning",
          !bold && !tone && "text-ink",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function Segment({
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

/** "200000.00" reads better in an input as "200000". */
function stripZeros(value: string): string {
  return value.endsWith(".00") ? value.slice(0, -3) : value;
}
