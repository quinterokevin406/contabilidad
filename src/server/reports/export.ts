import "server-only";

import ExcelJS from "exceljs";

import { formatDate } from "@/core/time/format";
import { calendarDate } from "@/core/time/calendar-date";

import type { ReportColumn, ReportDefinition, ReportResult } from "./definitions";

/**
 * Report export (point 31).
 *
 * ## Why CSV and Excel are formatted differently
 *
 * They serve different readers, so they follow different rules rather than one
 * compromise that suits neither:
 *
 * **CSV** follows RFC 4180 — comma separator, dot decimal, quoted fields. It is
 * for feeding another system: an accountant's software, a bank template, a
 * script. Machine-readable beats double-click-friendly here, because a
 * semicolon-and-comma-decimal file is unparseable by almost everything that is
 * not Excel in a Spanish locale.
 *
 * **Excel** carries real numbers with a Colombian currency format applied to the
 * cell, so the figures are still numbers you can sum, and dates are real dates.
 * A spreadsheet full of text that merely looks like money is useless the moment
 * someone tries to total a column.
 *
 * A UTF-8 BOM is written on the CSV so accented names survive being opened in
 * Excel anyway.
 */

export type ExportFormat = "csv" | "xlsx";

export interface ExportedFile {
  body: Buffer | string;
  contentType: string;
  filename: string;
}

/** Renders a cell for CSV: exact strings, no locale formatting. */
function csvCell(
  value: string | number | null | undefined,
  column: ReportColumn,
): string {
  if (value === null || value === undefined) return "";

  if (column.type === "date") {
    // ISO in CSV: unambiguous for whatever reads it next.
    return String(value);
  }

  return String(value);
}

function escapeCsv(value: string): string {
  if (value === "") return "";
  // RFC 4180: quote when the field holds a comma, quote or newline.
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function toCsv(
  report: ReportDefinition,
  result: ReportResult,
): ExportedFile {
  const lines: string[] = [];

  lines.push(report.columns.map((c) => escapeCsv(c.label)).join(","));

  for (const row of result.rows) {
    lines.push(
      report.columns
        .map((column) => escapeCsv(csvCell(row[column.key], column)))
        .join(","),
    );
  }

  if (result.totals) {
    lines.push(
      report.columns
        .map((column) =>
          escapeCsv(csvCell(result.totals?.[column.key], column)),
        )
        .join(","),
    );
  }

  // The BOM is what lets Excel open a UTF-8 file with "Muñoz" intact.
  return {
    body: `﻿${lines.join("\r\n")}\r\n`,
    contentType: "text/csv; charset=utf-8",
    filename: `${report.id}.csv`,
  };
}

/** Colombian peso format: thousands separator, no decimals. */
const MONEY_FORMAT = '"$"#,##0';
const PERCENT_FORMAT = "0.00\\%";
const DATE_FORMAT = "dd/mm/yyyy";

export async function toXlsx(
  report: ReportDefinition,
  result: ReportResult,
  meta: { organizationName: string; generatedAt: Date; timeZone: string },
): Promise<ExportedFile> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Capital Control";
  workbook.created = meta.generatedAt;

  const sheet = workbook.addWorksheet(report.label.slice(0, 31), {
    views: [{ state: "frozen", ySplit: 3 }],
  });

  // Title block, so a printed sheet says what it is and when it was taken.
  sheet.mergeCells(1, 1, 1, report.columns.length);
  const title = sheet.getCell(1, 1);
  title.value = `${report.label} — ${meta.organizationName}`;
  title.font = { bold: true, size: 13 };

  sheet.mergeCells(2, 1, 2, report.columns.length);
  const subtitle = sheet.getCell(2, 1);
  subtitle.value = `Generado el ${new Intl.DateTimeFormat("es-CO", {
    timeZone: meta.timeZone,
    dateStyle: "long",
    timeStyle: "short",
  }).format(meta.generatedAt)} · ${result.rows.length} registros`;
  subtitle.font = { size: 10, color: { argb: "FF6A7280" } };

  const headerRow = sheet.getRow(3);
  report.columns.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = column.label;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1D212A" },
    };
    cell.alignment = { vertical: "middle" };
    sheet.getColumn(index + 1).width = column.width ?? 18;
  });
  headerRow.height = 20;

  for (const row of result.rows) {
    const values = report.columns.map((column) =>
      excelValue(row[column.key], column),
    );
    const added = sheet.addRow(values);
    applyFormats(added, report.columns);
  }

  if (result.totals) {
    const totalsRow = sheet.addRow(
      report.columns.map((column) =>
        excelValue(result.totals?.[column.key], column),
      ),
    );
    applyFormats(totalsRow, report.columns);
    totalsRow.font = { bold: true };
    totalsRow.border = { top: { style: "thin", color: { argb: "FF9AA2AE" } } };
  }

  sheet.autoFilter = {
    from: { row: 3, column: 1 },
    to: { row: 3, column: report.columns.length },
  };

  const buffer = await workbook.xlsx.writeBuffer();

  return {
    body: Buffer.from(buffer),
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    filename: `${report.id}.xlsx`,
  };
}

/**
 * Converts a report value into what the cell should actually hold.
 *
 * Money and percentages become NUMBERS so the column can be summed and sorted;
 * the cell's number format handles how they look. Emitting "$1.000.000" as text
 * would make the spreadsheet pretty and useless.
 */
function excelValue(
  value: string | number | null | undefined,
  column: ReportColumn,
): string | number | Date | null {
  if (value === null || value === undefined || value === "") return null;

  if (column.type === "money" || column.type === "percent") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : String(value);
  }

  if (column.type === "number") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : String(value);
  }

  if (column.type === "date") {
    try {
      const parts = calendarDate(String(value));
      const [year, month, day] = parts.split("-").map(Number);
      // A plain local Date; Excel stores it as a date serial.
      return new Date(year!, month! - 1, day!);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

function applyFormats(
  row: ExcelJS.Row,
  columns: readonly ReportColumn[],
): void {
  columns.forEach((column, index) => {
    const cell = row.getCell(index + 1);

    if (column.type === "money") {
      cell.numFmt = MONEY_FORMAT;
      cell.alignment = { horizontal: "right" };
    } else if (column.type === "percent") {
      cell.numFmt = PERCENT_FORMAT;
      cell.alignment = { horizontal: "right" };
    } else if (column.type === "number") {
      cell.alignment = { horizontal: "right" };
    } else if (column.type === "date") {
      cell.numFmt = DATE_FORMAT;
    }
  });
}

/** Human-readable cell text for the on-screen preview. */
export function previewCell(
  value: string | number | null | undefined,
  column: ReportColumn,
): string {
  if (value === null || value === undefined || value === "") return "—";

  if (column.type === "date") {
    try {
      return formatDate(calendarDate(String(value)));
    } catch {
      return String(value);
    }
  }

  return String(value);
}
