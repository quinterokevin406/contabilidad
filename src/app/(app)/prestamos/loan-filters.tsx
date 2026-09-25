"use client";

import { Search, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { cn } from "@/lib/cn";

/** Search and status filter for the loan list. State lives in the URL. */

const FILTERS = [
  { value: "ACTIVE", label: "Activos" },
  { value: "OVERDUE", label: "Vencidos" },
  { value: "PAID", label: "Pagados" },
  { value: "ALL", label: "Todos" },
] as const;

export function LoanFilters({
  search,
  filter,
}: {
  search: string;
  filter: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(search);
  const firstRender = useRef(true);

  function push(next: URLSearchParams) {
    next.delete("pagina");
    startTransition(() => {
      router.push(next.toString() ? `/prestamos?${next}` : "/prestamos");
    });
  }

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

  function setFilter(nextFilter: string) {
    const next = new URLSearchParams(params.toString());
    if (nextFilter === "ACTIVE") next.delete("filtro");
    else next.set("filtro", nextFilter);
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
          placeholder="Código, cliente o documento…"
          aria-label="Buscar préstamos"
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
        aria-label="Filtrar préstamos"
        className="flex gap-1 rounded-[var(--radius-control)] border border-line bg-surface p-1"
      >
        {FILTERS.map((option) => {
          const active = filter === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => setFilter(option.value)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                active
                  ? option.value === "OVERDUE"
                    ? "bg-danger-soft text-danger"
                    : "bg-accent-soft text-accent"
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
