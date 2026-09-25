import type { Metadata } from "next";
import Link from "next/link";
import { History, Undo2 } from "lucide-react";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardHeader, EmptyState } from "@/components/ui/card";
import { calendarDate, todayIn } from "@/core/time/calendar-date";
import { formatInstant } from "@/core/time/format";
import type { AuditAction } from "@/generated/prisma";
import { cn } from "@/lib/cn";
import {
  auditEntities,
  listAudit,
  listReversals,
  reversiblePayments,
} from "@/server/audit/queries";
import { getOrganizationSettings, requireUser } from "@/server/auth/dal";

import { ReverseDialog } from "./reverse-dialog";

export const metadata: Metadata = { title: "Historial" };

const ACTION_TONE: Record<AuditAction, BadgeTone> = {
  CREATE: "positive",
  UPDATE: "info",
  REVERSE: "danger",
  ARCHIVE: "neutral",
  LOGIN: "neutral",
  LOGIN_FAILED: "warning",
  LOGOUT: "neutral",
  EXPORT: "warning",
  SETTINGS_CHANGE: "info",
};

const ACTIONS: { value: string; label: string }[] = [
  { value: "ALL", label: "Todo" },
  { value: "CREATE", label: "Creaciones" },
  { value: "UPDATE", label: "Modificaciones" },
  { value: "REVERSE", label: "Anulaciones" },
  { value: "EXPORT", label: "Exportaciones" },
  { value: "LOGIN_FAILED", label: "Intentos fallidos" },
];

