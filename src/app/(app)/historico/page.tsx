import type { Metadata } from "next";
import Link from "next/link";
import { Archive, Info, TrendingDown, TrendingUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, EmptyState } from "@/components/ui/card";
import {
  formatMoney,
  formatPercent,
  formatPercentagePoints,
} from "@/core/money/format";
import { formatDate } from "@/core/time/format";
import { cn } from "@/lib/cn";
import { requireUser } from "@/server/auth/dal";
import {
  getSnapshotMetrics,
  getSnapshotObservations,
  listClosedPeriods,
} from "@/server/analytics/queries";

export const metadata: Metadata = { title: "Histórico empresarial" };

export default async function HistoryPage({
  searchParams,
}: PageProps<"/historico">) {
  const user = await requireUser();
  const params = await searchParams;

  const periods = await listClosedPeriods(user.organizationId);

  const selectedId =
    typeof params.periodo === "string" ? params.periodo : periods[0]?.id;
  const selected = periods.find((period) => period.id === selectedId);

  const [metrics, observations] = selected
    ? await Promise.all([
        getSnapshotMetrics(selected.id),
        getSnapshotObservations(selected.id),
      ])
    : [[], []];

  // The month immediately before the selected one, for the comparison column.
  const selectedIndex = periods.findIndex((p) => p.id === selected?.id);
  const previous =
    selectedIndex >= 0 ? periods[selectedIndex + 1] : undefined;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-ink">
          Histórico empresarial
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          {periods.length === 0
            ? "Todavía no hay períodos cerrados"
            : `${periods.length} ${periods.length === 1 ? "período cerrado" : "períodos cerrados"}`}
        </p>
      </header>

      {periods.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Archive className="size-8" />}
            title="Sin historia todavía"
            description="Cerrá un mes desde el Dashboard ejecutivo para congelar el primer snapshot."
            action={
              <Link
                href="/ejecutivo"
                className="rounded-[var(--radius-control)] bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong"
              >
                Ir al dashboard ejecutivo
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {periods.map((period) => (
              <Link
                key={period.id}
                href={`/historico?periodo=${period.id}`}
                className={cn(
                  "rounded-[var(--radius-control)] border px-3 py-1.5 text-xs font-medium transition-colors",
                  period.id === selected?.id
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-line text-ink-muted hover:border-line-strong hover:text-ink",
                )}
              >
                {period.label}
              </Link>
            ))}
          </div>

          {selected && (
            <>
              <Card>
                <CardHeader
                  title={`Cierre de ${selected.label}`}
                  description={`${formatDate(selected.periodStart)} al ${formatDate(selected.periodEnd)}`}
                  action={<Badge tone="neutral">Congelado</Badge>}
                />
                <div className="grid gap-x-8 gap-y-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Figure
                    label="Patrimonio inicial"
                    value={formatMoney(selected.openingEquity)}
                  />
                  <Figure
                    label="Patrimonio final"
                    value={formatMoney(selected.closingEquity)}
                    emphasis
                  />
                  <Figure
                    label="Utilidad neta"
                    value={formatMoney(selected.netProfitCash)}
                    tone={
                      selected.netProfitCash.isNegative() ? "danger" : "accent"
                    }
                  />
                  <Figure
                    label="Capital colocado"
                    value={formatMoney(selected.principalOutstanding)}
                  />
                  <Figure
                    label="Capital disponible"
                    value={formatMoney(selected.cashAvailable)}
                  />
                  <Figure
                    label="Intereses cobrados"
                    value={formatMoney(selected.interestCollected)}
                  />
                  <Figure
                    label="Otros ingresos"
                    value={formatMoney(selected.otherIncome)}
                  />
                  <Figure
                    label="Gastos operativos"
                    value={formatMoney(selected.operatingExpenses)}
                  />
                  <Figure
                    label="Cartera pendiente"
                    value={formatMoney(selected.portfolioOutstanding)}
                  />
                  <Figure
                    label="Cartera vencida"
                    value={formatMoney(selected.portfolioOverdue)}
                    tone="danger"
                  />
                  <Figure
                    label="Índice de morosidad"
                    value={formatPercent(selected.delinquencyRatio)}
                  />
                  <Figure
                    label="Aportes − retiros"
                    value={formatMoney(
                      selected.ownerContributions.minus(
                        selected.ownerWithdrawals,
                      ),
                    )}
                  />
                </div>

                <div className="grid gap-x-8 gap-y-3 border-t border-line px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Counter label="Clientes activos" value={selected.activeClients} />
                  <Counter label="Préstamos activos" value={selected.activeLoans} />
                  <Counter label="Nuevos préstamos" value={selected.newLoans} />
                  <Counter
                    label="Préstamos liquidados"
                    value={selected.settledLoans}
                  />
                </div>
              </Card>

              {previous && (
                <Card>
                  <CardHeader
                    title={`${selected.label} vs ${previous.label}`}
                    description="Diferencias absolutas y porcentuales"
                  />
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[34rem] text-sm">
                      <thead>
                        <tr className="border-b border-line text-left">
                          <Th>Concepto</Th>
                          <Th className="text-right">{previous.label}</Th>
                          <Th className="text-right">{selected.label}</Th>
                          <Th className="text-right">Variación</Th>
                        </tr>
                      </thead>
                      <tbody>
                        <CompareRow
                          label="Patrimonio"
                          before={previous.closingEquity}
                          after={selected.closingEquity}
                          higherIsBetter
                        />
                        <CompareRow
                          label="Utilidad neta"
                          before={previous.netProfitCash}
                          after={selected.netProfitCash}
                          higherIsBetter
                        />
                        <CompareRow
                          label="Intereses cobrados"
                          before={previous.interestCollected}
                          after={selected.interestCollected}
                          higherIsBetter
                        />
                        <CompareRow
                          label="Gastos operativos"
                          before={previous.operatingExpenses}
                          after={selected.operatingExpenses}
                          // Point 71: more expense is not automatically bad, so
                          // this row carries no verdict colour.
                          higherIsBetter={null}
                        />
                        <CompareRow
                          label="Capital colocado"
                          before={previous.principalOutstanding}
                          after={selected.principalOutstanding}
                          higherIsBetter
                        />
                        <CompareRow
                          label="Cartera vencida"
                          before={previous.portfolioOverdue}
                          after={selected.portfolioOverdue}
                          higherIsBetter={false}
                        />
                      </tbody>
                    </table>
                  </div>
                  <p className="border-t border-line px-5 py-2.5 text-xs text-ink-subtle">
                    Los gastos no se califican por su variación sola: crecer en
                    gasto puede ser sano si los ingresos crecen más. El resumen
                    ejecutivo los compara contra el ingreso.
                  </p>
                </Card>
              )}

              {metrics.length > 0 && (
                <Card>
                  <CardHeader
                    title="Indicadores del cierre"
                    description="Cada uno con el cálculo que lo produjo"
                  />
                  <ul className="divide-y divide-line">
                    {metrics.map((metric) => (
                      <li key={metric.metricKey} className="px-5 py-3.5">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="text-sm text-ink">{metric.label}</span>
                          <div className="flex items-baseline gap-3">
                            <span className="cc-tabular text-sm text-ink">
                              {formatPercent(metric.value)}
                            </span>
                            {metric.deltaPoints !== null &&
                              metric.deltaPoints !== 0 && (
                                <span
                                  className={cn(
                                    "cc-tabular text-xs",
                                    (metric.higherIsBetter
                                      ? metric.deltaPoints > 0
                                      : metric.deltaPoints < 0)
                                      ? "text-positive"
                                      : "text-danger",
                                  )}
                                >
                                  {formatPercentagePoints(metric.deltaPoints)}
                                </span>
                              )}
                          </div>
                        </div>
                        <p className="mt-1 text-xs text-ink-subtle">
                          {metric.isComparable
                            ? `${formatMoney(metric.numerator)} sobre ${formatMoney(metric.denominator)}`
                            : metric.notComparableReason}
                        </p>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              {observations.length > 0 && (
                <Card>
                  <CardHeader
                    title="Resumen ejecutivo"
                    description="Generado al cerrar, con las palabras de entonces"
                  />
                  <ul className="divide-y divide-line">
                    {observations.map((observation, index) => (
                      <li
                        key={index}
                        className="flex items-start gap-3 px-5 py-3"
                      >
                        <span
                          className={cn(
                            "mt-0.5 shrink-0",
                            observation.meaning === "FAVORABLE"
                              ? "text-positive"
                              : observation.meaning === "UNFAVORABLE"
                                ? "text-danger"
                                : "text-ink-subtle",
                          )}
                        >
                          {observation.meaning === "FAVORABLE" ? (
                            <TrendingUp className="size-4" />
                          ) : observation.meaning === "UNFAVORABLE" ? (
                            <TrendingDown className="size-4" />
                          ) : (
                            <Info className="size-4" />
                          )}
                        </span>
                        <p className="text-sm text-ink-muted">
                          {observation.text}
                        </p>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`px-4 py-3 text-xs font-medium tracking-wide text-ink-subtle uppercase ${className ?? ""}`}
    >
      {children}
    </th>
  );
}

function CompareRow({
  label,
  before,
  after,
  higherIsBetter,
}: {
  label: string;
  before: { toDatabaseString(): string };
  after: { toDatabaseString(): string };
  /** Null means the change carries no verdict. */
  higherIsBetter: boolean | null;
}) {
  const beforeValue = Number(before.toDatabaseString());
  const afterValue = Number(after.toDatabaseString());
  const delta = afterValue - beforeValue;

  const percent =
    beforeValue === 0 ? null : (delta / Math.abs(beforeValue)) * 100;

  const good =
    higherIsBetter === null || delta === 0
      ? null
      : higherIsBetter
        ? delta > 0
        : delta < 0;

  return (
    <tr className="border-b border-line/60 last:border-0">
      <td className="px-4 py-2.5 text-ink-muted">{label}</td>
      <td className="cc-tabular px-4 py-2.5 text-right text-ink-subtle">
        {formatMoney(String(beforeValue))}
      </td>
      <td className="cc-tabular px-4 py-2.5 text-right text-ink">
        {formatMoney(String(afterValue))}
      </td>
      <td
        className={cn(
          "cc-tabular px-4 py-2.5 text-right",
          good === null
            ? "text-ink-muted"
            : good
              ? "text-positive"
              : "text-danger",
        )}
      >
        {delta === 0
          ? "—"
          : `${delta > 0 ? "+" : "−"}${formatMoney(String(Math.abs(delta)))}`}
        {percent !== null && delta !== 0 && (
          <span className="ml-1.5 text-xs opacity-80">
            {formatPercent(percent, { signed: true })}
          </span>
        )}
      </td>
    </tr>
  );
}

function Figure({
  label,
  value,
  emphasis,
  tone,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  tone?: "accent" | "danger";
}) {
  return (
    <div>
      <p className="text-[0.6875rem] tracking-wide text-ink-subtle uppercase">
        {label}
      </p>
      <p
        className={cn(
          "cc-tabular mt-0.5",
          emphasis ? "cc-figure text-lg" : "text-sm",
          tone === "accent"
            ? "text-accent"
            : tone === "danger"
              ? "text-danger"
              : "text-ink",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-[0.6875rem] tracking-wide text-ink-subtle uppercase">
        {label}
      </p>
      <p className="cc-tabular mt-0.5 text-sm text-ink">{value}</p>
    </div>
  );
}
