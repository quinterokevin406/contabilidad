import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowDownLeft,
  ArrowLeft,
  ArrowUpRight,
  Clock,
  MapPin,
  Phone,
  RefreshCw,
} from "lucide-react";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, EmptyState } from "@/components/ui/card";
import { formatMoney, formatRate } from "@/core/money/format";
import { formatDate, formatDateShort } from "@/core/time/format";
import type { RatePeriodLabel } from "@/core/money/format";
import { requireUser } from "@/server/auth/dal";
import {
  getClientDetail,
  type TimelineEvent,
} from "@/server/clients/detail";
import { WhatsAppButton } from "./whatsapp-button";

export async function generateMetadata({
  params,
}: PageProps<"/clientes/[id]">): Promise<Metadata> {
  const user = await requireUser();
  const { id } = await params;
  const client = await getClientDetail(user.organizationId, id);
  return { title: client?.fullName ?? "Cliente" };
}

const STATE_TONE = {
  positive: "positive",
  warning: "warning",
  danger: "danger",
  info: "info",
  neutral: "neutral",
} as const satisfies Record<string, BadgeTone>;

export default async function ClientDetailPage({
  params,
}: PageProps<"/clientes/[id]">) {
  const user = await requireUser();
  const { id } = await params;

  const client = await getClientDetail(user.organizationId, id);
  if (!client) notFound();

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <Link
        href="/clientes"
        className="inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-accent"
      >
        <ArrowLeft className="size-4" />
        Clientes
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-ink">{client.fullName}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-muted">
            <span>{client.code}</span>
            {client.documentNumber && (
              <span>
                {client.documentType ?? "CC"} {client.documentNumber}
              </span>
            )}
            {client.phone && (
              <span className="inline-flex items-center gap-1.5">
                <Phone className="size-3.5" />
                {client.phone}
              </span>
            )}
            {client.city && (
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="size-3.5" />
                {client.city}
              </span>
            )}
          </div>
          {client.address && (
            <p className="mt-1 text-sm text-ink-subtle">{client.address}</p>
          )}
        </div>

        {client.whatsappPhone && (
          <WhatsAppButton
            phone={client.whatsappPhone}
            clientName={client.fullName}
            nextDueOn={client.activeLoans[0]?.nextDueOn ?? null}
            amountDue={
              client.activeLoans[0]
                ? client.activeLoans[0].outstandingInterest.toDatabaseString()
                : null
            }
          />
        )}
      </header>

      {client.notes && (
        <Card className="border-warning/25 bg-warning-soft/40 px-5 py-3">
          <p className="text-sm text-ink-muted">{client.notes}</p>
        </Card>
      )}

      {/* Point 8 totals. Every one derived from movement rows. */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Capital pendiente"
          value={formatMoney(client.principalOutstanding)}
        />
        <Stat
          label="Interés pendiente"
          value={formatMoney(client.interestOutstanding)}
        />
        <Stat
          label="Saldo total"
          value={formatMoney(client.totalOutstanding)}
          emphasis
        />
        <Stat
          label="Renovaciones"
          value={String(client.renewalCount)}
          hint={client.renewalCount === 1 ? "renovación" : "renovaciones"}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          small
          label="Capital recibido histórico"
          value={formatMoney(client.principalReceivedHistorical)}
        />
        <Stat
          small
          label="Intereses pagados histórico"
          value={formatMoney(client.interestPaidHistorical)}
        />
        <Stat
          small
          label="Total pagado"
          value={formatMoney(client.totalPaid)}
        />
      </div>

      <Card>
        <CardHeader
          title="Préstamos activos"
          description={
            client.activeLoans.length === 0
              ? "Sin préstamos vigentes"
              : `${client.activeLoans.length} vigente${client.activeLoans.length === 1 ? "" : "s"}`
          }
          action={<Button variant="primary" size="sm">Nuevo préstamo</Button>}
        />
        {client.activeLoans.length === 0 ? (
          <EmptyState
            title="Este cliente no tiene préstamos activos"
            description="Podés crear uno nuevo desde el botón de arriba."
          />
        ) : (
          <ul className="divide-y divide-line">
            {client.activeLoans.map((loan) => (
              <li key={loan.id}>
                <Link
                  href={`/prestamos/${loan.id}`}
                  className="flex flex-wrap items-center gap-4 px-5 py-4 transition-colors hover:bg-surface-raised/60"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">{loan.code}</span>
                      <Badge
                        tone={STATE_TONE[loan.state.tone]}
                        title={loan.state.explanation}
                      >
                        {loan.state.label}
                      </Badge>
                      {loan.renewalCount > 0 && (
                        <span className="inline-flex items-center gap-1 text-xs text-ink-subtle">
                          <RefreshCw className="size-3" />
                          {loan.renewalCount}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-ink-subtle">
                      {formatRate(
                        loan.ratePercent,
                        loan.periodicity as RatePeriodLabel,
                        { customPeriodDays: loan.customPeriodDays },
                      )}
                      {loan.nextDueOn && ` · vence ${formatDate(loan.nextDueOn)}`}
                    </p>
                  </div>
                  <div className="flex gap-6 text-right">
                    <div>
                      <p className="text-[0.6875rem] tracking-wide text-ink-subtle uppercase">
                        Capital
                      </p>
                      <p className="cc-tabular text-sm text-ink-muted">
                        {formatMoney(loan.outstandingPrincipal)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[0.6875rem] tracking-wide text-ink-subtle uppercase">
                        Interés
                      </p>
                      <p className="cc-tabular text-sm text-ink-muted">
                        {formatMoney(loan.outstandingInterest)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[0.6875rem] tracking-wide text-ink-subtle uppercase">
                        Total
                      </p>
                      <p className="cc-tabular text-sm font-medium text-ink">
                        {formatMoney(
                          loan.outstandingPrincipal.plus(loan.outstandingInterest),
                        )}
                      </p>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {client.closedLoans.length > 0 && (
        <Card>
          <CardHeader
            title="Préstamos finalizados"
            description={`${client.closedLoans.length} cerrado${client.closedLoans.length === 1 ? "" : "s"}`}
          />
          <ul className="divide-y divide-line">
            {client.closedLoans.map((loan) => (
              <li
                key={loan.id}
                className="flex items-center justify-between gap-4 px-5 py-3"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm text-ink-muted">{loan.code}</span>
                  <Badge
                    tone={STATE_TONE[loan.state.tone]}
                    title={loan.state.explanation}
                  >
                    {loan.state.label}
                  </Badge>
                </div>
                <span className="cc-tabular text-sm text-ink-subtle">
                  {formatMoney(loan.originalPrincipal)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Historial"
          description="Todos los movimientos, del más reciente al más antiguo"
        />
        {client.timeline.length === 0 ? (
          <EmptyState title="Sin movimientos registrados" />
        ) : (
          <ol className="divide-y divide-line">
            {client.timeline.map((event) => (
              <TimelineRow key={event.id} event={event} />
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}

function TimelineRow({ event }: { event: TimelineEvent }) {
  const flowStyles =
    event.flow === "in"
      ? { icon: <ArrowDownLeft className="size-4" />, tone: "text-positive" }
      : event.flow === "out"
        ? { icon: <ArrowUpRight className="size-4" />, tone: "text-info" }
        : { icon: <Clock className="size-4" />, tone: "text-ink-subtle" };

  return (
    <li className="flex items-start gap-4 px-5 py-3.5">
      <div className="w-16 shrink-0 pt-0.5">
        <p className="text-xs font-medium tracking-wide text-ink-subtle uppercase">
          {formatDateShort(event.date)}
        </p>
      </div>

      <div className={`mt-0.5 shrink-0 ${flowStyles.tone}`}>
        {flowStyles.icon}
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink">{event.title}</p>
        {event.detail && (
          <p className="mt-0.5 text-xs text-ink-subtle">{event.detail}</p>
        )}
      </div>

      {event.amount && (
        <p
          className={`cc-tabular shrink-0 text-sm ${
            event.flow === "in"
              ? "text-positive"
              : event.flow === "out"
                ? "text-info"
                : "text-ink-muted"
          }`}
        >
          {event.flow === "in" ? "+" : event.flow === "out" ? "−" : ""}
          {formatMoney(event.amount)}
        </p>
      )}
    </li>
  );
}

function Stat({
  label,
  value,
  hint,
  emphasis,
  small,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
  small?: boolean;
}) {
  return (
    <Card className={small ? "p-4" : "p-5"}>
      <p className="text-[0.6875rem] font-medium tracking-wide text-ink-subtle uppercase">
        {label}
      </p>
      <p
        className={`cc-figure mt-2 ${small ? "text-lg" : "text-2xl"} ${
          emphasis ? "text-accent" : "text-ink"
        }`}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-ink-subtle">{hint}</p>}
    </Card>
  );
}
