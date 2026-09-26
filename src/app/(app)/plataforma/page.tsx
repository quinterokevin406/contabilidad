import type { Metadata } from "next";
import { Building2, ShieldAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, EmptyState } from "@/components/ui/card";
import { formatInstant } from "@/core/time/format";
import { getOrganizationSettings, requirePlatformOwner } from "@/server/auth/dal";
import {
  listOrganizations,
  listStatusChanges,
} from "@/server/platform/queries";

import { StatusButton } from "./suspend-dialog";

export const metadata: Metadata = { title: "Plataforma" };

export default async function PlatformPage() {
  const owner = await requirePlatformOwner();
  const settings = await getOrganizationSettings();

  const [organizations, changes] = await Promise.all([
    listOrganizations(),
    listStatusChanges(),
  ]);

  const active = organizations.filter((o) => o.status === "ACTIVE").length;
  const suspended = organizations.length - active;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Plataforma</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {organizations.length}{" "}
          {organizations.length === 1 ? "negocio" : "negocios"} en este servidor
          {suspended > 0 && ` · ${suspended} suspendido${suspended === 1 ? "" : "s"}`}
        </p>
      </header>

      <Card className="flex items-start gap-3 border-info/25 bg-info-soft/20 px-5 py-4">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-info" />
        <p className="text-xs text-ink-muted">
          Esta es la única pantalla del sistema que ve más de una organización, y
          ve lo mínimo: nombres, estado, fechas y cantidades.{" "}
          <strong className="text-ink">Ningún saldo, ningún cliente, ningún peso.</strong>{" "}
          Lo que cada prestamista tiene en sus libros es asunto suyo.
        </p>
      </Card>

      <Card>
        <CardHeader
          title="Negocios"
          description={`${active} con acceso activo`}
        />

        {organizations.length === 0 ? (
          <EmptyState
            icon={<Building2 className="size-8" />}
            title="No hay negocios registrados"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-subtle">
                  <th className="px-5 py-2.5 font-medium">Negocio</th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    Usuarios
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    Clientes
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    Préstamos
                  </th>
                  <th className="px-3 py-2.5 font-medium">Último ingreso</th>
                  <th className="px-5 py-2.5 text-right font-medium">Acceso</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {organizations.map((organization) => (
                  <tr key={organization.id}>
                    <td className="px-5 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-ink">{organization.name}</span>
                        {organization.status === "SUSPENDED" && (
                          <Badge tone="danger">Suspendido</Badge>
                        )}
                        {organization.id === owner.organizationId && (
                          <Badge tone="neutral">Vos</Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-ink-subtle">
                        {organization.slug} · desde{" "}
                        {formatInstant(
                          organization.createdAt,
                          settings.timeZone,
                        )}
                      </p>
                    </td>
                    <td className="cc-tabular px-3 py-3 text-right text-ink-muted">
                      {organization.users}
                    </td>
                    <td className="cc-tabular px-3 py-3 text-right text-ink-muted">
                      {organization.clients}
                    </td>
                    <td className="cc-tabular px-3 py-3 text-right text-ink-muted">
                      {organization.loans}
                    </td>
                    <td className="px-3 py-3 text-xs text-ink-subtle">
                      {organization.lastActivityAt
                        ? formatInstant(
                            organization.lastActivityAt,
                            settings.timeZone,
                          )
                        : "Nunca"}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <StatusButton
                        organizationId={organization.id}
                        organizationName={organization.name}
                        suspended={organization.status === "SUSPENDED"}
                        isOwnOrganization={
                          organization.id === owner.organizationId
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {changes.length > 0 && (
        <Card>
          <CardHeader
            title="Suspensiones y reactivaciones"
            description="Cada cambio queda también en el historial del cliente"
          />
          <ul className="divide-y divide-line">
            {changes.map((change) => (
              <li key={change.id} className="px-5 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-ink">{change.summary ?? "—"}</p>
                    {change.reason && (
                      <p className="mt-0.5 text-xs text-ink-muted">
                        Motivo: {change.reason}
                      </p>
                    )}
                  </div>
                  <p className="shrink-0 text-xs text-ink-subtle">
                    {formatInstant(change.createdAt, settings.timeZone)}
                    {change.actorEmail && ` · ${change.actorEmail}`}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
