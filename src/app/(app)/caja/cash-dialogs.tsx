"use client";

import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  Loader2,
  Scale,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Modal, ModalField, modalInputClass } from "@/components/ui/modal";
import { formatMoney } from "@/core/money/format";
import { cn } from "@/lib/cn";
import {
  createCapitalEvent,
  createTillAdjustment,
  loadClosurePreview,
  performDailyClosure,
  type ActionResult,
  type ClosurePreviewResult,
} from "@/server/cash/actions";

const RESULT_INITIAL: ActionResult = { ok: false, error: null, message: null };
const PREVIEW_INITIAL: ClosurePreviewResult = {
  ok: false,
  error: null,
  data: null,
};

export interface CashDialogsProps {
  cashAccountId: string;
  today: string;
}

export function CashActions(props: CashDialogsProps) {
  const [dialog, setDialog] = useState<
    "closure" | "capital" | "adjustment" | null
  >(null);

  return (
    <>
      <Button variant="primary" onClick={() => setDialog("closure")}>
        <Scale />
        Cierre de caja
      </Button>
      <Button variant="secondary" onClick={() => setDialog("capital")}>
        <ArrowDownToLine />
        Aporte / Retiro
      </Button>
      <Button variant="ghost" onClick={() => setDialog("adjustment")}>
        Ajuste
      </Button>

      {dialog === "closure" && (
        <ClosureDialog {...props} onClose={() => setDialog(null)} />
      )}
      {dialog === "capital" && (
        <CapitalDialog {...props} onClose={() => setDialog(null)} />
      )}
      {dialog === "adjustment" && (
        <AdjustmentDialog {...props} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

// --- Daily closure ----------------------------------------------------------

function ClosureDialog({
  cashAccountId,
  today,
  onClose,
}: CashDialogsProps & { onClose: () => void }) {
  const router = useRouter();
  const [closureDate, setClosureDate] = useState(today);
  const [counted, setCounted] = useState("");
  const [notes, setNotes] = useState("");

  const [preview, previewAction, previewPending] = useActionState(
    loadClosurePreview,
    PREVIEW_INITIAL,
  );
  const [result, confirmAction, confirmPending] = useActionState(
    performDailyClosure,
    RESULT_INITIAL,
  );

  useEffect(() => {
    if (result.ok) router.refresh();
  }, [result.ok, router]);

  const data = preview.data;

  // The difference, computed in the browser purely so the operator sees it move
  // as they type. The authoritative figure is recomputed on the server.
  const difference = useMemo(() => {
    if (!data || counted.trim() === "") return null;
    const typed = Number(counted.replace(/\./g, "").replace(",", "."));
    if (!Number.isFinite(typed)) return null;
    return typed - Number(data.expectedBalance);
  }, [counted, data]);

  return (
    <Modal
      title={result.ok ? "Cierre registrado" : "Cierre de caja"}
      subtitle={result.ok ? undefined : "Contá el efectivo y registrá el saldo real"}
      onClose={onClose}
      busy={confirmPending}
      footer={
        result.ok ? (
          <Button variant="primary" onClick={onClose}>
            Listo
          </Button>
        ) : data && !data.alreadyClosed ? (
          <form action={confirmAction} className="flex w-full justify-end gap-2">
            <input type="hidden" name="cashAccountId" value={cashAccountId} />
            <input type="hidden" name="closureDate" value={closureDate} />
            <input type="hidden" name="countedBalance" value={counted} />
            <input type="hidden" name="notes" value={notes} />
            <Button variant="ghost" onClick={onClose} disabled={confirmPending}>
              Cancelar
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={confirmPending || counted.trim() === ""}
            >
              {confirmPending ? (
                <>
                  <Loader2 className="animate-spin" />
                  Cerrando…
                </>
              ) : (
                <>
                  <CheckCircle2 />
                  Confirmar cierre
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
              form="closure-preview"
              variant="primary"
              disabled={previewPending}
            >
              {previewPending ? (
                <>
                  <Loader2 className="animate-spin" />
                  Calculando…
                </>
              ) : (
                "Calcular saldo esperado"
              )}
            </Button>
          </>
        )
      }
    >
      {result.ok ? (
        <Success message={result.message} />
      ) : (
        <div className="space-y-4 px-5 py-4">
          <form id="closure-preview" action={previewAction}>
            <input type="hidden" name="cashAccountId" value={cashAccountId} />
            <ModalField label="Fecha a cerrar" htmlFor="closureDate">
              <input
                id="closureDate"
                name="closureDate"
                type="date"
                value={closureDate}
                max={today}
                onChange={(event) => setClosureDate(event.target.value)}
                className={modalInputClass}
                required
              />
            </ModalField>
          </form>

          {preview.error && <ErrorBox message={preview.error} />}

          {data?.alreadyClosed && (
            <ErrorBox message="Esta fecha ya tiene un cierre registrado. Los cierres anteriores no se modifican desde acá." />
          )}

          {data && !data.alreadyClosed && (
            <>
              <dl className="space-y-2.5 rounded-[var(--radius-control)] border border-line bg-canvas px-4 py-3">
                <Row label="Saldo inicial" value={formatMoney(data.openingBalance)} />
                <Row
                  label="Entradas"
                  value={`+${formatMoney(data.totalIn)}`}
                  tone="positive"
                />
                <Row
                  label="Salidas"
                  value={`−${formatMoney(data.totalOut)}`}
                  tone="info"
                />
                <div className="flex items-baseline justify-between border-t border-line pt-2.5">
                  <span className="text-sm font-medium text-ink">
                    Saldo esperado
                  </span>
                  <span className="cc-figure text-lg text-ink">
                    {formatMoney(data.expectedBalance)}
                  </span>
                </div>
              </dl>

              <ModalField
                label="Saldo real contado"
                htmlFor="counted"
                hint={`${data.movementCount} movimientos hasta esta fecha`}
              >
                <input
                  id="counted"
                  value={counted}
                  onChange={(event) => setCounted(event.target.value)}
                  inputMode="numeric"
                  placeholder="4.650.000"
                  autoFocus
                  className={modalInputClass}
                />
              </ModalField>

              {difference !== null && (
                <div
                  className={cn(
                    "rounded-[var(--radius-control)] border px-4 py-3",
                    difference === 0
                      ? "border-positive/30 bg-positive-soft"
                      : "border-danger/30 bg-danger-soft",
                  )}
                >
                  <p className="text-xs text-ink-muted">Diferencia</p>
                  <p
                    className={cn(
                      "cc-figure mt-1 text-lg",
                      difference === 0 ? "text-positive" : "text-danger",
                    )}
                  >
                    {difference === 0
                      ? "La caja cuadra"
                      : `${difference > 0 ? "Sobran " : "Faltan "}${formatMoney(String(Math.abs(difference)))}`}
                  </p>
                </div>
              )}

              <ModalField label="Notas (opcional)" htmlFor="closure-notes">
                <input
                  id="closure-notes"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  className={modalInputClass}
                />
              </ModalField>

              {result.error && <ErrorBox message={result.error} />}

              <p className="text-xs text-ink-subtle">
                El cierre queda guardado de forma permanente, con o sin
                diferencia. Si hay faltante o sobrante, podés registrar un ajuste
                aparte para que el libro coincida con lo contado.
              </p>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

// --- Owner capital ----------------------------------------------------------

function CapitalDialog({
  today,
  onClose,
}: CashDialogsProps & { onClose: () => void }) {
  const router = useRouter();
  const [kind, setKind] = useState<"CONTRIBUTION" | "WITHDRAWAL">("CONTRIBUTION");
  const [amount, setAmount] = useState("");
  const [occurredOn, setOccurredOn] = useState(today);
  const [concept, setConcept] = useState("");

  const [result, action, pending] = useActionState(
    createCapitalEvent,
    RESULT_INITIAL,
  );

  const idempotencyKey = useMemo(() => `cap_${crypto.randomUUID()}`, []);

  useEffect(() => {
    if (result.ok) router.refresh();
  }, [result.ok, router]);

  return (
    <Modal
      title={result.ok ? "Registrado" : "Aporte o retiro del propietario"}
      subtitle={result.ok ? undefined : "Movimientos de tu propio capital"}
      onClose={onClose}
      busy={pending}
      footer={
        result.ok ? (
          <Button variant="primary" onClick={onClose}>
            Listo
          </Button>
        ) : (
          <form action={action} className="flex w-full justify-end gap-2">
            <input type="hidden" name="kind" value={kind} />
            <input type="hidden" name="amount" value={amount} />
            <input type="hidden" name="occurredOn" value={occurredOn} />
            <input type="hidden" name="concept" value={concept} />
            <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
            <Button variant="ghost" onClick={onClose} disabled={pending}>
              Cancelar
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={pending || amount.trim() === ""}
            >
              {pending ? (
                <>
                  <Loader2 className="animate-spin" />
                  Registrando…
                </>
              ) : (
                "Registrar"
              )}
            </Button>
          </form>
        )
      }
    >
      {result.ok ? (
        <Success message={result.message} />
      ) : (
        <div className="space-y-4 px-5 py-4">
          <div className="flex gap-1 rounded-[var(--radius-control)] border border-line bg-surface p-1">
            <Segment
              active={kind === "CONTRIBUTION"}
              onClick={() => setKind("CONTRIBUTION")}
              label="Aporte"
              icon={<ArrowDownToLine className="size-3.5" />}
            />
            <Segment
              active={kind === "WITHDRAWAL"}
              onClick={() => setKind("WITHDRAWAL")}
              label="Retiro"
              icon={<ArrowUpFromLine className="size-3.5" />}
            />
          </div>

          <ModalField label="Valor" htmlFor="cap-amount">
            <input
              id="cap-amount"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="numeric"
              placeholder="5.000.000"
              autoFocus
              className={modalInputClass}
            />
          </ModalField>

          <ModalField label="Fecha" htmlFor="cap-date">
            <input
              id="cap-date"
              type="date"
              value={occurredOn}
              max={today}
              onChange={(event) => setOccurredOn(event.target.value)}
              className={modalInputClass}
            />
          </ModalField>

          <ModalField label="Concepto (opcional)" htmlFor="cap-concept">
            <input
              id="cap-concept"
              value={concept}
              onChange={(event) => setConcept(event.target.value)}
              placeholder={
                kind === "CONTRIBUTION"
                  ? "Aporte para colocación"
                  : "Retiro mensual"
              }
              className={modalInputClass}
            />
          </ModalField>

          <div className="flex items-start gap-2.5 rounded-[var(--radius-control)] border border-info/30 bg-info-soft px-3.5 py-3">
            <AlertCircle className="mt-px size-4 shrink-0 text-info" />
            <p className="text-xs text-info">
              {kind === "CONTRIBUTION"
                ? "Un aporte aumenta tu caja y tu patrimonio, pero no es un ingreso: el negocio no lo ganó."
                : "Un retiro reduce tu caja y tu patrimonio, pero no es un gasto: no es un costo de operar."}
            </p>
          </div>

          {result.error && <ErrorBox message={result.error} />}
        </div>
      )}
    </Modal>
  );
}

// --- Till adjustment --------------------------------------------------------

function AdjustmentDialog({
  cashAccountId,
  today,
  onClose,
}: CashDialogsProps & { onClose: () => void }) {
  const router = useRouter();
  const [difference, setDifference] = useState("");
  const [occurredOn, setOccurredOn] = useState(today);
  const [reason, setReason] = useState("");

  const [result, action, pending] = useActionState(
    createTillAdjustment,
    RESULT_INITIAL,
  );

  useEffect(() => {
    if (result.ok) router.refresh();
  }, [result.ok, router]);

  return (
    <Modal
      title={result.ok ? "Ajuste registrado" : "Ajuste de caja"}
      subtitle={result.ok ? undefined : "Alinea el libro con lo que hay en el cajón"}
      onClose={onClose}
      busy={pending}
      footer={
        result.ok ? (
          <Button variant="primary" onClick={onClose}>
            Listo
          </Button>
        ) : (
          <form action={action} className="flex w-full justify-end gap-2">
            <input type="hidden" name="cashAccountId" value={cashAccountId} />
            <input type="hidden" name="difference" value={difference} />
            <input type="hidden" name="occurredOn" value={occurredOn} />
            <input type="hidden" name="reason" value={reason} />
            <Button variant="ghost" onClick={onClose} disabled={pending}>
              Cancelar
            </Button>
            <Button
              type="submit"
              variant="danger"
              disabled={pending || difference.trim() === ""}
            >
              {pending ? (
                <>
                  <Loader2 className="animate-spin" />
                  Registrando…
                </>
              ) : (
                "Registrar ajuste"
              )}
            </Button>
          </form>
        )
      }
    >
      {result.ok ? (
        <Success message={result.message} />
      ) : (
        <div className="space-y-4 px-5 py-4">
          <ModalField
            label="Diferencia"
            htmlFor="adj-difference"
            hint="Negativo si falta plata, positivo si sobra. Ejemplo: -350000"
          >
            <input
              id="adj-difference"
              value={difference}
              onChange={(event) => setDifference(event.target.value)}
              placeholder="-350000"
              autoFocus
              className={modalInputClass}
            />
          </ModalField>

          <ModalField label="Fecha" htmlFor="adj-date">
            <input
              id="adj-date"
              type="date"
              value={occurredOn}
              max={today}
              onChange={(event) => setOccurredOn(event.target.value)}
              className={modalInputClass}
            />
          </ModalField>

          <ModalField label="Motivo" htmlFor="adj-reason">
            <input
              id="adj-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Faltante detectado en el cierre del viernes"
              className={modalInputClass}
              required
            />
          </ModalField>

          <div className="flex items-start gap-2.5 rounded-[var(--radius-control)] border border-warning/30 bg-warning-soft px-3.5 py-3">
            <AlertCircle className="mt-px size-4 shrink-0 text-warning" />
            <p className="text-xs text-warning">
              Un faltante se registra como gasto operativo y un sobrante como
              otro ingreso. El ajuste no borra el cierre que lo detectó: los dos
              quedan en el historial.
            </p>
          </div>

          {result.error && <ErrorBox message={result.error} />}
        </div>
      )}
    </Modal>
  );
}

// --- Shared -----------------------------------------------------------------

function Success({ message }: { message: string | null }) {
  return (
    <div className="px-5 py-8 text-center">
      <div className="mx-auto grid size-12 place-items-center rounded-full bg-positive-soft text-positive">
        <CheckCircle2 className="size-6" />
      </div>
      <p className="mt-4 text-sm text-ink">{message ?? "Registrado"}</p>
    </div>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "positive" | "info";
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd
        className={cn(
          "cc-tabular text-sm",
          tone === "positive" && "text-positive",
          tone === "info" && "text-info",
          !tone && "text-ink",
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
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5",
        "text-xs font-medium transition-colors",
        active
          ? "bg-accent-soft text-accent"
          : "text-ink-muted hover:bg-surface-raised hover:text-ink",
      )}
    >
      {icon}
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
