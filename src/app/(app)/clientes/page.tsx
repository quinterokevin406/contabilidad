import type { Metadata } from "next";
import Link from "next/link";
import { MessageCircle, Phone, UserPlus, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, EmptyState } from "@/components/ui/card";
import { formatMoney } from "@/core/money/format";
import type { ClientStatus } from "@/generated/prisma";
import { requireUser } from "@/server/auth/dal";
import { clientSummary, listClients } from "@/server/clients/queries";

import { ClientFilters } from "./client-filters";

export const metadata: Metadata = { title: "Clientes" };

const STATUS_LABEL: Record<ClientStatus, string> = {
  ACTIVE: "Activo",
  INACTIVE: "Inactivo",
  BLOCKED: "Bloqueado",
};

const STATUS_TONE = {
  ACTIVE: "positive",
  INACTIVE: "neutral",
  BLOCKED: "danger",
} as const;

export default async function ClientsPage({
  searchParams,
}: PageProps<"/clientes">) {
  const user = await requireUser();

  // Next.js 16: request APIs are async-only.
  const params = await searchParams;

  const search = typeof params.q === "string" ? params.q : "";
  const status =
    typeof params.estado === "string" &&
    ["ACTIVE", "INACTIVE", "BLOCKED"].includes(params.estado)
      ? (params.estado as ClientStatus)
      : "ALL";
  const page = Number.parseInt(
    typeof params.pagina === "string" ? params.pagina : "1",
    10,
  );

  const [result, summary] = await Promise.all([
    listClients(user.organizationId, {
      search,
      status,
      page: Number.isFinite(page) ? page : 1,
    }),
    clientSummary(user.organizationId),
  ]);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Clientes</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {summary.total} registrados · {summary.active} activos
            {summary.blocked > 0 && ` · ${summary.blocked} bloqueados`}
          </p>
        </div>
        <Button variant="primary">
          <UserPlus />
          Nuevo cliente
        </Button>
      </header>

      <ClientFilters search={search} status={status} />

      {result.rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Users className="size-8" />}
            title={
              search || status !== "ALL"
                ? "Ningún cliente coincide con el filtro"
                : "Todavía no hay clientes"
            }
            description={
              search || status !== "ALL"
                ? "Probá con otro nombre, documento o teléfono."
                : "Creá el primero para empezar a registrar préstamos."
            }
            action={
              !search && status === "ALL" ? (
                <Button variant="primary">
                  <UserPlus />
                  Nuevo cliente
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          {/* Desktop: table. Below lg it would force horizontal scrolling on a
              phone, so the same data is re-laid out as cards. */}
          <Card className="hidden overflow-hidden lg:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left">
                  <Th>Cliente</Th>
                  <Th>Contacto</Th>
                  <Th className="text-center">Préstamos</Th>
                  <Th className="text-right">Capital pendiente</Th>
                  <Th className="text-right">Interés pendiente</Th>
                  <Th className="text-right">Total</Th>
                  <Th>Estado</Th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((client) => (
                  <tr
                    key={client.id}
                    className="border-b border-line/60 transition-colors last:border-0 hover:bg-surface-raised/60"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/clientes/${client.id}`}
                        className="font-medium text-ink hover:text-accent"
                      >
                        {client.fullName}
                      </Link>
                      <p className="mt-0.5 text-xs text-ink-subtle">
                        {client.code}
                        {client.documentNumber && ` · CC ${client.documentNumber}`}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-ink-muted">{client.phone ?? "—"}</p>
                      {client.city && (
                        <p className="mt-0.5 text-xs text-ink-subtle">
                          {client.city}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="text-ink">{client.activeLoans}</span>
                      {client.overdueLoans > 0 && (
                        <p className="mt-0.5 text-xs text-danger">
                          {client.overdueLoans} en mora
                        </p>
                      )}
                    </td>
                    <td className="cc-tabular px-4 py-3 text-right text-ink-muted">
                      {formatMoney(client.outstandingPrincipal)}
                    </td>
                    <td className="cc-tabular px-4 py-3 text-right text-ink-muted">
                      {formatMoney(client.outstandingInterest)}
                    </td>
                    <td className="cc-tabular px-4 py-3 text-right font-medium text-ink">
                      {formatMoney(client.totalOutstanding)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={STATUS_TONE[client.status]}>
                        {STATUS_LABEL[client.status]}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {/* Mobile and tablet */}
          <div className="space-y-3 lg:hidden">
            {result.rows.map((client) => (
              <Card key={client.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/clientes/${client.id}`}
                      className="block truncate font-medium text-ink"
                    >
                      {client.fullName}
                    </Link>
                    <p className="mt-0.5 truncate text-xs text-ink-subtle">
                      {client.code}
                      {client.city && ` · ${client.city}`}
                    </p>
                  </div>
                  <Badge tone={STATUS_TONE[client.status]}>
                    {STATUS_LABEL[client.status]}
                  </Badge>
                </div>

                <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-3">
                  <Stat label="Capital" value={formatMoney(client.outstandingPrincipal)} />
                  <Stat label="Interés" value={formatMoney(client.outstandingInterest)} />
                  <Stat
                    label="Total pendiente"
                    value={formatMoney(client.totalOutstanding)}
                    emphasis
                  />
                  <Stat
                    label="Préstamos"
                    value={
                      client.overdueLoans > 0
                        ? `${client.activeLoans} · ${client.overdueLoans} en mora`
                        : String(client.activeLoans)
                    }
                    tone={client.overdueLoans > 0 ? "danger" : undefined}
                  />
                </dl>

                {client.phone && (
                  <div className="mt-4 flex gap-2 border-t border-line pt-3">
                    <Button size="sm" variant="secondary" className="flex-1">
                      <Phone />
                      Llamar
                    </Button>
                    <Button size="sm" variant="secondary" className="flex-1">
                      <MessageCircle />
                      WhatsApp
                    </Button>
                  </div>
                )}
              </Card>
            ))}
          </div>

          {result.totalPages > 1 && (
            <nav className="flex items-center justify-between text-sm">
              <p className="text-ink-subtle">
                Página {result.page} de {result.totalPages} · {result.total}{" "}
                clientes
              </p>
              <div className="flex gap-2">
                <PageLink
                  page={result.page - 1}
                  disabled={result.page <= 1}
                  search={search}
                  status={status}
                >
                  Anterior
                </PageLink>
                <PageLink
                  page={result.page + 1}
                  disabled={result.page >= result.totalPages}
                  search={search}
                  status={status}
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

function Stat({
  label,
  value,
  emphasis,
  tone,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  tone?: "danger";
}) {
  return (
    <div>
      <dt className="text-[0.6875rem] tracking-wide text-ink-subtle uppercase">
        {label}
      </dt>
      <dd
        className={`cc-tabular mt-0.5 text-sm ${
          tone === "danger"
            ? "text-danger"
            : emphasis
              ? "font-semibold text-ink"
              : "text-ink-muted"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function PageLink({
  page,
  disabled,
  search,
  status,
  children,
}: {
  page: number;
  disabled: boolean;
  search: string;
  status: string;
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
  if (status !== "ALL") params.set("estado", status);
  params.set("pagina", String(page));

  return (
    <Link
      href={`/clientes?${params.toString()}`}
      className="rounded-[var(--radius-control)] border border-line-strong px-3 py-1.5 text-ink transition-colors hover:border-accent hover:text-accent"
    >
      {children}
    </Link>
  );
}
