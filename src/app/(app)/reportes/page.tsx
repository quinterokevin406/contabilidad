import type { Metadata } from "next";
import Link from "next/link";
import { FileText } from "lucide-react";

import { Card, CardHeader, EmptyState } from "@/components/ui/card";
import { formatMoney, formatPercent } from "@/core/money/format";
import { todayIn } from "@/core/time/calendar-date";
import { formatInstant } from "@/core/time/format";
import { cn } from "@/lib/cn";
import { prisma } from "@/infra/db/client";
import { getOrganizationSettings, requireUser } from "@/server/auth/dal";
import { calendarDate } from "@/core/time/calendar-date";
import type { ReportFilters } from "@/server/reports/definitions";
import { previewCell } from "@/server/reports/export";
import { findReport, REPORTS } from "@/server/reports/registry";

import { ReportControls } from "./report-controls";

export const metadata: Metadata = { title: "Reportes" };

/** How many rows the preview renders. The export never truncates. */
const PREVIEW_LIMIT = 100;

const STATUSES = [
  { value: "ALL", label: "Todos" },
  { value: "ACTIVE", label: "Activo" },
  { value: "PAID", label: "Pagado" },
  { value: "CANCELLED", label: "Cancelado" },
];

const CLIENT_STATUSES = [
  { value: "ALL", label: "Todos" },
  { value: "ACTIVE", label: "Activo" },
  { value: "INACTIVE", label: "Inactivo" },
  { value: "BLOCKED", label: "Bloqueado" },
];

const PERIODICITIES = [
  { value: "ALL", label: "Todas" },
  { value: "DAILY", label: "Diario" },
  { value: "WEEKLY", label: "Semanal" },
  { value: "BIWEEKLY", label: "Quincenal" },
  { value: "MONTHLY", label: "Mensual" },
  { value: "CUSTOM", label: "Personalizado" },
];

