import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, Wallet } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, EmptyState } from "@/components/ui/card";
import { formatMoney } from "@/core/money/format";
import { todayIn } from "@/core/time/calendar-date";
import { formatDate, formatDateLong } from "@/core/time/format";
import { getOrganizationSettings, requireUser } from "@/server/auth/dal";
import {
  getCashOverview,
  listClosures,
  listMovements,
} from "@/server/cash/queries";

import { CashActions } from "./cash-dialogs";

export const metadata: Metadata = { title: "Caja" };

export default async function CashPage() {
  const user = await requireUser();
  const settings = await getOrganizationSettings();
  const today = todayIn(settings.timeZone);

  const overview = await getCashOverview(user.organizationId, today);

  if (!overview) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card>
          <EmptyState
            icon={<Wallet className="size-8" />}
            title="No hay ninguna caja configurada"
            description="Ejecutá el seed o creá una caja en Configuración."
          />
        </Card>
      </div>
    );
  }

  const [movements, closures] = await Promise.all([
    listMovements(user.organizationId, { from: today, to: today, pageSize: 50 }),
    listClosures(user.organizationId, 12),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Caja</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {overview.accountName} · {formatDateLong(today)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <CashActions cashAccountId={overview.accountId} today={today} />
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-5 sm:col-span-1">
          <p className="text-[0.6875rem] font-medium tracking-wide text-ink-subtle uppercase">
            Saldo en caja
          </p>
          <p className="cc-figure mt-2 text-3xl text-ink">
            {formatMoney(overview.balance)}
          </p>
          <p className="mt-1 text-xs text-ink-subtle">Según el libro mayor</p>
        </Card>

        <Card className="p-5">
          <p className="text-[0.6875rem] font-medium tracking-wide text-ink-subtle uppercase">
            Entradas de hoy
          </p>
          <p className="cc-figure mt-2 text-2xl text-positive">
            +{formatMoney(overview.todayIn)}
          </p>
        </Card>

        <Card className="p-5">
          <p className="text-[0.6875rem] font-medium tracking-wide text-ink-subtle uppercase">
            Salidas de hoy
          </p>
          <p className="cc-figure mt-2 text-2xl text-info">
            −{formatMoney(overview.todayOut)}
          </p>
        </Card>
      </div>

      {overview.pendingSince && (
        <Card className="border-warning/25 bg-warning-soft/30 px-5 py-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <div>
              <p className="text-sm text-ink">
                Hay movimientos sin cerrar desde el{" "}
                {formatDate(overview.pendingSince)}
              </p>
              <p className="mt-0.5 text-xs text-ink-muted">
                El cierre diario deja constancia de cuánto había realmente en el
                cajón cada día.
              </p>
            </div>
          </div>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Movimientos de hoy"
          description={
            movements.rows.length === 0
              ? "Sin movimientos registrados"
              : `${movements.rows.length} movimientos`
          }
          action={
            <Link
              href="/movimientos"
              className="text-xs text-ink-muted transition-colors hover:text-accent"
            >
              Ver todos
            </Link>
          }
        />
        {movements.rows.length === 0 ? (
          <EmptyState
            title="Todavía no hay movimientos hoy"
            description="Los cobros, desembolsos y gastos del día aparecen acá."
          />
        ) : (
          <ul className="divide-y divide-line">
            {movements.rows.map((movement) => (
              <li
                key={movement.id}
                className="flex items-center gap-4 px-5 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-ink">
                      {movement.typeLabel}
                    </span>
                    {!movement.affectsCash && (
                      <Badge tone="neutral" showDot={false}>
                        No mueve caja
                      </Badge>
                    )}
                  </div>
                  {movement.note && (
                    <p className="mt-0.5 truncate text-xs text-ink-subtle">
                      {movement.note}
                    </p>
                  )}
                </div>
                <span
                  className={`cc-tabular shrink-0 text-sm ${
                    !movement.affectsCash
                      ? "text-ink-subtle"
                      : movement.direction === "IN"
                        ? "text-positive"
                        : "text-info"
                  }`}
                >
                  {movement.direction === "IN" ? "+" : "−"}
                  {formatMoney(movement.amount)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Cierres recientes"
          description="Cada cierre queda guardado de forma permanente"
        />
        {closures.length === 0 ? (
          <EmptyState
            title="Todavía no hay cierres"
            description="El primer cierre deja el punto de partida del control diario."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left">
                  <Th>Fecha</Th>
                  <Th className="text-right">Esperado</Th>
                  <Th className="text-right">Contado</Th>
                  <Th className="text-right">Diferencia</Th>
                  <Th>Cerró</Th>
                </tr>
              </thead>
              <tbody>
                {closures.map((closure) => {
                  const balanced = closure.difference.isZero();
                  return (
                    <tr
                      key={closure.id}
                      className="border-b border-line/60 last:border-0"
                    >
                      <td className="px-4 py-2.5 text-ink">
                        {formatDate(closure.closureDate)}
                      </td>
                      <td className="cc-tabular px-4 py-2.5 text-right text-ink-muted">
                        {formatMoney(closure.expectedBalance)}
                      </td>
                      <td className="cc-tabular px-4 py-2.5 text-right text-ink-muted">
                        {formatMoney(closure.countedBalance)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {balanced ? (
                          <Badge tone="positive">Cuadra</Badge>
                        ) : (
                          <Badge tone="danger">
                            {closure.difference.isNegative()
                              ? `Faltan ${formatMoney(closure.difference.abs())}`
                              : `Sobran ${formatMoney(closure.difference)}`}
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-ink-subtle">
                        {closure.closedByName ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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
