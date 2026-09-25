import "server-only";

import { Money } from "@/core/money/money";
import type { CalendarDate } from "@/core/time/calendar-date";

/**
 * Report registry (points 29, 30, 31).
 *
 * A report declares its columns and how to fetch its rows; nothing else. The
 * export layer reads that declaration and produces CSV or Excel without knowing
 * what a loan is, and the screen renders a preview from the same source.
 *
 * Adding a report means adding one entry here. Adding an export format means
 * touching one file. Neither requires the other to change — which is the whole
 * reason this is declarative rather than fifteen bespoke endpoints.
 */

export type ColumnType = "text" | "money" | "date" | "number" | "percent";

export interface ReportColumn {
  key: string;
  label: string;
  type: ColumnType;
  /** Column width hint for the spreadsheet, in characters. */
  width?: number;
}

/** A row is a flat bag of primitives; Money arrives as a decimal string. */
export type ReportRow = Record<string, string | number | null>;

export interface ReportFilters {
  from?: CalendarDate;
  to?: CalendarDate;
  clientId?: string;
  /** Loan lifecycle or compliance, depending on the report. */
  status?: string;
  periodicity?: string;
  userId?: string;
}

export interface ReportResult {
  rows: ReportRow[];
  /** Optional footer, keyed by column. Rendered and exported as a totals row. */
  totals?: ReportRow;
}

export interface ReportDefinition {
  id: string;
  label: string;
  description: string;
  /** Which filters this report actually honours, so the UI hides the rest. */
  filters: readonly (keyof ReportFilters)[];
  columns: readonly ReportColumn[];
  run: (
    organizationId: string,
    filters: ReportFilters,
  ) => Promise<ReportResult>;
}

/** Sums a money column across rows, for a totals footer. */
export function sumColumn(rows: ReportRow[], key: string): string {
  return Money.sum(
    rows.map((row) => String(row[key] ?? "0")),
  ).toDatabaseString();
}

/** Counts rows, for a totals footer. */
export function countRows(rows: ReportRow[]): number {
  return rows.length;
}