export default async function AuditPage({
  searchParams,
}: PageProps<"/historial">) {
  const user = await requireUser();
  const settings = await getOrganizationSettings();
  const params = await searchParams;

  const action = typeof params.accion === "string" ? params.accion : "ALL";
  const entity = typeof params.entidad === "string" ? params.entidad : "";
  const page = Number.parseInt(
    typeof params.pagina === "string" ? params.pagina : "1",
    10,
  );

  const [result, entities, reversals, payments] = await Promise.all([
    listAudit(user.organizationId, {
      action: action as AuditAction | "ALL",
      entity: entity || undefined,
      page: Number.isFinite(page) ? page : 1,
    }),
    auditEntities(user.organizationId),
    listReversals(user.organizationId, 20),
    user.role === "ADMIN"
      ? reversiblePayments(user.organizationId, 40)
      : Promise.resolve([]),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Historial</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {result.total} eventos registrados
          </p>
        </div>
        {user.role === "ADMIN" && <ReverseDialog payments={payments} />}
      </header>

      <Card className="border-info/25 bg-info-soft/20 px-5 py-4">
        <p className="text-xs text-ink-muted">
          Nada financiero se elimina en este sistema. Una corrección se registra
          como <strong className="text-ink">anulación</strong>: el movimiento
          original queda marcado y se posta su contrario. Las dos caras siguen
          visibles acá para siempre.
        </p>
      </Card>

      {reversals.length > 0 && (
        <Card>
          <CardHeader
            title="Anulaciones"
            description={`${reversals.length} correcciones registradas`}
          />
          <ul className="divide-y divide-line">
            {reversals.map((reversal) => {
              const snapshot = reversal.snapshot;
              return (
                <li key={reversal.id} className="px-5 py-3.5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Undo2 className="size-3.5 text-danger" />
                        <span className="text-sm text-ink">
                          {typeof snapshot.receiptNumber === "string"
                            ? `Recibo ${snapshot.receiptNumber}`
                            : typeof snapshot.concept === "string"
                              ? String(snapshot.concept)
                              : "Movimiento"}
                        </span>
                        {typeof snapshot.clientName === "string" && (
                          <span className="text-xs text-ink-subtle">
                            {String(snapshot.clientName)}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-ink-muted">
                        {reversal.reason}
                      </p>
                    </div>
                    <div className="text-right">
                      {typeof snapshot.amount === "string" && (
                        <p className="cc-tabular text-sm text-danger line-through">
                          {snapshot.amount}
                        </p>
                      )}
                      <p className="mt-0.5 text-xs text-ink-subtle">
                        {formatInstant(reversal.createdAt, settings.timeZone)}
                        {reversal.userName && ` · ${reversal.userName}`}
                      </p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-[var(--radius-control)] border border-line bg-surface p-1">
          {ACTIONS.map((option) => (
            <Link
              key={option.value}
              href={buildHref({ accion: option.value, entidad: entity })}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                action === option.value
                  ? "bg-accent-soft text-accent"
                  : "text-ink-muted hover:bg-surface-raised hover:text-ink",
              )}
            >
              {option.label}
            </Link>
          ))}
        </div>

        {entities.length > 0 && (
          <div className="flex flex-wrap gap-1">
            <Link
              href={buildHref({ accion: action, entidad: "" })}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs transition-colors",
                !entity
                  ? "border-accent text-accent"
                  : "border-line text-ink-subtle hover:text-ink",
              )}
            >
              Todas
            </Link>
            {entities.map((option) => (
              <Link
                key={option.value}
                href={buildHref({ accion: action, entidad: option.value })}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs transition-colors",
                  entity === option.value
                    ? "border-accent text-accent"
                    : "border-line text-ink-subtle hover:text-ink",
                )}
              >
                {option.label} ({option.count})
              </Link>
            ))}
          </div>
        )}
      </div>

      <Card>
        {result.rows.length === 0 ? (
          <EmptyState
            icon={<History className="size-8" />}
            title="Sin eventos para este filtro"
          />
        ) : (
          <ul className="divide-y divide-line">
            {result.rows.map((row) => (
              <li key={row.id} className="px-5 py-3.5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={ACTION_TONE[row.action]}>
                        {row.actionLabel}
                      </Badge>
                      <span className="text-xs text-ink-subtle">
                        {row.entityLabel}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-ink">
                      {row.summary ?? "—"}
                    </p>
                    {row.reason && (
                      <p className="mt-0.5 text-xs text-ink-muted">
                        Motivo: {row.reason}
                      </p>
                    )}
                  </div>

                  <div className="shrink-0 text-right">
                    <p className="text-xs text-ink-muted">
                      {formatInstant(row.createdAt, settings.timeZone)}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-subtle">
                      {row.actorName ?? row.actorEmail ?? "Sistema"}
                      {row.ipAddress && ` · ${row.ipAddress}`}
                    </p>
                  </div>
                </div>

                {Boolean(row.beforeValues ?? row.afterValues) && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-ink-subtle hover:text-ink">
                      Ver valores
                    </summary>
                    <div className="mt-2 grid gap-3 sm:grid-cols-2">
                      {row.beforeValues ? (
                        <ValueBlock label="Antes" value={row.beforeValues} />
                      ) : null}
                      {row.afterValues ? (
                        <ValueBlock label="Después" value={row.afterValues} />
                      ) : null}
                    </div>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}

        {result.totalPages > 1 && (
          <nav className="flex items-center justify-between border-t border-line px-5 py-3 text-sm">
            <p className="text-ink-subtle">
              Página {result.page} de {result.totalPages}
            </p>
            <div className="flex gap-2">
              <PageLink
                page={result.page - 1}
                disabled={result.page <= 1}
                action={action}
                entity={entity}
              >
                Anterior
              </PageLink>
              <PageLink
                page={result.page + 1}
                disabled={result.page >= result.totalPages}
                action={action}
                entity={entity}
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

function buildHref(next: {
  accion?: string;
  entidad?: string;
  pagina?: number;
}): string {
  const params = new URLSearchParams();
  if (next.accion && next.accion !== "ALL") params.set("accion", next.accion);
  if (next.entidad) params.set("entidad", next.entidad);
  if (next.pagina && next.pagina > 1) params.set("pagina", String(next.pagina));
  const query = params.toString();
  return query ? `/historial?${query}` : "/historial";
}

function PageLink({
  page,
  disabled,
  action,
  entity,
  children,
}: {
  page: number;
  disabled: boolean;
  action: string;
  entity: string;
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
      href={buildHref({ accion: action, entidad: entity, pagina: page })}
      className="rounded-[var(--radius-control)] border border-line-strong px-3 py-1.5 text-ink transition-colors hover:border-accent hover:text-accent"
    >
      {children}
    </Link>
  );
}

function ValueBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="rounded-[var(--radius-control)] border border-line bg-canvas px-3 py-2">
      <p className="mb-1 text-[0.6875rem] tracking-wide text-ink-subtle uppercase">
        {label}
      </p>
      <pre className="overflow-x-auto text-[0.6875rem] whitespace-pre-wrap text-ink-muted">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
