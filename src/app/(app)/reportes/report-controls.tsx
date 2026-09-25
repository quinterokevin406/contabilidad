"use client";

import { Download, FileSpreadsheet, Printer, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/**
 * Report filters and export controls (points 30 and 31).
 *
 * Filter state lives in the URL, so a filtered report is shareable and — the
 * part that matters — the export links carry exactly the same query string the
 * preview was built from. The file cannot contain rows the screen did not show.
 */

export interface FilterOption {
  value: string;
  label: string;
}

export interface ReportControlsProps {
  reportId: string;
  /** Which filters this report honours. */
  enabled: readonly string[];
  clients: FilterOption[];
  statuses: FilterOption[];
  periodicities: FilterOption[];
  current: {
    from: string;
    to: string;
    clientId: string;
    status: string;
    periodicity: string;
  };
}

const inputClass = cn(
  "h-9 rounded-[var(--radius-control)] border border-line bg-surface px-2.5",
  "text-sm text-ink transition-colors outline-none focus:border-accent/50",
);

const downloadBase = cn(
  "inline-flex h-8 items-center gap-2 rounded-[var(--radius-control)] px-3",
  "text-xs font-medium whitespace-nowrap transition-colors",
);

const downloadClass = {
  secondary: cn(
    downloadBase,
    "border border-line-strong bg-surface-raised text-ink hover:bg-surface-hover",
  ),
  primary: cn(
    downloadBase,
    "bg-accent font-semibold text-accent-ink hover:bg-accent-strong",
  ),
};

export function ReportControls({
  reportId,
  enabled,
  clients,
  statuses,
  periodicities,
  current,
}: ReportControlsProps) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function update(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    startTransition(() => {
      router.push(`/reportes?${next.toString()}`);
    });
  }

  function clearAll() {
    const next = new URLSearchParams();
    next.set("reporte", reportId);
    startTransition(() => {
      router.push(`/reportes?${next.toString()}`);
    });
  }

  // The export URL is the preview's own query string, so the two cannot diverge.
  const exportParams = new URLSearchParams(params.toString());
  exportParams.delete("reporte");

  function exportHref(format: "csv" | "xlsx") {
    const next = new URLSearchParams(exportParams.toString());
    next.set("formato", format);
    return `/api/reportes/${reportId}?${next.toString()}`;
  }

  const hasFilters =
    current.from || current.to || current.clientId || current.status || current.periodicity;

  return (
    <div className="space-y-3 print:hidden">
      <div className="flex flex-wrap items-end gap-3">
        {enabled.includes("from") && (
          <Field label="Desde" htmlFor="from">
            <input
              id="from"
              type="date"
              value={current.from}
              onChange={(event) => update("desde", event.target.value)}
              className={inputClass}
            />
          </Field>
        )}

        {enabled.includes("to") && (
          <Field label="Hasta" htmlFor="to">
            <input
              id="to"
              type="date"
              value={current.to}
              onChange={(event) => update("hasta", event.target.value)}
              className={inputClass}
            />
          </Field>
        )}

        {enabled.includes("clientId") && (
          <Field label="Cliente" htmlFor="client">
            <select
              id="client"
              value={current.clientId}
              onChange={(event) => update("cliente", event.target.value)}
              className={cn(inputClass, "max-w-52")}
            >
              <option value="">Todos</option>
              {clients.map((client) => (
                <option key={client.value} value={client.value}>
                  {client.label}
                </option>
              ))}
            </select>
          </Field>
        )}

        {enabled.includes("status") && (
          <Field label="Estado" htmlFor="status">
            <select
              id="status"
              value={current.status}
              onChange={(event) => update("estado", event.target.value)}
              className={inputClass}
            >
              {statuses.map((status) => (
                <option key={status.value} value={status.value}>
                  {status.label}
                </option>
              ))}
            </select>
          </Field>
        )}

        {enabled.includes("periodicity") && (
          <Field label="Periodicidad" htmlFor="periodicity">
            <select
              id="periodicity"
              value={current.periodicity}
              onChange={(event) => update("periodicidad", event.target.value)}
              className={inputClass}
            >
              {periodicities.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        )}

        {hasFilters && (
          <button
            type="button"
            onClick={clearAll}
            className="mb-0.5 inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-ink-subtle transition-colors hover:text-ink"
          >
            <X className="size-3.5" />
            Limpiar
          </button>
        )}

        <div className="mb-0.5 ml-auto flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => window.print()}>
            <Printer />
            Imprimir / PDF
          </Button>
          {/* Real anchors, not buttons in a link: a download is a navigation,
              and the browser handles it natively including resume and retry. */}
          <a href={exportHref("csv")} download className={downloadClass.secondary}>
            <Download className="size-3.5" />
            CSV
          </a>
          <a href={exportHref("xlsx")} download className={downloadClass.primary}>
            <FileSpreadsheet className="size-3.5" />
            Excel
          </a>
        </div>
      </div>

      {pending && (
        <p className="text-xs text-accent">Actualizando…</p>
      )}
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1 block text-[0.6875rem] tracking-wide text-ink-subtle uppercase"
      >
        {label}
      </label>
      {children}
    </div>
  );
}
