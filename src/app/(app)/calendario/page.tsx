import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, EmptyState } from "@/components/ui/card";
import { formatMoney, formatMoneyCompact } from "@/core/money/format";
import {
  addDays,
  addMonths,
  calendarDate,
  endOfMonth,
  isoWeekday,
  startOfMonth,
  toParts,
  todayIn,
  type CalendarDate,
} from "@/core/time/calendar-date";
import { formatDateLong, formatMonthLong } from "@/core/time/format";
import { cn } from "@/lib/cn";
import { getOrganizationSettings, requireUser } from "@/server/auth/dal";
import {
  collectionsOn,
  getCalendarDays,
  projectedCollections,
} from "@/server/collections/queries";

export const metadata: Metadata = { title: "Calendario" };

const WEEKDAYS = ["L", "M", "M", "J", "V", "S", "D"] as const;

export default async function CalendarPage({
  searchParams,
}: PageProps<"/calendario">) {
  const user = await requireUser();
  const settings = await getOrganizationSettings();
  const today = todayIn(settings.timeZone);
  const params = await searchParams;

  const anchor = parseMonthAnchor(
    typeof params.mes === "string" ? params.mes : null,
    today,
  );
  const selected = parseDay(
    typeof params.dia === "string" ? params.dia : null,
    anchor,
    today,
  );

  const monthStart = startOfMonth(anchor);
  const monthEnd = endOfMonth(anchor);
  const { year, month } = toParts(anchor);

  const days = await getCalendarDays(
    user.organizationId,
    monthStart,
    monthEnd,
    today,
  );
  const byDate = new Map(days.map((day) => [day.date, day]));

  // The selected day's detail: accrued rows if it has passed, a projection if
  // it has not. Never both — they answer different questions.
  const detail =
    selected <= today
      ? await collectionsOn(user.organizationId, selected)
      : await projectedCollections(user.organizationId, selected, selected);

  const monthTotal = days.reduce(
    (acc, day) => acc + Number(day.outstanding.toDatabaseString()),
    0,
  );

  // Leading blanks so the 1st lands under its weekday (Monday-first).
  const leadingBlanks = isoWeekday(monthStart) - 1;
  const totalDays = toParts(monthEnd).day;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Calendario</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {formatMonthLong(year, month)} ·{" "}
            {monthTotal === 0
              ? "sin cobros pendientes"
              : `${formatMoney(String(monthTotal))} por cobrar`}
          </p>
        </div>

        <div className="flex items-center gap-1">
          <MonthLink anchor={addMonths(anchor, -1)} label="Mes anterior">
            <ChevronLeft className="size-4" />
          </MonthLink>
          <Link
            href="/calendario"
            className="rounded-[var(--radius-control)] border border-line-strong px-3 py-1.5 text-xs text-ink transition-colors hover:border-accent hover:text-accent"
          >
            Hoy
          </Link>
          <MonthLink anchor={addMonths(anchor, 1)} label="Mes siguiente">
            <ChevronRight className="size-4" />
          </MonthLink>
        </div>
      </header>

      <Card className="p-4 sm:p-5">
        <div className="grid grid-cols-7 gap-1 sm:gap-2">
          {WEEKDAYS.map((label, index) => (
            <div
              key={`${label}-${index}`}
              className="pb-2 text-center text-[0.6875rem] font-medium tracking-wide text-ink-subtle uppercase"
            >
              {label}
            </div>
          ))}

          {Array.from({ length: leadingBlanks }).map((_, index) => (
            <div key={`blank-${index}`} />
          ))}

          {Array.from({ length: totalDays }).map((_, index) => {
            const date = addDays(monthStart, index);
            const day = byDate.get(date);
            const isToday = date === today;
            const isSelected = date === selected;
            const amount = day ? Number(day.outstanding.toDatabaseString()) : 0;

            return (
              <Link
                key={date}
                href={`/calendario?mes=${year}-${String(month).padStart(2, "0")}&dia=${date}`}
                aria-current={isSelected ? "date" : undefined}
                className={cn(
                  "flex min-h-16 flex-col rounded-[var(--radius-control)] border p-1.5 transition-colors sm:min-h-20 sm:p-2",
                  isSelected
                    ? "border-accent bg-accent-soft"
                    : "border-line hover:border-line-strong hover:bg-surface-raised/60",
                )}
              >
                <span
                  className={cn(
                    "text-xs",
                    isToday
                      ? "font-semibold text-accent"
                      : isSelected
                        ? "text-accent"
                        : "text-ink-muted",
                  )}
                >
                  {toParts(date).day}
                </span>

                {day && amount > 0 && (
                  <span
                    className={cn(
                      "cc-tabular mt-auto truncate text-[0.625rem] sm:text-xs",
                      day.hasOverdue
                        ? "text-danger"
                        : day.isProjection
                          ? "text-ink-subtle"
                          : "text-ink",
                    )}
                  >
                    {formatMoneyCompact(String(amount))}
                  </span>
                )}

                {day && day.count > 0 && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-0.5 h-0.5 w-full rounded-full",
                      day.hasOverdue
                        ? "bg-danger"
                        : day.isProjection
                          ? "bg-ink-subtle/40"
                          : "bg-accent/60",
                    )}
                  />
                )}
              </Link>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-line pt-3 text-xs text-ink-subtle">
          <LegendItem className="bg-accent/60" label="Causado y pendiente" />
          <LegendItem className="bg-danger" label="Vencido" />
          <LegendItem className="bg-ink-subtle/40" label="Proyectado" />
        </div>
      </Card>

      <Card>
        <CardHeader
          title={formatDateLong(selected)}
          description={
            detail.length === 0
              ? "Sin vencimientos"
              : selected > today
                ? `${detail.length} vencimientos proyectados`
                : `${detail.length} ${detail.length === 1 ? "vencimiento" : "vencimientos"}`
          }
        />

        {detail.length === 0 ? (
          <EmptyState title="Nada programado para este día" />
        ) : (
          <ul className="divide-y divide-line">
            {detail.map((row) => (
              <li key={row.key}>
                <Link
                  href={`/prestamos/${row.loanId}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 transition-colors hover:bg-surface-raised/60"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-ink">{row.clientName}</span>
                      {row.status === "PAID" && (
                        <Badge tone="positive">Pagado</Badge>
                      )}
                      {row.status === "OVERDUE" && (
                        <Badge tone="danger">
                          {row.daysOverdue}{" "}
                          {row.daysOverdue === 1 ? "día" : "días"}
                        </Badge>
                      )}
                      {row.isProjection && (
                        <Badge tone="neutral" showDot={false}>
                          Proyectado
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-ink-subtle">
                      {row.loanCode}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "cc-tabular text-sm",
                      row.status === "PAID" ? "text-positive" : "text-ink",
                    )}
                  >
                    {formatMoney(
                      row.status === "PAID" ? row.amount : row.outstanding,
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="px-5 py-4">
        <p className="text-xs text-ink-subtle">
          Los días pasados y el de hoy muestran interés{" "}
          <strong className="text-ink-muted">ya causado</strong>. Los días futuros
          muestran una <strong className="text-ink-muted">proyección</strong>: esos
          períodos todavía no existen, y en un préstamo con interés sobre saldo un
          abono a capital antes del vencimiento cambiaría la cifra.
        </p>
      </Card>
    </div>
  );
}

function MonthLink({
  anchor,
  label,
  children,
}: {
  anchor: CalendarDate;
  label: string;
  children: React.ReactNode;
}) {
  const { year, month } = toParts(anchor);
  return (
    <Link
      href={`/calendario?mes=${year}-${String(month).padStart(2, "0")}`}
      aria-label={label}
      className="rounded-[var(--radius-control)] border border-line-strong p-1.5 text-ink-muted transition-colors hover:border-accent hover:text-accent"
    >
      {children}
    </Link>
  );
}

function LegendItem({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={cn("h-0.5 w-4 rounded-full", className)} />
      {label}
    </span>
  );
}

function parseMonthAnchor(raw: string | null, today: CalendarDate): CalendarDate {
  if (!raw) return today;
  const match = /^(\d{4})-(\d{2})$/.exec(raw);
  if (!match) return today;
  try {
    return calendarDate(`${match[1]}-${match[2]}-01`);
  } catch {
    return today;
  }
}

function parseDay(
  raw: string | null,
  anchor: CalendarDate,
  today: CalendarDate,
): CalendarDate {
  if (raw) {
    try {
      return calendarDate(raw);
    } catch {
      // Fall through to the sensible default.
    }
  }
  // Viewing the current month selects today; any other month selects its 1st.
  const anchorParts = toParts(anchor);
  const todayParts = toParts(today);
  return anchorParts.year === todayParts.year &&
    anchorParts.month === todayParts.month
    ? today
    : startOfMonth(anchor);
}
