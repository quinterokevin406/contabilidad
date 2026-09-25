import type { Metadata } from "next";
import Link from "next/link";
import { Coins } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, EmptyState } from "@/components/ui/card";
import { formatMoney, formatPercent } from "@/core/money/format";
import { todayIn } from "@/core/time/calendar-date";
import { formatDate, formatMonthLong } from "@/core/time/format";
import { toParts } from "@/core/time/calendar-date";
import { getOrganizationSettings, requireUser } from "@/server/auth/dal";
import {
  getCategories,
  getExpenseBreakdown,
  getResultForPeriod,
  listMovements,
  monthWindow,
} from "@/server/cash/queries";

import { EntryActions } from "./entry-dialogs";

export const metadata: Metadata = { title: "Ingresos y egresos" };

export default async function MovementsPage({
  searchParams,
}: PageProps<"/movimientos">) {
  const user = await requireUser();
  const settings = await getOrganizationSettings();
  const today = todayIn(settings.timeZone);
  const params = await searchParams;

  const page = Number.parseInt(
    typeof params.pagina === "string" ? params.pagina : "1",
    10,
  );

  const { from, to } = monthWindow(today);
  const { year, month } = toParts(today);

  const [result, breakdown, movements, categories] = await Promise.all([
    getResultForPeriod(user.organizationId, from, to),
    getExpenseBreakdown(user.organizationId, from, to),
    listMovements(user.organizationId, {
      page: Number.isFinite(page) ? page : 1,
      pageSize: 40,
    }),
    getCategories(user.organizationId),
  ]);

  const expenseRatio = result.operatingIncome.isZero()
    ? null
    : result.operatingExpenses
        .toDecimal()
        .dividedBy(result.operatingIncome.toDecimal())
        .times(100);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Ingresos y egresos</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Resultado de {formatMonthLong(year, month)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <EntryActions
            today={today}
            expenseCategories={categories.expense}
            incomeCategories={categories.income}
          />
        </div>
      </header>

      {/* The result of the month, with the balance-sheet figures kept apart. */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Figure
          label="Intereses cobrados"
          value={formatMoney(result.interestIncome)}
          tone="positive"
        />
        <Figure
          label="Otros ingresos"
          value={formatMoney(result.otherOperatingIncome)}
        />
        <Figure
          label="Gastos operativos"
          value={formatMoney(result.operatingExpenses)}
          hint={
            result.badDebtExpense.isPositive()
              ? `Incluye ${formatMoney(result.badDebtExpense)} de cartera castigada`
              : undefined
          }
        />
        <Figure
          label="Utilidad neta"
          value={formatMoney(result.netProfit)}
          tone={result.netProfit.isNegative() ? "danger" : "accent"}
          hint={`Ratio de gastos: ${formatPercent(expenseRatio)}`}
        />
      </div>

      <Card className="px-5 py-4">
        <p className="text-xs text-ink-subtle">
          Estas cifras son el <strong className="text-ink-muted">resultado</strong>{" "}
          del negocio. El capital recuperado, los desembolsos y tus aportes o
          retiros no aparecen acá: mueven la caja y el patrimonio, pero no son
          ganancia ni gasto. Los ves en{" "}
          <Link href="/caja" className="text-accent hover:underline">
            Caja
          </Link>
          .
        </p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Gastos por categoría"
            description={formatMonthLong(year, month)}
          />
          {breakdown.rows.length === 0 ? (
            <EmptyState title="Sin gastos registrados este mes" />
          ) : (
            <ul className="divide-y divide-line">
              {breakdown.rows.map((row) => {
                const share = breakdown.total.isZero()
                  ? null
                  : row.amount
                      .toDecimal()
                      .dividedBy(breakdown.total.toDecimal())
                      .times(100);

                return (
                  <li key={row.categoryId} className="px-5 py-3">
                    <div className="flex items-baseline justify-between gap-4">
                      <span className="text-sm text-ink">{row.name}</span>
                      <span className="cc-tabular text-sm text-ink">
                        {formatMoney(row.amount)}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center gap-3">
                      <div
                        className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-raised"
                        role="presentation"
                      >
                        <div
                          className="h-full rounded-full bg-accent/70"
                          style={{
                            width: `${share ? Math.max(2, Number(share.toFixed(1))) : 0}%`,
                          }}
                        />
                      </div>
                      <span className="w-14 shrink-0 text-right text-xs text-ink-subtle">
                        {formatPercent(share, { decimals: 0 })}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Composición del resultado"
            description="De dónde viene y a dónde va"
          />
          <div className="space-y-3 px-5 py-4">
            <Line
              label="Intereses cobrados"
              value={formatMoney(result.interestIncome)}
              tone="positive"
            />
            <Line
              label="Otros ingresos operativos"
              value={formatMoney(result.otherOperatingIncome)}
              tone="positive"
            />
            <Line
              label="Gastos operativos"
              value={`−${formatMoney(result.operatingExpenses)}`}
              tone="danger"
            />
            <div className="flex items-baseline justify-between border-t border-line pt-3">
              <span className="text-sm font-medium text-ink">Utilidad neta</span>
              <span
                className={`cc-figure text-xl ${
                  result.netProfit.isNegative() ? "text-danger" : "text-accent"
                }`}
              >
                {formatMoney(result.netProfit)}
              </span>
            </div>

            <div className="space-y-2 border-t border-line pt-3">
              <p className="text-[0.6875rem] font-medium tracking-wide text-ink-subtle uppercase">
                Fuera del resultado
              </p>
              <Line
                label="Capital recuperado"
                value={formatMoney(result.principalRecovered)}
                muted
              />
              <Line
                label="Capital colocado"
                value={formatMoney(result.principalDisbursed)}
                muted
              />
              <Line
                label="Aportes del propietario"
                value={formatMoney(result.equityContributions)}
                muted
              />
              <Line
                label="Retiros del propietario"
                value={formatMoney(result.equityWithdrawals)}
                muted
              />
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Todos los movimientos"
          description={`${movements.total} registrados`}
        />
        {movements.rows.length === 0 ? (
          <EmptyState
            icon={<Coins className="size-8" />}
            title="Sin movimientos"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left">
                  <Th>Fecha</Th>
                  <Th>Tipo</Th>
                  <Th>Detalle</Th>
                  <Th className="text-right">Valor</Th>
                </tr>
              </thead>
              <tbody>
                {movements.rows.map((movement) => (
                  <tr
                    key={movement.id}
                    className="border-b border-line/60 last:border-0"
                  >
                    <td className="px-4 py-2.5 whitespace-nowrap text-ink-muted">
                      {formatDate(movement.occurredOn)}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="text-ink">{movement.typeLabel}</span>
                      {!movement.affectsCash && (
                        <Badge tone="neutral" showDot={false} className="ml-2">
                          No mueve caja
                        </Badge>
                      )}
                    </td>
                    <td className="max-w-md px-4 py-2.5">
                      <p className="truncate text-ink-subtle">
                        {movement.note ?? "—"}
                      </p>
                      {movement.loanCode && (
                        <Link
                          href={`/prestamos/${movement.loanId}`}
                          className="text-xs text-ink-subtle hover:text-accent"
                        >
                          {movement.loanCode}
                          {movement.clientName && ` · ${movement.clientName}`}
                        </Link>
                      )}
                    </td>
                    <td
                      className={`cc-tabular px-4 py-2.5 text-right whitespace-nowrap ${
                        !movement.affectsCash
                          ? "text-ink-subtle"
                          : movement.direction === "IN"
                            ? "text-positive"
                            : "text-info"
                      }`}
                    >
                      {movement.direction === "IN" ? "+" : "−"}
                      {formatMoney(movement.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {movements.totalPages > 1 && (
          <nav className="flex items-center justify-between border-t border-line px-5 py-3 text-sm">
            <p className="text-ink-subtle">
              Página {movements.page} de {movements.totalPages}
            </p>
            <div className="flex gap-2">
              <PageLink page={movements.page - 1} disabled={movements.page <= 1}>
                Anterior
              </PageLink>
              <PageLink
                page={movements.page + 1}
                disabled={movements.page >= movements.totalPages}
              >
                Siguiente
              </PageLink>
            </div>
          </nav>
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
  tone?: "positive" | "accent" | "danger";
}) {
  return (
    <Card className="p-5">
      <p className="text-[0.6875rem] font-medium tracking-wide text-ink-subtle uppercase">
        {label}
      </p>
      <p
        className={`cc-figure mt-2 text-2xl ${
          tone === "accent"
            ? "text-accent"
            : tone === "danger"
              ? "text-danger"
              : tone === "positive"
                ? "text-positive"
                : "text-ink"
        }`}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-ink-subtle">{hint}</p>}
    </Card>
  );
}

function Line({
  label,
  value,
  tone,
  muted,
}: {
  label: string;
  value: string;
  tone?: "positive" | "danger";
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className={`text-sm ${muted ? "text-ink-subtle" : "text-ink-muted"}`}>
        {label}
      </span>
      <span
        className={`cc-tabular text-sm ${
          muted
            ? "text-ink-subtle"
            : tone === "positive"
              ? "text-positive"
              : tone === "danger"
                ? "text-danger"
                : "text-ink"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function PageLink({
  page,
  disabled,
  children,
}: {
  page: number;
  disabled: boolean;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <span className="rounded-[var(--radius-control)] border border-line px-3 py-1.5 text-ink-subtle opacity-50">
        {children}
      </span>
    );
  }
  return (
    <Link
      href={`/movimientos?pagina=${page}`}
      className="rounded-[var(--radius-control)] border border-line-strong px-3 py-1.5 text-ink transition-colors hover:border-accent hover:text-accent"
    >
      {children}
    </Link>
  );
}
