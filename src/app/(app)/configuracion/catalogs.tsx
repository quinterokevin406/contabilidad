"use client";

import {
  AlertCircle,
  Archive,
  Loader2,
  Plus,
  RotateCcw,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { modalInputClass } from "@/components/ui/modal";
import {
  archiveCategory,
  createCategory,
  createPaymentMethod,
  type SettingsResult,
} from "@/server/settings/actions";
import type { CategoryRow, MethodRow } from "@/server/settings/queries";

const INITIAL: SettingsResult = { ok: false, error: null, message: null };

function useRefreshOnSuccess(result: SettingsResult) {
  const router = useRouter();
  useEffect(() => {
    if (result.ok) router.refresh();
  }, [result.ok, router]);
}

/** Expense and income categories (point 88). */
export function CategoriesCard({
  categories,
  financialClass,
  title,
  description,
  readOnly,
}: {
  categories: CategoryRow[];
  financialClass: "OPERATING_EXPENSE" | "OPERATING_INCOME";
  title: string;
  description: string;
  readOnly: boolean;
}) {
  const [createResult, create, creating] = useActionState(
    createCategory,
    INITIAL,
  );
  const [archiveResult, archive, archiving] = useActionState(
    archiveCategory,
    INITIAL,
  );

  useRefreshOnSuccess(createResult);
  useRefreshOnSuccess(archiveResult);

  const mine = categories.filter((c) => c.financialClass === financialClass);
  const active = mine.filter((c) => !c.isArchived);
  const archived = mine.filter((c) => c.isArchived);

  return (
    <Card>
      <CardHeader title={title} description={description} />

      <CardBody className="space-y-4">
        {active.length === 0 && (
          <p className="text-sm text-ink-muted">
            No hay categorías activas. Creá al menos una para poder registrar
            movimientos.
          </p>
        )}

        <ul className="space-y-1.5">
          {active.map((category) => (
            <li
              key={category.id}
              className="flex items-center justify-between gap-3 rounded-[var(--radius-control)] border border-line px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm text-ink">
                  {category.name}
                </span>
                {category.isSystem && <Badge tone="neutral">Sistema</Badge>}
                {category.movements > 0 && (
                  <span className="cc-tabular shrink-0 text-xs text-ink-subtle">
                    {category.movements} mov.
                  </span>
                )}
              </div>

              {!readOnly && !category.isSystem && (
                <form action={archive}>
                  <input
                    type="hidden"
                    name="categoryId"
                    value={category.id}
                  />
                  <Button
                    type="submit"
                    variant="ghost"
                    size="sm"
                    disabled={archiving}
                    title="Archivar"
                  >
                    <Archive />
                  </Button>
                </form>
              )}
            </li>
          ))}
        </ul>

        {archived.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-ink-subtle hover:text-ink">
              {archived.length} archivadas
            </summary>
            <ul className="mt-2 space-y-1.5">
              {archived.map((category) => (
                <li
                  key={category.id}
                  className="flex items-center justify-between gap-3 rounded-[var(--radius-control)] border border-line/60 px-3 py-2"
                >
                  <span className="truncate text-sm text-ink-subtle">
                    {category.name}
                    {category.movements > 0 &&
                      ` · ${category.movements} mov. conservados`}
                  </span>
                  {!readOnly && (
                    <form action={archive}>
                      <input
                        type="hidden"
                        name="categoryId"
                        value={category.id}
                      />
                      <Button
                        type="submit"
                        variant="ghost"
                        size="sm"
                        disabled={archiving}
                        title="Reactivar"
                      >
                        <RotateCcw />
                      </Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}

        {!readOnly && (
          <form action={create} className="flex gap-2">
            <input type="hidden" name="financialClass" value={financialClass} />
            <input
              name="name"
              placeholder="Nueva categoría"
              className={modalInputClass}
              required
            />
            <Button type="submit" variant="secondary" disabled={creating}>
              {creating ? <Loader2 className="animate-spin" /> : <Plus />}
            </Button>
          </form>
        )}

        <Feedback result={createResult} />
        <Feedback result={archiveResult} />
      </CardBody>
    </Card>
  );
}

/** Payment methods (point 88). */
export function MethodsCard({
  methods,
  readOnly,
}: {
  methods: MethodRow[];
  readOnly: boolean;
}) {
  const [result, create, pending] = useActionState(
    createPaymentMethod,
    INITIAL,
  );
  useRefreshOnSuccess(result);

  return (
    <Card>
      <CardHeader
        title="Métodos de pago"
        description="Cómo entra el dinero al registrar un abono"
      />

      <CardBody className="space-y-4">
        <ul className="space-y-1.5">
          {methods.map((method) => (
            <li
              key={method.id}
              className="flex items-center justify-between gap-3 rounded-[var(--radius-control)] border border-line px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm text-ink">{method.name}</span>
                {method.isSystem && <Badge tone="neutral">Sistema</Badge>}
                {method.isArchived && <Badge tone="warning">Archivado</Badge>}
              </div>
              {method.payments > 0 && (
                <span className="cc-tabular shrink-0 text-xs text-ink-subtle">
                  {method.payments} pagos
                </span>
              )}
            </li>
          ))}
        </ul>

        {!readOnly && (
          <form action={create} className="flex gap-2">
            <input
              name="name"
              placeholder="Nuevo método"
              className={modalInputClass}
              required
            />
            <Button type="submit" variant="secondary" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" /> : <Plus />}
            </Button>
          </form>
        )}

        <Feedback result={result} />
      </CardBody>
    </Card>
  );
}

function Feedback({ result }: { result: SettingsResult }) {
  if (result.error) {
    return (
      <p className="flex items-start gap-2 text-xs text-danger">
        <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
        {result.error}
      </p>
    );
  }
  if (result.ok && result.message) {
    return <p className="text-xs text-positive">{result.message}</p>;
  }
  return null;
}
