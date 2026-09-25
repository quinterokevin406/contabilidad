import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, RefreshCw } from "lucide-react";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardHeader, EmptyState } from "@/components/ui/card";
import {
  formatMoney,
  formatRate,
  type RatePeriodLabel,
} from "@/core/money/format";
import { todayIn } from "@/core/time/calendar-date";
import { formatDate } from "@/core/time/format";
import { requireUser, getOrganizationSettings } from "@/server/auth/dal";
import { getLoanDetail, getPaymentContext } from "@/server/loans/queries";

import { LifecycleActions } from "./lifecycle-dialogs";
import { PaymentDialog } from "./payment-dialog";

export async function generateMetadata({
  params,
}: PageProps<"/prestamos/[id]">): Promise<Metadata> {
  const { id } = await params;
  const user = await requireUser();
  const settings = await getOrganizationSettings();
  const loan = await getLoanDetail(
    user.organizationId,
    id,
    todayIn(settings.timeZone),
    settings,
  );
  return { title: loan?.code ?? "Préstamo" };
}

const STATE_TONE = {
  positive: "positive",
  warning: "warning",
  danger: "danger",
  info: "info",
  neutral: "neutral",
} as const satisfies Record<string, BadgeTone>;

const METHOD_LABEL: Record<string, string> = {
  SIMPLE_ON_ORIGINAL_PRINCIPAL: "Interés simple sobre capital original",
  SIMPLE_ON_OUTSTANDING_PRINCIPAL: "Interés sobre saldo pendiente",
};

const POLICY_LABEL: Record<string, string> = {
  NOT_CHARGED: "no se cobra",
  FULL_PERIOD: "se cobra completo",
  PRORATED: "se cobra proporcional",
};

const PERIOD_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  PENDING: { label: "Pendiente", tone: "warning" },
  PARTIALLY_PAID: { label: "Parcial", tone: "warning" },
  PAID: { label: "Pagado", tone: "positive" },
  WAIVED: { label: "Condonado", tone: "neutral" },
  SCHEDULED: { label: "Programado", tone: "neutral" },
};

