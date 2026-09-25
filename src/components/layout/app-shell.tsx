"use client";

import { ChevronLeft, LogOut, Menu, Search, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import type { UserRole } from "@/generated/prisma";

import { isActivePath, navigationFor } from "./navigation";

/**
 * The application shell: sidebar, top bar and content area.
 *
 * One component drives both layouts. On desktop the sidebar collapses to icons;
 * below `lg` it becomes an overlay drawer (point 39). Keeping them unified means
 * a nav entry can never exist on one and be forgotten on the other.
 */

const COLLAPSE_KEY = "cc.sidebar.collapsed";

export interface AppShellProps {
  user: { name: string; email: string; role: UserRole };
  organizationName: string;
  onLogout: () => void;
  children: ReactNode;
}

export function AppShell({
  user,
  organizationName,
  onLogout,
  children,
}: AppShellProps) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const sections = navigationFor(user.role);

  // Restore the collapse preference. localStorage is right for a per-device UI
  // preference and wrong for anything financial, which all lives server-side.
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "true");
    } catch {
      // Private mode or blocked storage: the default is fine.
    }
  }, []);

  function toggleCollapsed() {
    setCollapsed((previous) => {
      const next = !previous;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, String(next));
      } catch {
        // Not worth surfacing; the session still works.
      }
      return next;
    });
  }

  // Navigating closes the mobile drawer, otherwise it stays over the new page.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Escape closes the drawer, as any overlay should.
  useEffect(() => {
    if (!drawerOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setDrawerOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  const nav = (
    <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
      {sections.map((section, index) => (
        <div key={section.label ?? `section-${index}`}>
          {section.label && !collapsed && (
            <p className="mb-2 px-3 text-[0.6875rem] font-semibold tracking-wider text-ink-subtle uppercase">
              {section.label}
            </p>
          )}
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const active = isActivePath(item.href, pathname);
              const Icon = item.icon;

              // Not built yet: shown so the operator sees the shape of the
              // product, but never linked. A dead click is worse than an honest
              // label.
              if (item.pending) {
                return (
                  <li key={item.href}>
                    <div
                      title={
                        collapsed
                          ? `${item.label} — próximamente`
                          : "Este módulo todavía no está disponible"
                      }
                      className={cn(
                        "flex cursor-default items-center gap-3 rounded-[var(--radius-control)]",
                        "px-3 py-2 text-sm text-ink-subtle/60",
                        collapsed && "justify-center px-0",
                      )}
                    >
                      <Icon className="size-4 shrink-0" />
                      {!collapsed && (
                        <>
                          <span className="truncate">{item.label}</span>
                          <span className="ml-auto shrink-0 rounded-full border border-line px-1.5 py-0.5 text-[0.625rem] text-ink-subtle">
                            Pronto
                          </span>
                        </>
                      )}
                    </div>
                  </li>
                );
              }

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    title={collapsed ? item.label : undefined}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "group relative flex items-center gap-3 rounded-[var(--radius-control)]",
                      "px-3 py-2 text-sm transition-colors",
                      active
                        ? "bg-accent-soft font-medium text-accent"
                        : "text-ink-muted hover:bg-surface-raised hover:text-ink",
                      collapsed && "justify-center px-0",
                    )}
                  >
                    {active && (
                      <span
                        aria-hidden="true"
                        className="absolute top-1/2 left-0 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-accent"
                      />
                    )}
                    <Icon className="size-4 shrink-0" />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  const brand = (
    <div
      className={cn(
        "flex h-16 shrink-0 items-center gap-2.5 border-b border-line px-4",
        collapsed && "justify-center px-0",
      )}
    >
      <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent font-bold text-accent-ink">
        CC
      </div>
      {!collapsed && (
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">
            Capital Control
          </p>
          <p className="truncate text-[0.6875rem] text-ink-subtle">
            {organizationName}
          </p>
        </div>
      )}
    </div>
  );

  const footer = (
    <div className="shrink-0 border-t border-line p-3">
      <div
        className={cn(
          "flex items-center gap-2.5 rounded-[var(--radius-control)] px-2 py-2",
          collapsed && "justify-center px-0",
        )}
      >
        <div className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-raised text-xs font-semibold text-ink-muted">
          {initials(user.name)}
        </div>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-ink">{user.name}</p>
            <p className="truncate text-[0.6875rem] text-ink-subtle">
              {roleLabel(user.role)}
            </p>
          </div>
        )}
        {!collapsed && (
          <button
            type="button"
            onClick={onLogout}
            title="Cerrar sesión"
            className="rounded-md p-1.5 text-ink-subtle transition-colors hover:bg-surface-hover hover:text-danger"
          >
            <LogOut className="size-4" />
            <span className="sr-only">Cerrar sesión</span>
          </button>
        )}
      </div>
      {collapsed && (
        <button
          type="button"
          onClick={onLogout}
          title="Cerrar sesión"
          className="mt-1 grid w-full place-items-center rounded-md py-2 text-ink-subtle transition-colors hover:bg-surface-hover hover:text-danger"
        >
          <LogOut className="size-4" />
          <span className="sr-only">Cerrar sesión</span>
        </button>
      )}
    </div>
  );

  return (
    <div className="flex min-h-dvh bg-canvas">
      {/* Desktop sidebar */}
      <aside
        className={cn(
          "hidden shrink-0 flex-col border-r border-line bg-surface lg:flex",
          "transition-[width] duration-200",
          collapsed ? "w-[4.5rem]" : "w-64",
        )}
      >
        {brand}
        {nav}
        {footer}
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Cerrar menú"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-overlay backdrop-blur-sm"
          />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col border-r border-line bg-surface shadow-[var(--shadow-pop)]">
            <div className="flex h-16 shrink-0 items-center justify-between border-b border-line px-4">
              <div className="flex items-center gap-2.5">
                <div className="grid size-8 place-items-center rounded-lg bg-accent font-bold text-accent-ink">
                  CC
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">
                    Capital Control
                  </p>
                  <p className="truncate text-[0.6875rem] text-ink-subtle">
                    {organizationName}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="rounded-md p-1.5 text-ink-subtle hover:bg-surface-hover hover:text-ink"
              >
                <X className="size-5" />
                <span className="sr-only">Cerrar menú</span>
              </button>
            </div>
            {nav}
            {footer}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-16 shrink-0 items-center gap-3 border-b border-line bg-canvas/85 px-4 backdrop-blur-md">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="rounded-md p-2 text-ink-muted hover:bg-surface-raised hover:text-ink lg:hidden"
          >
            <Menu className="size-5" />
            <span className="sr-only">Abrir menú</span>
          </button>

          <button
            type="button"
            onClick={toggleCollapsed}
            title={collapsed ? "Expandir menú" : "Colapsar menú"}
            className="hidden rounded-md p-2 text-ink-muted hover:bg-surface-raised hover:text-ink lg:block"
          >
            <ChevronLeft
              className={cn(
                "size-5 transition-transform duration-200",
                collapsed && "rotate-180",
              )}
            />
            <span className="sr-only">
              {collapsed ? "Expandir menú" : "Colapsar menú"}
            </span>
          </button>

          {/* Global search (point 35). Wired to results in a later phase. */}
          <div className="relative min-w-0 flex-1 md:max-w-md">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-subtle" />
            <input
              type="search"
              placeholder="Buscar cliente, préstamo o recibo…"
              className={cn(
                "h-10 w-full rounded-[var(--radius-control)] border border-line bg-surface",
                "pr-3 pl-9 text-sm text-ink placeholder:text-ink-subtle",
                "transition-colors outline-none focus:border-accent/50",
              )}
            />
          </div>
        </header>

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

function roleLabel(role: UserRole): string {
  switch (role) {
    case "ADMIN":
      return "Administrador";
    case "COLLECTOR":
      return "Cobrador";
    case "VIEWER":
      return "Consulta";
  }
}
