"use client";

import { Search, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { cn } from "@/lib/cn";

/**
 * Search and status filter.
 *
 * Filter state lives in the URL, not in component state. That makes a filtered
 * view shareable, bookmarkable and survivable across a refresh — and it means
 * the server component above does the filtering, so the browser never receives
 * rows the operator is not looking at.
 */

const STATUSES = [
  { value: "ALL", label: "Todos" },
  { value: "ACTIVE", label: "Activos" },
  { value: "INACTIVE", label: "Inactivos" },
  { value: "BLOCKED", label: "Bloqueados" },
] as const;

export function ClientFilters({
  search,
  status,
}: {
  search: string;
  status: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(search);
  const firstRender = useRef(true);

  function push(next: URLSearchParams) {
    // Any filter change returns to the first page; staying on page 4 of a
    // narrower result set shows an empty screen that looks like a bug.
    next.delete("pagina");
    startTransition(() => {
      router.push(next.toString() ? `/clientes?${next}` : "/clientes");
    });
  }

  // Debounce typing so a search does not fire a request per keystroke.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }

    const timer = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (value.trim()) next.set("q", value.trim());
      else next.delete("q");
      push(next);
    }, 300);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function setStatus(nextStatus: string) {
    const next = new URLSearchParams(params.toString());
    if (nextStatus === "ALL") next.delete("estado");
    else next.set("estado", nextStatus);
    push(next);
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="relative flex-1 sm:max-w-sm">
        <Search
          className={cn(
            "pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 transition-colors",
            pending ? "text-accent" : "text-ink-subtle",
          )}
        />
        <input
          type="search"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Nombre, documento o teléfono…"
          aria-label="Buscar clientes"
          className={cn(
            "h-10 w-full rounded-[var(--radius-control)] border border-line bg-surface",
            "pr-9 pl-9 text-sm text-ink placeholder:text-ink-subtle",
            "transition-colors outline-none focus:border-accent/50",
          )}
        />
        {value && (
          <button
            type="button"
            onClick={() => setValue("")}
            aria-label="Limpiar búsqueda"
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-ink-subtle hover:text-ink"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      <div
        role="group"
        aria-label="Filtrar por estado"
        className="flex gap-1 rounded-[var(--radius-control)] border border-line bg-surface p-1"
      >
        {STATUSES.map((option) => {
          const active = status === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => setStatus(option.value)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                active
                  ? "bg-accent-soft text-accent"
                  : "text-ink-muted hover:bg-surface-raised hover:text-ink",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
