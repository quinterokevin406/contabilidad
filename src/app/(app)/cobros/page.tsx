import type { Metadata } from "next";
import Link from "next/link";
import { CalendarClock, CheckCircle2, Phone } from "lucide-react";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardHeader, EmptyState } from "@/components/ui/card";
import { formatMoney } from "@/core/money/format";
import { todayIn } from "@/core/time/calendar-date";
import { formatDate, formatDateLong } from "@/core/time/format";
import { getOrganizationSettings, requireUser } from "@/server/auth/dal";
import {
  getCollectionsSummary,
  type CollectionRow,
} from "@/server/collections/queries";

export const metadata: Metadata = { title: "Cobros" };

const STATUS: Record<
  CollectionRow["status"],
  { label: string; tone: BadgeTone }
> = {
  PAID: { label: "Pagado", tone: "positive" },
  PENDING: { label: "Pendiente", tone: "warning" },
  OVERDUE: { label: "Vencido", tone: "danger" },
};

export default async function CollectionsPage() {
  const user = await requireUser();
  const settings = await getOrganizationSettings();
  const today = todayIn(settings.timeZone);

  const summary = await getCollectionsSummary(user.organizationId, today);
  const { totals } = summary;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Cobros</h1>
        <p className="mt-1 text-sm text-ink-muted">{formatDateLong(today)}</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Figure
          label="Para cobrar hoy"
          value={formatMoney(totals.todayPending)}
          hint={`${summary.today.filter((r) => r.status !== "PAID").length} pendientes`}
          tone="accent"
        />
        <Figure
          label="Cobrado hoy"
          value={formatMoney(totals.todayCollected)}
          hint={`de ${formatMoney(totals.todayExpected)} esperados`}
          tone="positive"
        />
        <Figure
          label="Vencido acumulado"
          value={formatMoney(totals.overdue)}
          hint={`${summary.overdue.length} períodos sin pagar`}
          tone={totals.overdue.isPositive() ? "danger" : undefined}
        />
        <Figure
          label="Esta semana"
          value={formatMoney(totals.week)}
          hint="Hoy más los próximos 6 días"
        />
      </div>

      <Card>
        <CardHeader
          title="Cobros de hoy"
          description={
            summary.today.length === 0
              ? "Nada programado para hoy"
              : `${summary.today.length} ${summary.today.length === 1 ? "cobro" : "cobros"}`
          }
        />
        {summary.today.length === 0 ? (
          <EmptyState
            icon={<CalendarClock className="size-8" />}
            title="No hay cobros programados para hoy"
            description="Los vencimientos del día aparecen acá apenas se causan."
          />
        ) : (
          <CollectionList rows={summary.today} />
        )}
      </Card>

      {summary.overdue.length > 0 && (
        <Card>
          <CardHeader
            title="Vencidos de días anteriores"
            description={`${formatMoney(totals.overdue)} sin cobrar`}
            action={
              <Link
                href="/cartera"
                className="text-xs text-ink-muted transition-colors hover:text-accent"
              >
                Ver cartera
              </Link>
            }
          />
          <CollectionList rows={summary.overdue.slice(0, 15)} showDate />
          {summary.overdue.length > 15 && (
            <div className="border-t border-line px-5 py-3 text-center">
              <Link
                href="/cartera"
                className="text-xs text-accent hover:underline"
              >
                Ver los {summary.overdue.length - 15} restantes en Cartera
              </Link>
            </div>
          )}
        </Card>
      )}

      <Card>
        <CardHeader
          title="Mañana"
          description={
            summary.tomorrow.length === 0
              ? "Nada programado"
              : `${formatMoney(totals.tomorrow)} en ${summary.tomorrow.length} ${
                  summary.tomorrow.length === 1 ? "cobro" : "cobros"
                }`
          }
        />
        {summary.tomorrow.length === 0 ? (
          <EmptyState title="Sin vencimientos mañana" />
        ) : (
          <CollectionList rows={summary.tomorrow} />
        )}
      </Card>
    </div>
  );
}

function CollectionList({
  rows,
  showDate,
}: {
  rows: CollectionRow[];
  showDate?: boolean;
}) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((row) => {
        const status = STATUS[row.status];
        return (
          <li key={row.key}>
            <Link
              href={`/prestamos/${row.loanId}`}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5 transition-colors hover:bg-surface-raised/60"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{row.clientName}</span>
                  <Badge tone={status.tone}>{status.label}</Badge>
                  {row.isProjection && (
                    <Badge tone="neutral" showDot={false}>
                      Proyectado
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-ink-subtle">
                  {row.loanCode}
                  {showDate && ` · venció ${formatDate(row.dueOn)}`}
                  {row.daysOverdue > 0 &&
                    ` · ${row.daysOverdue} ${row.daysOverdue === 1 ? "día" : "días"}`}
                  {row.clientPhone && (
                    <span className="ml-2 inline-flex items-center gap-1">
                      <Phone className="size-3" />
                      {row.clientPhone}
                    </span>
                  )}
                </p>
              </div>

              <div className="text-right">
                {row.status === "PAID" ? (
                  <span className="inline-flex items-center gap-1.5 text-sm text-positive">
                    <CheckCircle2 className="size-4" />
                    {formatMoney(row.amount)}
                  </span>
                ) : (
                  <>
                    <p className="cc-figure text-base text-ink">
                      {formatMoney(row.outstanding)}
                    </p>
                    {!row.outstanding.equals(row.amount) && (
                      <p className="text-xs text-ink-subtle">
                        de {formatMoney(row.amount)}
                      </p>
                    )}
                  </>
                )}
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
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
  tone?: "accent" | "positive" | "danger";
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
            : tone === "positive"
              ? "text-positive"
              : tone === "danger"
                ? "text-danger"
                : "text-ink"
        }`}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-ink-subtle">{hint}</p>}
    </Card>
  );
}