export default async function ReportsPage({
  searchParams,
}: PageProps<"/reportes">) {
  const user = await requireUser();
  const settings = await getOrganizationSettings();
  const params = await searchParams;

  const reportId =
    typeof params.reporte === "string" ? params.reporte : REPORTS[0]!.id;
  const report = findReport(reportId) ?? REPORTS[0]!;

  const raw = {
    from: typeof params.desde === "string" ? params.desde : "",
    to: typeof params.hasta === "string" ? params.hasta : "",
    clientId: typeof params.cliente === "string" ? params.cliente : "",
    status: typeof params.estado === "string" ? params.estado : "ALL",
    periodicity:
      typeof params.periodicidad === "string" ? params.periodicidad : "ALL",
  };

  const filters: ReportFilters = {};
  try {
    if (raw.from) filters.from = calendarDate(raw.from);
    if (raw.to) filters.to = calendarDate(raw.to);
  } catch {
    // A typed-in bad date just does not filter.
  }
  if (raw.clientId) filters.clientId = raw.clientId;
  if (raw.status !== "ALL") filters.status = raw.status;
  if (raw.periodicity !== "ALL") filters.periodicity = raw.periodicity;

  const [result, clients, organization] = await Promise.all([
    report.run(user.organizationId, filters),
    prisma.client.findMany({
      where: { organizationId: user.organizationId, archivedAt: null },
      orderBy: { fullName: "asc" },
      select: { id: true, fullName: true },
    }),
    prisma.organization.findUnique({
      where: { id: user.organizationId },
      select: { name: true },
    }),
  ]);

  const today = todayIn(settings.timeZone);
  const preview = result.rows.slice(0, PREVIEW_LIMIT);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="print:hidden">
        <h1 className="text-2xl font-semibold text-ink">Reportes</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {REPORTS.length} reportes · exportables a Excel y CSV
        </p>
      </header>

      {/* Report picker */}
      <div className="flex flex-wrap gap-2 print:hidden">
        {REPORTS.map((option) => (
          <Link
            key={option.id}
            href={`/reportes?reporte=${option.id}`}
            className={cn(
              "rounded-[var(--radius-control)] border px-3 py-1.5 text-xs font-medium transition-colors",
              option.id === report.id
                ? "border-accent bg-accent-soft text-accent"
                : "border-line text-ink-muted hover:border-line-strong hover:text-ink",
            )}
          >
            {option.label}
          </Link>
        ))}
      </div>

      <Card>
        <CardHeader
          title={report.label}
          description={report.description}
          className="print:border-b-0"
        />

        <div className="border-b border-line px-5 py-4 print:hidden">
          <ReportControls
            reportId={report.id}
            enabled={report.filters}
            clients={clients.map((c) => ({ value: c.id, label: c.fullName }))}
            statuses={report.id === "clientes" ? CLIENT_STATUSES : STATUSES}
            periodicities={PERIODICITIES}
            current={raw}
          />
        </div>

        {/* Print-only header, so a printed page says what it is. */}
        <div className="hidden px-5 py-4 print:block">
          <h2 className="text-base font-semibold">
            {report.label} — {organization?.name ?? settings.businessName}
          </h2>
          <p className="mt-0.5 text-xs">
            Generado el {formatInstant(new Date(), settings.timeZone)} ·{" "}
            {result.rows.length} registros
            {(raw.from || raw.to) &&
              ` · ${raw.from || "inicio"} a ${raw.to || today}`}
          </p>
        </div>

        {result.rows.length === 0 ? (
          <EmptyState
            icon={<FileText className="size-8" />}
            title="Sin datos para este reporte"
            description="Probá con otro rango de fechas o quitá los filtros."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm print:text-xs">
                <thead>
                  <tr className="border-b border-line text-left">
                    {report.columns.map((column) => (
                      <th
                        key={column.key}
                        className={cn(
                          "px-4 py-3 text-xs font-medium tracking-wide text-ink-subtle uppercase whitespace-nowrap",
                          (column.type === "money" ||
                            column.type === "number" ||
                            column.type === "percent") &&
                            "text-right",
                        )}
                      >
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.map((row, index) => (
                    <tr
                      key={index}
                      className="border-b border-line/60 last:border-0"
                    >
                      {report.columns.map((column) => {
                        const value = row[column.key];
                        return (
                          <td
                            key={column.key}
                            className={cn(
                              "px-4 py-2.5 whitespace-nowrap",
                              column.type === "money" ||
                                column.type === "number" ||
                                column.type === "percent"
                                ? "cc-tabular text-right text-ink"
                                : "text-ink-muted",
                            )}
                          >
                            {column.type === "money"
                              ? formatMoney(String(value ?? "0"))
                              : column.type === "percent"
                                ? formatPercent(
                                    value === null || value === undefined
                                      ? null
                                      : Number(value),
                                  )
                                : previewCell(value, column)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}

                  {result.totals && (
                    <tr className="border-t-2 border-line-strong font-medium">
                      {report.columns.map((column) => {
                        const value = result.totals?.[column.key];
                        return (
                          <td
                            key={column.key}
                            className={cn(
                              "px-4 py-3 whitespace-nowrap",
                              column.type === "money" ||
                                column.type === "number" ||
                                column.type === "percent"
                                ? "cc-tabular text-right text-ink"
                                : "text-ink",
                            )}
                          >
                            {value === null || value === undefined
                              ? ""
                              : column.type === "money"
                                ? formatMoney(String(value))
                                : String(value)}
                          </td>
                        );
                      })}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {result.rows.length > PREVIEW_LIMIT && (
              <p className="border-t border-line px-5 py-3 text-xs text-ink-subtle print:hidden">
                Mostrando {PREVIEW_LIMIT} de {result.rows.length} filas. La
                exportación incluye todas.
              </p>
            )}
          </>
        )}
      </Card>

      <Card className="px-5 py-4 print:hidden">
        <p className="text-xs text-ink-subtle">
          <strong className="text-ink-muted">Excel</strong> trae los valores como
          números reales con formato de pesos, así que podés sumar y ordenar
          columnas.{" "}
          <strong className="text-ink-muted">CSV</strong> sigue el estándar
          RFC 4180 para importar en otros sistemas.{" "}
          <strong className="text-ink-muted">Imprimir</strong> abre el diálogo del
          navegador, donde podés elegir "Guardar como PDF".
        </p>
      </Card>
    </div>
  );
}