export default async function LoanDetailPage({
  params,
}: PageProps<"/prestamos/[id]">) {
  const { id } = await params;
  const user = await requireUser();
  const settings = await getOrganizationSettings();
  const today = todayIn(settings.timeZone);

  const loan = await getLoanDetail(user.organizationId, id, today, settings);
  if (!loan) notFound();

  const paymentContext =
    loan.lifecycle === "ACTIVE"
      ? await getPaymentContext(user.organizationId, id)
      : null;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <Link
        href="/prestamos"
        className="inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-accent"
      >
        <ArrowLeft className="size-4" />
        Préstamos
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold text-ink">{loan.code}</h1>
            <Badge
              tone={STATE_TONE[loan.state.tone]}
              title={loan.state.explanation}
            >
              {loan.state.label}
            </Badge>
            {loan.renewalCount > 0 && (
              <span className="inline-flex items-center gap-1 text-xs text-ink-subtle">
                <RefreshCw className="size-3" />
                {loan.renewalCount}{" "}
                {loan.renewalCount === 1 ? "renovación" : "renovaciones"}
              </span>
            )}
          </div>
          <Link
            href={`/clientes/${loan.clientId}`}
            className="mt-1 inline-block text-sm text-ink-muted transition-colors hover:text-accent"
          >
            {loan.clientName}
          </Link>
          <p className="mt-1 text-sm text-ink-subtle">{loan.state.explanation}</p>
        </div>

        {paymentContext && (
          <div className="flex flex-wrap gap-2">
            <PaymentDialog
              loanId={loan.id}
              loanCode={loan.code}
              clientName={loan.clientName}
              outstandingPrincipal={loan.outstandingPrincipal.toDatabaseString()}
              outstandingInterest={loan.outstandingInterest.toDatabaseString()}
              allocationStrategy={loan.allocationStrategy}
              today={today}
              methods={paymentContext.methods}
            />
            <LifecycleActions
              loanId={loan.id}
              loanCode={loan.code}
              clientName={loan.clientName}
              today={today}
              outstandingPrincipal={loan.outstandingPrincipal.toDatabaseString()}
              outstandingInterest={loan.outstandingInterest.toDatabaseString()}
              openPeriodPolicy={loan.openPeriodPolicy}
              methods={paymentContext.methods}
            />
          </div>
        )}
      </header>

      {/* Point 54 header figures. */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Figure
          label="Capital original"
          value={formatMoney(loan.originalPrincipal)}
        />
        <Figure
          label="Capital pendiente"
          value={formatMoney(loan.outstandingPrincipal)}
        />
        <Figure
          label="Interés pendiente"
          value={formatMoney(loan.outstandingInterest)}
        />
        <Figure
          label="Total pendiente"
          value={formatMoney(loan.totalOutstanding)}
          emphasis
        />
      </div>

      <Card className="px-5 py-4">
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
          <Detail
            label="Tasa"
            value={formatRate(
              loan.ratePercent,
              loan.periodicity as RatePeriodLabel,
              { customPeriodDays: loan.customPeriodDays },
            )}
          />
          <Detail
            label="Método"
            value={METHOD_LABEL[loan.interestMethod] ?? loan.interestMethod}
          />
          <Detail label="Desembolsado" value={formatDate(loan.disbursedOn)} />
          <Detail
            label="Próximo vencimiento"
            value={
              loan.nextDueOn
                ? `${formatDate(loan.nextDueOn)} · ${loan.dueDistance?.label ?? ""}`
                : "—"
            }
            tone={loan.dueDistance?.tone === "overdue" ? "danger" : undefined}
          />
        </dl>
      </Card>

      {loan.settlementQuote && (
        <Card>
          <CardHeader
            title="Liquidación hoy"
            description="Lo que el cliente pagaría para cerrar el préstamo en este momento"
          />
          <div className="space-y-2.5 px-5 py-4">
            <Row
              label="Capital pendiente"
              value={formatMoney(loan.settlementQuote.principalOutstanding)}
            />
            <Row
              label="Interés causado"
              value={formatMoney(
                loan.settlementQuote.accruedInterestOutstanding,
              )}
            />
            <Row
              label={`Período en curso (${POLICY_LABEL[loan.openPeriodPolicy] ?? ""})`}
              value={formatMoney(loan.settlementQuote.openPeriodCharge)}
            />
            <div className="flex items-baseline justify-between border-t border-line pt-3">
              <span className="text-sm font-medium text-ink">
                Total para liquidar
              </span>
              <span className="cc-figure text-xl text-accent">
                {formatMoney(loan.settlementQuote.total)}
              </span>
            </div>
            <p className="pt-1 text-xs text-ink-subtle">
              {loan.settlementQuote.openPeriodExplanation}
            </p>
          </div>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Períodos"
          description="Cada período conserva la base y la tasa con que se calculó"
        />
        {loan.periods.length === 0 ? (
          <EmptyState
            title="Todavía no hay períodos causados"
            description={
              loan.nextDueOn
                ? `El primero vence el ${formatDate(loan.nextDueOn)}.`
                : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left">
                  <Th>#</Th>
                  <Th>Vencimiento</Th>
                  <Th className="text-right">Base</Th>
                  <Th className="text-right">Interés</Th>
                  <Th className="text-right">Pagado</Th>
                  <Th className="text-right">Pendiente</Th>
                  <Th>Estado</Th>
                </tr>
              </thead>
              <tbody>
                {loan.periods.map((period) => {
                  const status =
                    PERIOD_STATUS[period.status] ?? PERIOD_STATUS.PENDING!;
                  return (
                    <tr
                      key={period.id}
                      className="border-b border-line/60 last:border-0"
                    >
                      <td className="px-4 py-2.5 text-ink-subtle">
                        {period.periodIndex}
                      </td>
                      <td className="px-4 py-2.5 text-ink-muted">
                        {formatDate(period.dueOn)}
                      </td>
                      <td className="cc-tabular px-4 py-2.5 text-right text-ink-subtle">
                        {formatMoney(period.principalBasis)}
                      </td>
                      <td className="cc-tabular px-4 py-2.5 text-right text-ink-muted">
                        {formatMoney(period.interestAccrued)}
                      </td>
                      <td className="cc-tabular px-4 py-2.5 text-right text-positive">
                        {formatMoney(period.interestPaid)}
                      </td>
                      <td className="cc-tabular px-4 py-2.5 text-right text-ink">
                        {formatMoney(period.interestOutstanding)}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={status.tone}>{status.label}</Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Pagos"
          description="Cada pago muestra a dónde fue aplicado cada peso"
        />
        {loan.payments.length === 0 ? (
          <EmptyState title="Sin pagos registrados" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[38rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left">
                  <Th>Recibo</Th>
                  <Th>Fecha</Th>
                  <Th>Método</Th>
                  <Th className="text-right">Interés</Th>
                  <Th className="text-right">Capital</Th>
                  <Th className="text-right">Total</Th>
                </tr>
              </thead>
              <tbody>
                {loan.payments.map((payment) => (
                  <tr
                    key={payment.id}
                    className="border-b border-line/60 last:border-0"
                  >
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/recibos/${payment.id}`}
                        className="text-ink transition-colors hover:text-accent"
                      >
                        {payment.receiptNumber}
                      </Link>
                      {payment.status === "REVERSED" && (
                        <Badge tone="danger" className="ml-2">
                          Anulado
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-ink-muted">
                      {formatDate(payment.paidOn)}
                    </td>
                    <td className="px-4 py-2.5 text-ink-subtle">
                      {payment.methodName ?? "—"}
                    </td>
                    <td className="cc-tabular px-4 py-2.5 text-right text-positive">
                      {formatMoney(payment.interest)}
                    </td>
                    <td className="cc-tabular px-4 py-2.5 text-right text-info">
                      {formatMoney(payment.principal)}
                    </td>
                    <td className="cc-tabular px-4 py-2.5 text-right font-medium text-ink">
                      {formatMoney(payment.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="px-5 py-4">
        <p className="text-xs text-ink-subtle">
          Abonar a capital se hace desde <strong>Registrar pago</strong> con
          aplicación manual. Generar recibo en PDF llega en la fase de reportes.
        </p>
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
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <Card className="p-5">
      <p className="text-[0.6875rem] font-medium tracking-wide text-ink-subtle uppercase">
        {label}
      </p>
      <p
        className={`cc-figure mt-2 text-2xl ${emphasis ? "text-accent" : "text-ink"}`}
      >
        {value}
      </p>
    </Card>
  );
}

function Detail({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "danger";
}) {
  return (
    <div>
      <dt className="text-[0.6875rem] tracking-wide text-ink-subtle uppercase">
        {label}
      </dt>
      <dd
        className={`mt-0.5 text-sm ${tone === "danger" ? "text-danger" : "text-ink"}`}
      >
        {value}
      </dd>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-sm text-ink-muted">{label}</span>
      <span className="cc-tabular text-sm text-ink">{value}</span>
    </div>
  );
}
