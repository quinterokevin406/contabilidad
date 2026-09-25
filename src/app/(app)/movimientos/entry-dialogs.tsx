"use client";

import { AlertCircle, CheckCircle2, Loader2, Minus, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Modal, ModalField, modalInputClass } from "@/components/ui/modal";
import {
  createExpense,
  createIncome,
  type ActionResult,
} from "@/server/cash/actions";

const INITIAL: ActionResult = { ok: false, error: null, message: null };

export interface Category {
  id: string;
  name: string;
}

export interface EntryDialogsProps {
  today: string;
  expenseCategories: Category[];
  incomeCategories: Category[];
}

export function EntryActions({
  today,
  expenseCategories,
  incomeCategories,
}: EntryDialogsProps) {
  const [dialog, setDialog] = useState<"expense" | "income" | null>(null);

  return (
    <>
      <Button variant="secondary" onClick={() => setDialog("expense")}>
        <Minus />
        Registrar gasto
      </Button>
      <Button variant="primary" onClick={() => setDialog("income")}>
        <Plus />
        Registrar ingreso
      </Button>

      {dialog === "expense" && (
        <EntryDialog
          kind="expense"
          today={today}
          categories={expenseCategories}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "income" && (
        <EntryDialog
          kind="income"
          today={today}
          categories={incomeCategories}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}

function EntryDialog({
  kind,
  today,
  categories,
  onClose,
}: {
  kind: "expense" | "income";
  today: string;
  categories: Category[];
  onClose: () => void;
}) {
  const router = useRouter();
  const isExpense = kind === "expense";

  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [occurredOn, setOccurredOn] = useState(today);
  const [concept, setConcept] = useState("");
  const [notes, setNotes] = useState("");

  const [result, action, pending] = useActionState(
    isExpense ? createExpense : createIncome,
    INITIAL,
  );

  const idempotencyKey = useMemo(
    () => `${kind}_${crypto.randomUUID()}`,
    [kind],
  );

  useEffect(() => {
    if (result.ok) router.refresh();
  }, [result.ok, router]);

  if (categories.length === 0) {
    return (
      <Modal
        title={isExpense ? "Registrar gasto" : "Registrar ingreso"}
        onClose={onClose}
        footer={
          <Button variant="primary" onClick={onClose}>
            Entendido
          </Button>
        }
      >
        <div className="px-5 py-8 text-center">
          <p className="text-sm text-ink">
            No hay categorías de {isExpense ? "gasto" : "ingreso"} disponibles.
          </p>
          <p className="mt-1 text-xs text-ink-muted">
            Creá una en Configuración antes de registrar movimientos.
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={
        result.ok
          ? "Registrado"
          : isExpense
            ? "Registrar gasto"
            : "Registrar ingreso"
      }
      subtitle={
        result.ok
          ? undefined
          : isExpense
            ? "Reduce tu utilidad del período"
            : "Ingreso operativo que no proviene de préstamos"
      }
      onClose={onClose}
      busy={pending}
      footer={
        result.ok ? (
          <Button variant="primary" onClick={onClose}>
            Listo
          </Button>
        ) : (
          <form action={action} className="flex w-full justify-end gap-2">
            <input type="hidden" name="categoryId" value={categoryId} />
            <input type="hidden" name="amount" value={amount} />
            <input type="hidden" name="occurredOn" value={occurredOn} />
            <input type="hidden" name="concept" value={concept} />
            <input type="hidden" name="notes" value={notes} />
            <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
            <Button variant="ghost" onClick={onClose} disabled={pending}>
              Cancelar
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={pending || amount.trim() === "" || concept.trim() === ""}
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
        <div className="px-5 py-8 text-center">
          <div className="mx-auto grid size-12 place-items-center rounded-full bg-positive-soft text-positive">
            <CheckCircle2 className="size-6" />
          </div>
          <p className="mt-4 text-sm text-ink">{result.message}</p>
        </div>
      ) : (
        <div className="space-y-4 px-5 py-4">
          <ModalField label="Categoría" htmlFor="entry-category">
            <select
              id="entry-category"
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
              className={modalInputClass}
            >
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </ModalField>

          <ModalField label="Valor" htmlFor="entry-amount">
            <input
              id="entry-amount"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="numeric"
              placeholder="150.000"
              autoFocus
              className={modalInputClass}
            />
          </ModalField>

          <ModalField label="Concepto" htmlFor="entry-concept">
            <input
              id="entry-concept"
              value={concept}
              onChange={(event) => setConcept(event.target.value)}
              placeholder={
                isExpense
                  ? "Transporte de cobranza"
                  : "Recuperación de gastos de cobranza"
              }
              className={modalInputClass}
            />
          </ModalField>

          <ModalField label="Fecha" htmlFor="entry-date">
            <input
              id="entry-date"
              type="date"
              value={occurredOn}
              max={today}
              onChange={(event) => setOccurredOn(event.target.value)}
              className={modalInputClass}
            />
          </ModalField>

          <ModalField label="Notas (opcional)" htmlFor="entry-notes">
            <input
              id="entry-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              className={modalInputClass}
            />
          </ModalField>

          {!isExpense && (
            <div className="flex items-start gap-2.5 rounded-[var(--radius-control)] border border-info/30 bg-info-soft px-3.5 py-3">
              <AlertCircle className="mt-px size-4 shrink-0 text-info" />
              <p className="text-xs text-info">
                Los intereses de préstamos entran solos y no se registran acá.
                Esta pantalla es para ingresos que no vienen de la cartera.
              </p>
            </div>
          )}

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
  );
}
