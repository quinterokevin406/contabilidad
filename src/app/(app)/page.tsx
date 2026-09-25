import type { Metadata } from "next";
import Link from "next/link";
import {
  AlertTriangle,
  Banknote,
  CalendarClock,
  PiggyBank,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatMoney, formatPercent } from "@/core/money/format";
import { Money } from "@/core/money/money";
import { todayIn, toPrismaDate } from "@/core/time/calendar-date";
import { formatDateLong } from "@/core/time/format";
import { requireUser, getOrganizationSettings } from "@/server/auth/dal";
import { getDashboardSummary } from "@/server/dashboard/summary";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const user = await requireUser();
  const settings = await getOrganizationSettings();

  const today = todayIn(settings.timeZone);
  const summary = await getDashboardSummary(
    user.organizationId,
    toPrismaDate(today),
  );

  const delinquency = summary.portfolioOutstanding.isZero()
    ? null
    : summary.overduePortfolio
        .toDecimal()
        .dividedBy(summary.portfolioOutstanding.toDecimal())
        .times(100);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-ink">
          Hola, {user.name.split(" ")[0]}
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          {formatDateLong(today)}
        </p>
      </header>

      {/* The three questions an operator opens the app to answer. */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Figure
          icon={<Wallet className="size-4" />}
          label="Capital disponible"
          value={formatMoney(summary.cashOnHand)}
          hint="Efectivo en caja"
        />
        <Figure
          icon={<Banknote className="size-4" />}
          label="Capital prestado"
          value={formatMoney(summary.principalOutstanding)}
          hint={`${summary.activeLoans} préstamos activos`}
        />
        <Figure
          icon={<TrendingUp className="size-4" />}
          label="Utilidad neta"
          value={formatMoney(summary.netProfit)}
          hint="Intereses e ingresos menos gastos"
          tone="accent"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Figure
          small
          label="Cartera pendiente"
          value={formatMoney(summary.portfolioOutstanding)}
          hint="Capital más interés"
        />
        <Figure
          small
          label="Intereses pendientes"
          value={formatMoney(summary.interestOutstanding)}
          hint="Devengado sin cobrar"
        />
        <Figure
          small
          label="Intereses cobrados"
          value={formatMoney(summary.interestCollected)}
          hint="Histórico"
        />
        <Figure
          small
          label="Gastos operativos"
          value={formatMoney(summary.operatingExpenses)}
          hint="Histórico"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-ink">
                Patrimonio del negocio
              </h2>
              <p className="mt-0.5 text-xs text-ink-muted">
                Separado del dinero prestado
              </p>
            </div>
          </div>
          <div className="space-y-3 px-5 py-4">
            <Row
              label="Capital aportado"
              value={formatMoney(summary.ownerContributions)}
            />
            <Row
              label="Utilidades generadas"
              value={formatMoney(summary.netProfit)}
              tone="positive"
            />
            <Row
              label="Retiros del propietario"
              value={`-${formatMoney(summary.ownerWithdrawals)}`}
              tone="muted"
            />
            <div className="flex items-baseline justify-between border-t border-line pt-3">
              <span className="text-sm font-medium text-ink">
                Patrimonio actual
              </span>
              <span className="cc-figure text-xl text-ink">
                {formatMoney(summary.equity)}
              </span>
            </div>
            <p className="pt-1 text-xs text-ink-subtle">
              De este patrimonio,{" "}
              <strong className="text-ink-muted">
                {formatMoney(summary.netProfit)}
              </strong>{" "}
              lo generó la operación y{" "}
              <strong className="text-ink-muted">
                {formatMoney(summary.ownerContributions)}
              </strong>{" "}
              proviene de aportes.
            </p>
          </div>
        </Card>

        <div className="space-y-4">
          <Card className="p-5">
            <div className="flex items-center gap-2 text-ink-muted">
              <CalendarClock className="size-4" />
              <span className="text-xs font-medium tracking-wide uppercase">
                Cobros de hoy
              </span>
            </div>
            <p className="cc-figure mt-3 text-2xl text-ink">
              {formatMoney(summary.dueTodayAmount)}
            </p>
            <p className="mt-1 text-xs text-ink-subtle">
              {summary.dueTodayCount === 0
                ? "Nada programado para hoy"
                : `${summary.dueTodayCount} ${summary.dueTodayCount === 1 ? "cobro" : "cobros"}`}
            </p>
          </Card>

          <Card className="p-5">
            <div className="flex items-center gap-2 text-ink-muted">
              <AlertTriangle className="size-4" />
              <span className="text-xs font-medium tracking-wide uppercase">
                Cartera vencida
              </span>
            </div>
            <p className="cc-figure mt-3 text-2xl text-danger">
              {formatMoney(summary.overduePortfolio)}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <Badge tone={summary.overdueLoans > 0 ? "danger" : "positive"}>
                {summary.overdueLoans}{" "}
                {summary.overdueLoans === 1 ? "préstamo" : "préstamos"}
              </Badge>
              <span className="text-xs text-ink-subtle">
                Índice de mora: {formatPercent(delinquency)}
              </span>
            </div>
          </Card>
        </div>
      </div>

      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <Link
            href="/clientes"
            className="flex items-center gap-2 text-sm text-ink-muted transition-colors hover:text-accent"
          >
            <Users className="size-4" />
            {summary.activeClients} clientes activos
          </Link>
          <span className="flex items-center gap-2 text-sm text-ink-muted">
            <PiggyBank className="size-4" />
            Capital colocado:{" "}
            {formatMoney(summary.principalOutstanding)}
          </span>
        </div>
        <p className="mt-4 border-t border-line pt-4 text-xs text-ink-subtle">
          El dashboard completo — gráficas de evolución, comparativos contra el
          mes anterior, salud de cartera y metas — llega en la fase de reportes.
        </p>
      </Card>
    </div>
  );
}

function Figure({
  icon,
  label,
  value,
  hint,
  tone,
  small,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  tone?: "accent";
  small?: boolean;
}) {
  return (
    <Card className={small ? "p-4" : "p-5"}>
      <div className="flex items-center gap-2 text-ink-muted">
        {icon}
        <span className="text-xs font-medium tracking-wide uppercase">
          {label}
        </span>
      </div>
      <p
        className={`cc-figure mt-3 ${small ? "text-xl" : "text-3xl"} ${
          tone === "accent" ? "text-accent" : "text-ink"
        }`}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-ink-subtle">{hint}</p>}
    </Card>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "positive" | "muted";
}) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-sm text-ink-muted">{label}</span>
      <span
        className={`cc-tabular text-sm ${
          tone === "positive"
            ? "text-positive"
            : tone === "muted"
              ? "text-ink-subtle"
              : "text-ink"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
