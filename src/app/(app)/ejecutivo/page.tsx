import type { Metadata } from "next";
import Link from "next/link";
import { Info, TrendingDown, TrendingUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, EmptyState } from "@/components/ui/card";
import {
  formatMoney,
  formatPercent,
  formatPercentagePoints,
} from "@/core/money/format";
import { Money } from "@/core/money/money";
import { todayIn } from "@/core/time/calendar-date";
import { cn } from "@/lib/cn";
import { getOrganizationSettings, requireUser } from "@/server/auth/dal";
import {
  getCurrentPeriod,
  getGoals,
  getSnapshotMetrics,
  getSnapshotSeries,
  type MetricView,
  type SnapshotPoint,
} from "@/server/analytics/queries";

import { ClosePeriodButton } from "./close-period-button";
import { DelinquencyChart, EvolutionChart, ResultChart } from "./charts";

export const metadata: Metadata = { title: "Dashboard ejecutivo" };

export default async function ExecutivePage() {
  const user = await requireUser();
  const settings = await getOrganizationSettings();
  const today = todayIn(settings.timeZone);

  const [series, current] = await Promise.all([
    getSnapshotSeries(user.organizationId, 12),
    getCurrentPeriod(user.organizationId, today),
  ]);

  const goals = await getGoals(user.organizationId, current.point);

  // The last CLOSED month carries the stored metrics; the month in progress has
  // none yet, because it has not been frozen.
  const lastClosed = series[series.length - 1];
  const metrics = lastClosed ? await getSnapshotMetrics(lastClosed.id) : [];

  const previous = series[series.length - 1];
  const equityDelta = previous
    ? current.point.closingEquity.minus(previous.closingEquity)
    : null;

  // The chart shows closed history plus the month in progress, marked as open.
  const chartPoints = [...series, current.point];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink">
            ¿Cómo va el negocio?
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            {current.point.label} en curso
            {lastClosed && ` · último cierre ${lastClosed.label}`}
          </p>
        </div>
        <ClosePeriodButton />
      </header>

      {/* The headline question, answered first (point 87). */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Headline
          label="Patrimonio actual"
          value={formatMoney(current.point.closingEquity)}
          delta={
            equityDelta
              ? {
                  text: `${equityDelta.isNegative() ? "" : "+"}${formatMoney(equityDelta)}`,
                  good: !equityDelta.isNegative(),
                }
              : null
          }
          hint="Aportes + utilidades − retiros"
        />
        <Headline
          label="Utilidad del mes"
          value={formatMoney(current.point.netProfitCash)}
          tone={current.point.netProfitCash.isNegative() ? "danger" : "accent"}
          hint="En curso, se cierra a fin de mes"
        />
        <Headline
          label="Capital colocado"
          value={formatMoney(current.point.principalOutstanding)}
          hint={`${current.point.activeLoans} préstamos activos`}
        />
        <Headline
          label="Capital disponible"
          value={formatMoney(current.point.cashAvailable)}
          hint="Efectivo en caja"
        />
      </div>

      {/*
        Growth from operations versus growth from fresh owner money (point 80).
        Blending the two is how a growth chart flatters a business that only grew
        because its owner put more in.
      */}
      <Card className="px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <div>
            <p className="text-[0.6875rem] tracking-wide text-ink-subtle uppercase">
              Crecimiento generado por la operación
            </p>
            <p className="cc-figure mt-1 text-lg text-accent">
              {formatMoney(current.point.netProfitCash)}
            </p>
          </div>
          <div>
            <p className="text-[0.6875rem] tracking-wide text-ink-subtle uppercase">
              Crecimiento por aportes
            </p>
            <p className="cc-figure mt-1 text-lg text-info">
              {formatMoney(
                current.point.ownerContributions.minus(
                  current.point.ownerWithdrawals,
                ),
              )}
            </p>
          </div>
          <p className="max-w-sm text-xs text-ink-subtle">
            Un aporte aumenta tu patrimonio pero el negocio no lo ganó. Separarlos
            es lo que permite saber si la operación realmente crece.
          </p>
        </div>
      </Card>

      {series.length === 0 ? (
        <Card>
          <EmptyState
            title="Todavía no hay meses cerrados"
            description="Cerrá el primer período para empezar a construir la historia del negocio. Los gráficos leen snapshots congelados, no recalculan el pasado."
          />
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader
              title="Evolución del negocio"
              description={`Últimos ${series.length} meses cerrados más el mes en curso`}
            />
            <EvolutionChart
              data={chartPoints.map((point) => ({
                label: point.isClosed ? point.label : `${point.label} *`,
                patrimonio: Number(point.closingEquity.toDatabaseString()),
                capital: Number(point.principalOutstanding.toDatabaseString()),
                caja: Number(point.cashAvailable.toDatabaseString()),
              }))}
            />
            <p className="border-t border-line px-5 py-2.5 text-xs text-ink-subtle">
              El mes marcado con * está en curso y se recalcula en vivo. Los demás
              son snapshots congelados.
            </p>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader
                title="Ingresos, gastos y utilidad"
                description="Para ver si el gasto crece más rápido que el ingreso"
              />
              <ResultChart
                data={chartPoints.map((point) => ({
                  label: point.isClosed ? point.label : `${point.label} *`,
                  ingresos: Number(
                    point.interestCollected
                      .plus(point.otherIncome)
                      .toDatabaseString(),
                  ),
                  gastos: Number(point.operatingExpenses.toDatabaseString()),
                  utilidad: Number(point.netProfitCash.toDatabaseString()),
                }))}
              />
            </Card>

            <Card>
              <CardHeader
                title="Salud de cartera"
                description="Proporción vencida sobre la cartera total"
              />
              <DelinquencyChart
                data={chartPoints.map((point) => ({
                  label: point.isClosed ? point.label : `${point.label} *`,
                  morosidad: point.delinquencyRatio,
                }))}
              />
              <div className="border-t border-line px-5 py-3">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm text-ink-muted">Hoy</span>
                  <span className="cc-tabular text-sm text-ink">
                    {formatPercent(current.point.delinquencyRatio)}
                  </span>
                </div>
              </div>
            </Card>
          </div>
        </>
      )}

      {metrics.length > 0 && lastClosed && (
        <Card>
          <CardHeader
            title="Salud del negocio"
            description={`Indicadores del cierre de ${lastClosed.label}, con su aritmética`}
          />
          <ul className="divide-y divide-line">
            {metrics.map((metric) => (
              <MetricRow key={metric.metricKey} metric={metric} />
            ))}
          </ul>
        </Card>
      )}

      {goals.length > 0 && (
        <Card>
          <CardHeader
            title="Metas"
            description="Configurables desde Configuración"
          />
          <ul className="divide-y divide-line">
            {goals.map((goal) => (
              <li key={goal.id} className="px-5 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm text-ink">{goal.label}</span>
                  <span className="cc-tabular text-sm text-ink-muted">
                    {goal.unit === "percent"
                      ? `${formatPercent(Number(goal.actual.toDatabaseString()))} de ${formatPercent(Number(goal.target.toDatabaseString()))}`
                      : `${formatMoney(goal.actual)} de ${formatMoney(goal.target)}`}
                  </span>
                </div>

                <div className="mt-2 flex items-center gap-3">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-raised">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        goal.isMet ? "bg-accent" : "bg-info",
                      )}
                      style={{ width: `${goal.percent ?? 0}%` }}
                    />
                  </div>
                  <span className="w-16 shrink-0 text-right text-xs text-ink-subtle">
                    {goal.percent === null ? "N/D" : `${goal.percent}%`}
                  </span>
                  {goal.isMet && <Badge tone="positive">Cumplida</Badge>}
                </div>

                {goal.notComparableReason && (
                  <p className="mt-1.5 text-xs text-ink-subtle">
                    {goal.notComparableReason}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Resumen ejecutivo"
          description="Observaciones derivadas de los datos"
        />
        <ul className="divide-y divide-line">
          {current.observations.map((observation, index) => (
            <li key={index} className="flex items-start gap-3 px-5 py-3">
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
              <p className="text-sm text-ink-muted">{observation.text}</p>
            </li>
          ))}
        </ul>
        <p className="border-t border-line px-5 py-2.5 text-xs text-ink-subtle">
          Estas observaciones dicen qué muestran los datos, nunca por qué. El
          sistema no infiere causas.
        </p>
      </Card>

      <Card className="px-5 py-4">
        <p className="text-xs text-ink-subtle">
          ¿Querés revisar un mes concreto?{" "}
          <Link href="/historico" className="text-accent hover:underline">
            Histórico empresarial
          </Link>{" "}
          muestra cómo estaba el negocio al cierre de cada período.
        </p>
      </Card>
    </div>
  );
}

function MetricRow({ metric }: { metric: MetricView }) {
  const delta = metric.deltaPoints;
  const favourable =
    delta === null || delta === 0
      ? null
      : metric.higherIsBetter
        ? delta > 0
        : delta < 0;

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm text-ink">{metric.label}</span>
        <div className="flex items-baseline gap-3">
          <span className="cc-figure text-base text-ink">
            {formatPercent(metric.value)}
          </span>
          {delta !== null && delta !== 0 && (
            <span
              className={cn(
                "cc-tabular text-xs",
                favourable ? "text-positive" : "text-danger",
              )}
            >
              {formatPercentagePoints(delta)}
            </span>
          )}
        </div>
      </div>

      {metric.isComparable ? (
        <p className="mt-1 text-xs text-ink-subtle">
          {formatMoney(metric.numerator)} sobre {formatMoney(metric.denominator)}
          {metric.previousValue !== null &&
            ` · período anterior ${formatPercent(metric.previousValue)}`}
        </p>
      ) : (
        <p className="mt-1 text-xs text-ink-subtle">
          {metric.notComparableReason}
        </p>
      )}
    </li>
  );
}

function Headline({
  label,
  value,
  hint,
  tone,
  delta,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "accent" | "danger";
  delta?: { text: string; good: boolean } | null;
}) {
  return (
    <Card className="p-5">
      <p className="text-[0.6875rem] font-medium tracking-wide text-ink-subtle uppercase">
        {label}
      </p>
      <p
        className={cn(
          "cc-figure mt-2 text-2xl",
          tone === "accent"
            ? "text-accent"
            : tone === "danger"
              ? "text-danger"
              : "text-ink",
        )}
      >
        {value}
      </p>
      <div className="mt-1 flex items-center gap-2">
        {delta && (
          <span
            className={cn(
              "cc-tabular text-xs",
              delta.good ? "text-positive" : "text-danger",
            )}
          >
            {delta.text}
          </span>
        )}
        {hint && <span className="text-xs text-ink-subtle">{hint}</span>}
      </div>
    </Card>
  );
}

export type { SnapshotPoint, Money };
