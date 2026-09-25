import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatMoney } from "@/core/money/format";
import { formatDateLong, formatInstant } from "@/core/time/format";
import { getOrganizationSettings, requireUser } from "@/server/auth/dal";
import { getReceipt } from "@/server/receipts/queries";

import { ReceiptActions } from "./receipt-actions";

export async function generateMetadata({
  params,
}: PageProps<"/recibos/[id]">): Promise<Metadata> {
  const { id } = await params;
  const user = await requireUser();
  const receipt = await getReceipt(user.organizationId, id);
  return { title: receipt ? `Recibo ${receipt.receiptNumber}` : "Recibo" };
}

export default async function ReceiptPage({
  params,
}: PageProps<"/recibos/[id]">) {
  const { id } = await params;
  const user = await requireUser();
  const settings = await getOrganizationSettings();

  const receipt = await getReceipt(user.organizationId, id);
  if (!receipt) notFound();

  const shareText =
    `Recibo ${receipt.receiptNumber}\n` +
    `${receipt.organizationName}\n\n` +
    `Cliente: ${receipt.clientName}\n` +
    `Fecha: ${formatDateLong(receipt.paidOn)}\n` +
    `Recibido: ${formatMoney(receipt.amount)}\n` +
    `A intereses: ${formatMoney(receipt.appliedToInterest)}\n` +
    `A capital: ${formatMoney(receipt.appliedToPrincipal)}\n\n` +
    `Saldo de capital: ${formatMoney(receipt.principalAfter)}\n` +
    `Intereses pendientes: ${formatMoney(receipt.interestAfter)}\n` +
    `Saldo total: ${formatMoney(receipt.totalAfter)}`;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link
          href={`/prestamos/${receipt.loanId}`}
          className="inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors hover:text-accent"
        >
          <ArrowLeft className="size-4" />
          Volver al préstamo
        </Link>
        <ReceiptActions shareText={shareText} phone={receipt.clientPhone} />
      </div>

      {receipt.status === "REVERSED" && (
        <Card className="border-danger/30 bg-danger-soft/30 px-5 py-4">
          <p className="text-sm font-medium text-danger">
            Este recibo fue anulado
          </p>
          {receipt.reversedReason && (
            <p className="mt-1 text-xs text-ink-muted">
              Motivo: {receipt.reversedReason}
            </p>
          )}
        </Card>
      )}

      <Card className="px-6 py-6 print:border-0 print:shadow-none">
        <header className="flex items-start justify-between gap-4 border-b border-line pb-5">
          <div>
            <h1 className="text-lg font-semibold text-ink">
              {receipt.organizationName}
            </h1>
            <p className="mt-0.5 text-xs text-ink-muted">
              Comprobante de pago
            </p>
          </div>
          <div className="text-right">
            <p className="text-[0.6875rem] tracking-wide text-ink-subtle uppercase">
              Recibo
            </p>
            <p className="cc-tabular text-base font-semibold text-ink">
              {receipt.receiptNumber}
            </p>
            {receipt.status === "REVERSED" && (
              <Badge tone="danger" className="mt-1">
                Anulado
              </Badge>
            )}
          </div>
        </header>

        <dl className="grid gap-x-8 gap-y-3 border-b border-line py-5 sm:grid-cols-2">
          <Field label="Cliente" value={receipt.clientName} />
          <Field label="Fecha" value={formatDateLong(receipt.paidOn)} />
          {receipt.clientDocument && (
            <Field label="Documento" value={receipt.clientDocument} />
          )}
          <Field label="Préstamo" value={receipt.loanCode} />
          {receipt.methodName && (
            <Field label="Método de pago" value={receipt.methodName} />
          )}
          {receipt.clientPhone && (
            <Field label="Teléfono" value={receipt.clientPhone} />
          )}
        </dl>

        {/* What was received, and exactly where every peso went. */}
        <div className="border-b border-line py-5">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-ink-muted">Valor recibido</span>
            <span className="cc-figure text-2xl text-ink">
              {formatMoney(receipt.amount)}
            </span>
          </div>

          <dl className="mt-4 space-y-2">
            <Row
              label="Aplicado a intereses"
              value={formatMoney(receipt.appliedToInterest)}
            />
            <Row
              label="Aplicado a capital"
              value={formatMoney(receipt.appliedToPrincipal)}
            />
            {receipt.appliedToFees.isPositive() && (
              <Row
                label="Otros conceptos"
                value={formatMoney(receipt.appliedToFees)}
              />
            )}
          </dl>
        </div>

        {/* Balances as they stood right after this payment. */}
        <div className="py-5">
          <p className="mb-3 text-[0.6875rem] font-medium tracking-wide text-ink-subtle uppercase">
            Saldo después de este pago
          </p>
          <dl className="space-y-2">
            <Row
              label="Saldo de capital"
              value={formatMoney(receipt.principalAfter)}
            />
            <Row
              label="Intereses pendientes"
              value={formatMoney(receipt.interestAfter)}
            />
            <div className="flex items-baseline justify-between border-t border-line pt-3">
              <span className="text-sm font-medium text-ink">
                Saldo total pendiente
              </span>
              <span className="cc-figure text-lg text-ink">
                {formatMoney(receipt.totalAfter)}
              </span>
            </div>
          </dl>
        </div>

        {receipt.notes && (
          <div className="border-t border-line pt-4">
            <p className="text-[0.6875rem] tracking-wide text-ink-subtle uppercase">
              Observaciones
            </p>
            <p className="mt-1 text-sm text-ink-muted">{receipt.notes}</p>
          </div>
        )}

        <footer className="mt-5 border-t border-line pt-4 text-xs text-ink-subtle">
          <p>
            Registrado el {formatInstant(receipt.postedAt, settings.timeZone)}
            {receipt.createdByName && ` por ${receipt.createdByName}`}
          </p>
          <p className="mt-1">
            Los saldos corresponden al momento de este pago.
          </p>
        </footer>
      </Card>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[0.6875rem] tracking-wide text-ink-subtle uppercase">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm text-ink">{value}</dd>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd className="cc-tabular text-sm text-ink">{value}</dd>
    </div>
  );
}
