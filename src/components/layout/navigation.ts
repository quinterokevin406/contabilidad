import type { LucideIcon } from "lucide-react";
import {
  Archive,
  BarChart3,
  Banknote,
  CalendarDays,
  ClipboardList,
  Coins,
  FileText,
  History,
  LayoutDashboard,
  Settings,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";

import type { UserRole } from "@/generated/prisma";

/**
 * Sidebar navigation (point 38).
 *
 * Declared as data so the sidebar, the mobile drawer and the command palette all
 * read from one definition and cannot drift apart.
 */

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Roles allowed to see this entry. Omitted means everyone. */
  roles?: readonly UserRole[];
  /**
   * The module is not built yet.
   *
   * Shown, but not linked. An entry that navigates to a 404 is worse than one
   * that says plainly it is not ready: the operator learns what the product will
   * cover without being sent into a dead end.
   */
  pending?: boolean;
}

export interface NavSection {
  label: string | null;
  items: readonly NavItem[];
}

export const NAVIGATION: readonly NavSection[] = [
  {
    label: null,
    items: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
      { href: "/ejecutivo", label: "Dashboard ejecutivo", icon: TrendingUp },
    ],
  },
  {
    label: "Operación",
    items: [
      { href: "/clientes", label: "Clientes", icon: Users },
      { href: "/prestamos", label: "Préstamos", icon: Banknote },
      { href: "/cobros", label: "Cobros", icon: ClipboardList },
      { href: "/calendario", label: "Calendario", icon: CalendarDays },
      { href: "/cartera", label: "Cartera", icon: BarChart3 },
    ],
  },
  {
    label: "Finanzas",
    items: [
      { href: "/caja", label: "Caja", icon: Wallet },
      { href: "/movimientos", label: "Ingresos / Egresos", icon: Coins },
      { href: "/reportes", label: "Reportes", icon: FileText },
    ],
  },
  {
    label: "Sistema",
    items: [
      { href: "/historico", label: "Histórico", icon: Archive },
      { href: "/historial", label: "Historial", icon: History },
      { href: "/configuracion", label: "Configuración", icon: Settings },
    ],
  },
];

/** Filters the navigation to what a role may see. */
export function navigationFor(role: UserRole): NavSection[] {
  return NAVIGATION.map((section) => ({
    label: section.label,
    items: section.items.filter(
      (item) => !item.roles || item.roles.includes(role),
    ),
  })).filter((section) => section.items.length > 0);
}

/**
 * Whether a nav entry should read as active for the current path.
 *
 * The dashboard is an exact match; everything else matches its subtree, so
 * /clientes/abc still highlights Clientes.
 */
export function isActivePath(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
