"use client";

import { AlertCircle, Bell, Loader2, Plus, Target, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/card";
import { modalInputClass } from "@/components/ui/modal";
import {
  deleteGoal,
  saveAlertRule,
  saveGoal,
  toggleAlertRule,
  type SettingsResult,
} from "@/server/settings/actions";
import type { AlertRow, GoalRow } from "@/server/settings/queries";

const INITIAL: SettingsResult = { ok: false, error: null, message: null };

/** How each goal kind is measured, so the form can label its unit honestly. */
const GOAL_KINDS: Record<string, { label: string; unit: string }> = {
  EQUITY_TARGET: { label: "Patrimonio objetivo", unit: "$" },
  MONTHLY_PROFIT: { label: "Utilidad mensual", unit: "$" },
  INTEREST_COLLECTED: { label: "Intereses cobrados en el mes", unit: "$" },
  MAX_MONTHLY_EXPENSE: { label: "Tope de gastos del mes", unit: "$" },
  MAX_DELINQUENCY_RATIO: { label: "Tope de morosidad", unit: "%" },
  RECOVERY_RATIO: { label: "Recuperación de cartera", unit: "%" },
};

const ALERT_METRICS: Record<string, { label: string; unit: string }> = {
  DELINQUENCY_RATIO: { label: "Índice de morosidad", unit: "%" },
  MONTHLY_EXPENSE_TOTAL: { label: "Gastos del mes", unit: "$" },
  EXPENSE_TO_INCOME_RATIO: { label: "Gastos sobre ingresos", unit: "%" },
  OVERDUE_LOAN_COUNT: { label: "Préstamos en mora", unit: "" },
  OVERDUE_DAYS_MAX: { label: "Días de mora más alto", unit: "días" },
  CASH_DISCREPANCY_ABS: { label: "Descuadre de caja", unit: "$" },
  MISSING_MONTHLY_CLOSURE: { label: "Cierres mensuales pendientes", unit: "" },
  MISSING_DAILY_CLOSURE: { label: "Cierres diarios pendientes", unit: "" },
};

const COMPARATORS: Record<string, string> = {
  GREATER_THAN: "mayor a",
  GREATER_OR_EQUAL: "mayor o igual a",
  LESS_THAN: "menor a",
  LESS_OR_EQUAL: "menor o igual a",
};

const SEVERITY_TONE: Record<string, BadgeTone> = {
  INFO: "info",
  WARNING: "warning",
  CRITICAL: "danger",
};

function formatTarget(value: string, unit: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  if (unit === "$") {
    return `$${numeric.toLocaleString("es-CO", { maximumFractionDigits: 0 })}`;
  }
  if (unit === "%") return `${numeric}%`;
  return unit ? `${numeric} ${unit}` : String(numeric);
}

export function GoalsCard({
  goals,
  readOnly,
}: {
  goals: GoalRow[];
  readOnly: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("MONTHLY_PROFIT");

  const [saveResult, save, saving] = useActionState(saveGoal, INITIAL);
  const [removeResult, remove, removing] = useActionState(deleteGoal, INITIAL);

  useEffect(() => {
    if (saveResult.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [saveResult.ok, router]);

  useEffect(() => {
    if (removeResult.ok) router.refresh();
  }, [removeResult.ok, router]);

  const unit = GOAL_KINDS[kind]?.unit ?? "$";

  return (
    <Card>
      <CardHeader
        title="Metas"
        description="Se comparan contra los resultados reales en Crecimiento"
        action={
          !readOnly && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setOpen((v) => !v)}
            >
              {open ? <X /> : <Plus />}
              {open ? "Cancelar" : "Nueva meta"}
            </Button>
          )
        }
      />

      <CardBody className="space-y-4">
        {open && !readOnly && (
          <form
            action={save}
            className="grid gap-3 rounded-[var(--radius-control)] border border-line bg-canvas p-4 sm:grid-cols-3"
          >
            <select
              name="kind"
              value={kind}
              onChange={(event) => setKind(event.target.value)}
              className={modalInputClass}
            >
              {Object.entries(GOAL_KINDS).map(([value, meta]) => (
                <option key={value} value={value}>
                  {meta.label}
                </option>
              ))}
            </select>

            <input
              name="label"
              placeholder="Nombre de la meta"
              defaultValue={GOAL_KINDS[kind]?.label ?? ""}
              key={kind}
              className={modalInputClass}
              required
            />

            <div className="flex gap-2">
              <input
                name="targetValue"
                inputMode="decimal"
                placeholder={unit === "%" ? "5" : "3.000.000"}
                className={modalInputClass}
                required
              />
              <Button type="submit" variant="primary" disabled={saving}>
                {saving ? <Loader2 className="animate-spin" /> : <Target />}
              </Button>
            </div>

            <p className="text-xs text-ink-subtle sm:col-span-3">
              {unit === "%"
                ? "Valor en puntos porcentuales."
                : "Valor en pesos."}{" "}
              {kind.startsWith("MAX_")
                ? "Es un techo: se cumple mientras el resultado esté por debajo."
                : "Es un piso: se cumple cuando el resultado lo alcanza."}
            </p>
          </form>
        )}

        {goals.length === 0 ? (
          <EmptyState
            icon={<Target className="size-7" />}
            title="Sin metas definidas"
            description="Una meta convierte un número suelto en algo que se puede seguir mes a mes."
          />
        ) : (
          <ul className="space-y-1.5">
            {goals.map((goal) => {
              const meta = GOAL_KINDS[goal.kind];
              return (
                <li
                  key={goal.id}
                  className="flex items-center justify-between gap-3 rounded-[var(--radius-control)] border border-line px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">{goal.label}</p>
                    <p className="text-xs text-ink-subtle">
                      {goal.direction === "AT_MOST"
                        ? "No superar"
                        : "Alcanzar"}{" "}
                      {formatTarget(goal.targetValue, meta?.unit ?? "$")}
                    </p>
                  </div>
                  {!readOnly && (
                    <form action={remove}>
                      <input type="hidden" name="goalId" value={goal.id} />
                      <Button
                        type="submit"
                        variant="ghost"
                        size="sm"
                        disabled={removing}
                        title="Quitar meta"
                      >
                        <X />
                      </Button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <Feedback result={saveResult} />
        <Feedback result={removeResult} />
      </CardBody>
    </Card>
  );
}

export function AlertsCard({
  rules,
  readOnly,
}: {
  rules: AlertRow[];
  readOnly: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [metric, setMetric] = useState("DELINQUENCY_RATIO");

  const [saveResult, save, saving] = useActionState(saveAlertRule, INITIAL);
  const [toggleResult, toggle, toggling] = useActionState(
    toggleAlertRule,
    INITIAL,
  );

  useEffect(() => {
    if (saveResult.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [saveResult.ok, router]);

  useEffect(() => {
    if (toggleResult.ok) router.refresh();
  }, [toggleResult.ok, router]);

  return (
    <Card>
      <CardHeader
        title="Alertas"
        description="Si no hay regla, no hay alerta: ningún umbral viene impuesto"
        action={
          !readOnly && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setOpen((v) => !v)}
            >
              {open ? <X /> : <Plus />}
              {open ? "Cancelar" : "Nueva alerta"}
            </Button>
          )
        }
      />

      <CardBody className="space-y-4">
        {open && !readOnly && (
          <form
            action={save}
            className="grid gap-3 rounded-[var(--radius-control)] border border-line bg-canvas p-4 sm:grid-cols-2"
          >
            <select
              name="metric"
              value={metric}
              onChange={(event) => setMetric(event.target.value)}
              className={modalInputClass}
            >
              {Object.entries(ALERT_METRICS).map(([value, meta]) => (
                <option key={value} value={value}>
                  {meta.label}
                </option>
              ))}
            </select>

            <select
              name="comparator"
              defaultValue="GREATER_THAN"
              className={modalInputClass}
            >
              {Object.entries(COMPARATORS).map(([value, label]) => (
                <option key={value} value={value}>
                  Cuando sea {label}
                </option>
              ))}
            </select>

            <input
              name="threshold"
              inputMode="decimal"
              placeholder={`Umbral (${ALERT_METRICS[metric]?.unit || "unidades"})`}
              className={modalInputClass}
              required
            />

            <select
              name="severity"
              defaultValue="WARNING"
              className={modalInputClass}
            >
              <option value="INFO">Informativa</option>
              <option value="WARNING">Advertencia</option>
              <option value="CRITICAL">Crítica</option>
            </select>

            <input
              name="label"
              placeholder="Qué mirar cuando salte"
              defaultValue={ALERT_METRICS[metric]?.label ?? ""}
              key={metric}
              className={`${modalInputClass} sm:col-span-2`}
              required
            />

            <div className="flex justify-end sm:col-span-2">
              <Button type="submit" variant="primary" disabled={saving}>
                {saving ? <Loader2 className="animate-spin" /> : <Bell />}
                Guardar alerta
              </Button>
            </div>
          </form>
        )}

        {rules.length === 0 ? (
          <EmptyState
            icon={<Bell className="size-7" />}
            title="Sin alertas configuradas"
            description="Definí un umbral para enterarte de un problema antes de tener que buscarlo."
          />
        ) : (
          <ul className="space-y-1.5">
            {rules.map((rule) => {
              const meta = ALERT_METRICS[rule.metric];
              return (
                <li
                  key={rule.id}
                  className="flex items-center justify-between gap-3 rounded-[var(--radius-control)] border border-line px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={SEVERITY_TONE[rule.severity] ?? "neutral"}>
                        {rule.severity === "CRITICAL"
                          ? "Crítica"
                          : rule.severity === "WARNING"
                            ? "Advertencia"
                            : "Informativa"}
                      </Badge>
                      <span className="truncate text-sm text-ink">
                        {rule.label}
                      </span>
                      {!rule.isActive && (
                        <Badge tone="neutral">Desactivada</Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-ink-subtle">
                      {meta?.label ?? rule.metric}{" "}
                      {COMPARATORS[rule.comparator] ?? rule.comparator}{" "}
                      {formatTarget(rule.threshold, meta?.unit ?? "")}
                    </p>
                  </div>

                  {!readOnly && (
                    <form action={toggle}>
                      <input type="hidden" name="ruleId" value={rule.id} />
                      <Button
                        type="submit"
                        variant="ghost"
                        size="sm"
                        disabled={toggling}
                      >
                        {rule.isActive ? "Desactivar" : "Activar"}
                      </Button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <Feedback result={saveResult} />
        <Feedback result={toggleResult} />
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
