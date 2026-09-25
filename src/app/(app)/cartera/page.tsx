import type { Metadata } from "next";
import Link from "next/link";
import { BarChart3, Phone } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, EmptyState } from "@/components/ui/card";
import { formatMoney, formatPercent } from "@/core/money/format";
import { todayIn } from "@/core/time/calendar-date";
import { formatDate } from "@/core/time/format";
import { cn } from "@/lib/cn";
import { getOrganizationSettings, requireUser } from "@/server/auth/dal";
import {
  getOverduePortfolio,
  type PortfolioSort,
} from "@/server/collections/queries";

import { AgingChart } from "./aging-chart";

export const metadata: Metadata = { title: "Cartera" };

const SORTS: { value: PortfolioSort; label: string }[] = [
  { value: "days", label: "Más días vencido" },
  { value: "amount", label: "Mayor saldo" },
  { value: "oldest", label: "Más antiguo" },
];

export default async function PortfolioPage({
  searchParams,
}: PageProps<"/cartera">) {
  const user = await requireUser();
  const settings = await getOrganizationSettings();
  const today = todayIn(settings.timeZone);
  const params = await searchParams;

  const sort: PortfolioSort =
    params.orden === "amount" || params.orden === "oldest"
      ? params.orden
      : "days";

  const report = await getOverduePortfolio(user.organizationId, today, sort);
  const { totals } = report;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Cartera vencida</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {totals.overdueLoans} préstamos de {totals.overdueClients}{" "}
          {totals.overdueClients === 1 ? "cliente" : "clientes"}
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Figure
          label="Cartera total"
          value={formatMoney(totals.portfolioTotal)}
          hint="Capital más interés pendiente"
        />
        <Figure
          label="Cartera vencida"
          value={formatMoney(totals.overdueTotal)}
          tone="danger"
        />
        <Figure
          label="Índice de morosidad"
          value={formatPercent(totals.delinquencyRatio)}
          hint={
            totals.delinquencyRatio === null
              ? "No hay cartera pendiente que comparar"
              : "Vencida sobre cartera total"
          }
          tone={
            totals.delinquencyRatio !== null && totals.delinquencyRatio > 10
              ? "danger"
              : undefined
          }
        />
        <Figure
          label="Atraso promedio"
          value={
            totals.overdueLoans === 0
              ? "—"
              : `${totals.averageOverdueDays} ${totals.averageOverdueDays === 1 ? "día" : "días"}`
          }
        />
      </div>

      <Card>
        <CardHeader
          title="Antigüedad de cartera"
          description="Cuánto tiempo lleva vencida cada porción"
        />
        <AgingChart
          buckets={report.buckets.map((bucket) => ({
            label: bucket.label,
            loanCount: bucket.loanCount,
            clientCount: bucket.clientCount,
            amount: bucket.amount.toDatabaseString(),
          }))}
        />
      </Card>

      <Card>
        <CardHeader
          title="Préstamos vencidos"
          description={`Ordenado por ${SORTS.find((s) => s.value === sort)?.label.toLowerCase()}`}
          action={
            <div className="flex gap-1 rounded-[var(--radius-control)] border border-line bg-surface p-1">
              {SORTS.map((option) => (
                <Link
                  key={option.value}
                  href={
                    option.value === "days"
                      ? "/cartera"
                      : `/cartera?orden=${option.value}`
                  }
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    sort === option.value
                      ? "bg-accent-soft text-accent"
                      : "text-ink-muted hover:bg-surface-raised hover:text-ink",
                  )}
                >
                  {option.label}
                </Link>
              ))}
            </div>
          }
        />

        {report.rows.length === 0 ? (
          <EmptyState
            icon={<BarChart3 className="size-8" />}
            title="No hay cartera vencida"
            description="Todos los préstamos activos están al día."
          />
        ) : (
          <>
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left">
                    <Th>Cliente</Th>
                    <Th>Préstamo</Th>
                    <Th className="text-right">Capital</Th>
                    <Th className="text-right">Interés</Th>
                    <Th className="text-right">Total</Th>
                    <Th>Venció</Th>
                    <Th>Último pago</Th>
                    <Th>Antigüedad</Th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((row) => (
                    <tr
                      key={row.loanId}
                      className="border-b border-line/60 transition-colors last:border-0 hover:bg-surface-raised/60"
                    >
                      <td className="px-4 py-3">
                        <Link
                          href={`/clientes/${row.clientId}`}
                          className="font-medium text-ink hover:text-accent"
                        >
                          {row.clientName}
                        </Link>
                        {row.clientPhone && (
                          <p className="mt-0.5 inline-flex items-center gap-1 text-xs text-ink-subtle">
                            <Phone className="size-3" />
                            {row.clientPhone}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/prestamos/${row.loanId}`}
                          className="text-ink-muted hover:text-accent"
                        >
                          {row.loanCode}
                        </Link>
                      </td>
                      <td className="cc-tabular px-4 py-3 text-right text-ink-muted">
                        {formatMoney(row.principalOutstanding)}
                      </td>
                      <td className="cc-tabular px-4 py-3 text-right text-ink-muted">
                        {formatMoney(row.interestOutstanding)}
                      </td>
                      <td className="cc-tabular px-4 py-3 text-right font-medium text-ink">
                        {formatMoney(row.totalOutstanding)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-ink-muted">
                        {row.oldestDueOn ? formatDate(row.oldestDueOn) : "—"}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-ink-subtle">
                        {row.lastPaymentOn
                          ? formatDate(row.lastPaymentOn)
                          : "Nunca"}
                      </td>
                      <td className="px-4 py-3">
                        <Badge tone="danger">{row.bucketLabel}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <ul className="divide-y divide-line lg:hidden">
              {report.rows.map((row) => (
                <li key={row.loanId} className="px-5 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link
                        href={`/clientes/${row.clientId}`}
                        className="block truncate font-medium text-ink"
                      >
                        {row.clientName}
                      </Link>
                      <p className="mt-0.5 text-xs text-ink-subtle">
                        {row.loanCode}
                        {row.oldestDueOn &&
                          ` · venció ${formatDate(row.oldestDueOn)}`}
                      </p>
                    </div>
                    <Badge tone="danger">{row.bucketLabel}</Badge>
                  </div>

                  <div className="mt-3 flex items-baseline justify-between border-t border-line pt-3">
                    <span className="text-xs text-ink-subtle">
                      Total pendiente
                    </span>
                    <span className="cc-figure text-lg text-ink">
                      {formatMoney(row.totalOutstanding)}
                    </span>
                  </div>

                  <p className="mt-1 text-xs text-ink-subtle">
                    Capital {formatMoney(row.principalOutstanding)} · interés{" "}
                    {formatMoney(row.interestOutstanding)}
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
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

function Figure({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "danger";
}) {
  return (
    <Card className="p-5">
      <p className="text-[0.6875rem] font-medium tracking-wide text-ink-subtle uppercase">
        {label}
      </p>
      <p
        className={`cc-figure mt-2 text-2xl ${tone === "danger" ? "text-danger" : "text-ink"}`}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-ink-subtle">{hint}</p>}
    </Card>
  );
}
