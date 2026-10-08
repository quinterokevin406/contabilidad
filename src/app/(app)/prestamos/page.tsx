import type { Metadata } from "next";
import Link from "next/link";
import { Banknote, Plus, RefreshCw } from "lucide-react";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, EmptyState } from "@/components/ui/card";
import { formatMoney, formatRate, type RatePeriodLabel } from "@/core/money/format";
import { formatDate } from "@/core/time/format";
import type { ComplianceStatus, LoanLifecycle } from "@/generated/prisma";
import { getOrganizationSettings, requireUser } from "@/server/auth/dal";
import { prisma } from "@/infra/db/client";
import { todayIn } from "@/core/time/calendar-date";
import { listLoans } from "@/server/loans/queries";

import { LoanFilters } from "./loan-filters";
import { NewLoanButton } from "./new-loan-dialog";

export const metadata: Metadata = { title: "Préstamos" };

const STATE_TONE = {
  positive: "positive",
  warning: "warning",
  danger: "danger",
  info: "info",
  neutral: "neutral",
} as const satisfies Record<string, BadgeTone>;

export default async function LoansPage({
  searchParams,
}: PageProps<"/prestamos">) {
  const user = await requireUser();
  const settings = await getOrganizationSettings();

  // The picker needs every client who can still take a loan, not just the page
  // of loans being shown.
  const clients = await prisma.client.findMany({
    where: { organizationId: user.organizationId, archivedAt: null },
    orderBy: { fullName: "asc" },
    select: { id: true, code: true, fullName: true },
  });
  const params = await searchParams;

  const search = typeof params.q === "string" ? params.q : "";
  const filter = typeof params.filtro === "string" ? params.filtro : "ACTIVE";
  const page = Number.parseInt(
    typeof params.pagina === "string" ? params.pagina : "1",
    10,
  );

  // One control drives two different columns: "vencidos" narrows compliance,
  // everything else narrows lifecycle.
  const lifecycle: LoanLifecycle | "ALL" =
    filter === "PAID" ? "PAID" : filter === "ALL" ? "ALL" : "ACTIVE";
  const compliance: ComplianceStatus | "ALL" =
    filter === "OVERDUE" ? "OVERDUE" : "ALL";

  const result = await listLoans(user.organizationId, {
    search,
    lifecycle,
    compliance,
    page: Number.isFinite(page) ? page : 1,
  });

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Préstamos</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {formatMoney(result.totals.outstandingPrincipal)} en capital ·{" "}
            {formatMoney(result.totals.outstandingInterest)} en interés pendiente
            {result.totals.overdueCount > 0 && (
              <>
                {" · "}
                <span className="text-danger">
                  {result.totals.overdueCount} en mora
                </span>
              </>
            )}
          </p>
        </div>
        <NewLoanButton
          clients={clients}
          today={todayIn(settings.timeZone)}
          defaultInterestMethod={settings.defaultInterestMethod}
          defaultPeriodicity={settings.defaultPeriodicity}
        />
      </header>

      <LoanFilters search={search} filter={filter} />

      {result.rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Banknote className="size-8" />}
            title="Ningún préstamo coincide con el filtro"
            description="Probá con otro término o cambiá el estado."
          />
        </Card>
      ) : (
        <>
          <Card className="hidden overflow-hidden lg:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left">
                  <Th>Préstamo</Th>
                  <Th>Cliente</Th>
                  <Th>Tasa</Th>
                  <Th>Vencimiento</Th>
                  <Th className="text-right">Capital</Th>
                  <Th className="text-right">Interés</Th>
                  <Th className="text-right">Total</Th>
                  <Th>Estado</Th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((loan) => (
                  <tr
                    key={loan.id}
                    className="border-b border-line/60 transition-colors last:border-0 hover:bg-surface-raised/60"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/prestamos/${loan.id}`}
                        className="font-medium text-ink hover:text-accent"
                      >
                        {loan.code}
                      </Link>
                      {loan.renewalCount > 0 && (
                        <p className="mt-0.5 inline-flex items-center gap-1 text-xs text-ink-subtle">
                          <RefreshCw className="size-3" />
                          {loan.renewalCount}{" "}
                          {loan.renewalCount === 1 ? "renovación" : "renovaciones"}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/clientes/${loan.clientId}`}
                        className="text-ink-muted hover:text-accent"
                      >
                        {loan.clientName}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-ink-muted">
                      {formatRate(
                        loan.ratePercent,
                        loan.periodicity as RatePeriodLabel,
                        { customPeriodDays: loan.customPeriodDays },
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {loan.nextDueOn ? (
                        <>
                          <span className="text-ink-muted">
                            {formatDate(loan.nextDueOn)}
                          </span>
                          {loan.daysOverdue > 0 && (
                            <p className="mt-0.5 text-xs text-danger">
                              {loan.daysOverdue}{" "}
                              {loan.daysOverdue === 1
                                ? "día vencido"
                                : "días vencidos"}
                            </p>
                          )}
                        </>
                      ) : (
                        <span className="text-ink-subtle">—</span>
                      )}
                    </td>
                    <td className="cc-tabular px-4 py-3 text-right text-ink-muted">
                      {formatMoney(loan.outstandingPrincipal)}
                    </td>
                    <td className="cc-tabular px-4 py-3 text-right text-ink-muted">
                      {formatMoney(loan.outstandingInterest)}
                    </td>
                    <td className="cc-tabular px-4 py-3 text-right font-medium text-ink">
                      {formatMoney(loan.totalOutstanding)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        tone={STATE_TONE[loan.state.tone]}
                        title={loan.state.explanation}
                      >
                        {loan.state.label}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <div className="space-y-3 lg:hidden">
            {result.rows.map((loan) => (
              <Link
                key={loan.id}
                href={`/prestamos/${loan.id}`}
                className="block"
              >
                <Card className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-ink">{loan.code}</p>
                      <p className="mt-0.5 truncate text-xs text-ink-subtle">
                        {loan.clientName}
                      </p>
                    </div>
                    <Badge
                      tone={STATE_TONE[loan.state.tone]}
                      title={loan.state.explanation}
                    >
                      {loan.state.label}
                    </Badge>
                  </div>

                  <div className="mt-3 flex items-baseline justify-between border-t border-line pt-3">
                    <span className="text-xs text-ink-subtle">
                      Total pendiente
                    </span>
                    <span className="cc-figure text-lg text-ink">
                      {formatMoney(loan.totalOutstanding)}
                    </span>
                  </div>

                  <p className="mt-2 text-xs text-ink-subtle">
                    {formatRate(
                      loan.ratePercent,
                      loan.periodicity as RatePeriodLabel,
                      { customPeriodDays: loan.customPeriodDays },
                    )}
                    {loan.nextDueOn && ` · vence ${formatDate(loan.nextDueOn)}`}
                  </p>
                </Card>
              </Link>
            ))}
          </div>

          {result.totalPages > 1 && (
            <nav className="flex items-center justify-between text-sm">
              <p className="text-ink-subtle">
                Página {result.page} de {result.totalPages} · {result.total}{" "}
                préstamos
              </p>
              <div className="flex gap-2">
                <PageLink
                  page={result.page - 1}
                  disabled={result.page <= 1}
                  search={search}
                  filter={filter}
                >
                  Anterior
                </PageLink>
                <PageLink
                  page={result.page + 1}
                  disabled={result.page >= result.totalPages}
                  search={search}
                  filter={filter}
                >
                  Siguiente
                </PageLink>
              </div>
            </nav>
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

function PageLink({
  page,
  disabled,
  search,
  filter,
  children,
}: {
  page: number;
  disabled: boolean;
  search: string;
  filter: string;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <span className="rounded-[var(--radius-control)] border border-line px-3 py-1.5 text-ink-subtle opacity-50">
        {children}
      </span>
    );
  }

  const params = new URLSearchParams();
  if (search) params.set("q", search);
  if (filter !== "ACTIVE") params.set("filtro", filter);
  params.set("pagina", String(page));

  return (
    <Link
      href={`/prestamos?${params.toString()}`}
      className="rounded-[var(--radius-control)] border border-line-strong px-3 py-1.5 text-ink transition-colors hover:border-accent hover:text-accent"
    >
      {children}
    </Link>
  );
}
