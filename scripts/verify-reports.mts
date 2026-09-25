/**
 * Integration check for the report registry and exports.
 *
 * Fifteen reports is a lot of surface, and a report that silently returns the
 * wrong total is worse than one that crashes. This runs every report, checks the
 * ones with a ledger counterpart against it, exercises the filters, and
 * generates real CSV and XLSX bytes to prove the export path works end to end.
 */

import ExcelJS from "exceljs";

import { Money } from "@/core/money/money";
import { addDays, startOfMonth, todayIn } from "@/core/time/calendar-date";
import { prisma } from "@/infra/db/client";
import { toCsv, toXlsx } from "@/server/reports/export";
import { findReport, REPORTS } from "@/server/reports/registry";
import { fromDb } from "@/infra/db/money";

let failures = 0;

function check(label: string, pass: boolean, detail = "") {
  if (!pass) failures += 1;
  console.log(`  ${pass ? "OK  " : "FALLA"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const org = await prisma.organization.findFirstOrThrow({
    select: { id: true, name: true },
  });
  const today = todayIn("America/Bogota");

  // --- Every report runs and is well-formed --------------------------------

  console.log(`\nEjecutando los ${REPORTS.length} reportes:\n`);

  const results = new Map<string, Awaited<ReturnType<typeof runOne>>>();

  for (const report of REPORTS) {
    const result = await runOne(report.id, org.id);
    results.set(report.id, result);

    // Every declared column must exist on every row, or the export writes gaps.
    const missing = new Set<string>();
    for (const row of result.rows.slice(0, 50)) {
      for (const column of report.columns) {
        if (!(column.key in row)) missing.add(column.key);
      }
    }

    check(
      `${report.label.padEnd(24)}`,
      missing.size === 0,
      `${result.rows.length} filas` +
        (missing.size > 0 ? ` · faltan columnas: ${[...missing].join(", ")}` : ""),
    );
  }

  // --- Totals against the ledger -------------------------------------------

  console.log("\nTotales contra el libro mayor:\n");

  const cartera = results.get("cartera-general")!;
  const livePrincipal = fromDb(
    (
      await prisma.loan.aggregate({
        where: { organizationId: org.id, lifecycle: "ACTIVE", archivedAt: null },
        _sum: { outstandingPrincipal: true },
      })
    )._sum.outstandingPrincipal?.toFixed() ?? "0",
  );
  check(
    "cartera general = suma de préstamos activos",
    Money.of(String(cartera.totals?.principal ?? "0")).equals(livePrincipal),
    `${cartera.totals?.principal} vs ${livePrincipal.toDatabaseString()}`,
  );

  const pagos = results.get("pagos")!;
  const livePayments = fromDb(
    (
      await prisma.payment.aggregate({
        where: { organizationId: org.id },
        _sum: { amount: true },
      })
    )._sum.amount?.toFixed() ?? "0",
  );
  check(
    "pagos = suma de todos los pagos",
    Money.of(String(pagos.totals?.amount ?? "0")).equals(livePayments),
    `${pagos.totals?.amount} vs ${livePayments.toDatabaseString()}`,
  );

  // The two allocation reports must add up to the payments report.
  const abonos = results.get("abonos-capital")!;
  const intereses = results.get("intereses-cobrados")!;
  check(
    "abonos a capital = componente de capital de los pagos",
    Money.of(String(abonos.totals?.amount ?? "0")).equals(
      String(pagos.totals?.principal ?? "0"),
    ),
    `${abonos.totals?.amount} vs ${pagos.totals?.principal}`,
  );
  check(
    "intereses cobrados = componente de interés de los pagos",
    Money.of(String(intereses.totals?.amount ?? "0")).equals(
      String(pagos.totals?.interest ?? "0"),
    ),
    `${intereses.totals?.amount} vs ${pagos.totals?.interest}`,
  );

  const vencida = results.get("cartera-vencida")!;
  const overdueLoans = await prisma.loan.count({
    where: {
      organizationId: org.id,
      lifecycle: "ACTIVE",
      compliance: "OVERDUE",
      archivedAt: null,
    },
  });
  check(
    "cartera vencida lista exactamente los préstamos en mora",
    vencida.rows.length === overdueLoans,
    `${vencida.rows.length} vs ${overdueLoans}`,
  );

  const flujo = results.get("flujo-caja")!;
  const movementCount = await prisma.cashMovement.count({
    where: { organizationId: org.id, reversedAt: null },
  });
  check(
    "flujo de caja lista todos los movimientos",
    flujo.rows.length === movementCount,
    `${flujo.rows.length} vs ${movementCount}`,
  );

  const utilidad = results.get("utilidad")!;
  const closedMonths = await prisma.periodSnapshot.count({
    where: { organizationId: org.id, kind: "MONTHLY", status: "CLOSED" },
  });
  check(
    "utilidad tiene una fila por mes cerrado",
    utilidad.rows.length === closedMonths,
    `${utilidad.rows.length} vs ${closedMonths}`,
  );

  // --- Filters actually filter ---------------------------------------------

  console.log("\nFiltros:\n");

  const monthStart = startOfMonth(today);
  const filtered = await findReport("pagos")!.run(org.id, {
    from: monthStart,
    to: today,
  });
  const unfiltered = results.get("pagos")!;

  check(
    "un rango de fechas reduce las filas",
    filtered.rows.length <= unfiltered.rows.length,
    `${filtered.rows.length} de ${unfiltered.rows.length}`,
  );

  const allDates = filtered.rows.map((row) => String(row.paidOn));
  check(
    "ninguna fila cae fuera del rango pedido",
    allDates.every((date) => date >= monthStart && date <= today),
  );

  const someClient = await prisma.client.findFirstOrThrow({
    where: { organizationId: org.id },
    select: { id: true, fullName: true },
  });
  const byClient = await findReport("cartera-general")!.run(org.id, {
    clientId: someClient.id,
  });
  check(
    "el filtro por cliente deja solo ese cliente",
    byClient.rows.every((row) => row.client === someClient.fullName),
    `${byClient.rows.length} filas de ${someClient.fullName}`,
  );

  const impossible = await findReport("pagos")!.run(org.id, {
    from: addDays(today, 1),
    to: addDays(today, 2),
  });
  check(
    "un rango sin datos devuelve vacío, no falla",
    impossible.rows.length === 0,
  );

  // --- Exports produce real files ------------------------------------------

  console.log("\nExportación:\n");

  for (const report of REPORTS) {
    const result = results.get(report.id)!;

    const csv = toCsv(report, result);
    const csvText = String(csv.body);
    const csvLines = csvText.trimEnd().split("\r\n");

    const expectedLines =
      1 + result.rows.length + (result.totals ? 1 : 0);

    check(
      `CSV ${report.label.padEnd(22)}`,
      csvLines.length === expectedLines &&
        csvText.startsWith("\uFEFF") &&
        csvLines[0]!.includes(report.columns[0]!.label),
      `${csvLines.length} líneas`,
    );
  }

  // Excel is heavier, so a representative sample rather than all fifteen.
  for (const id of ["cartera-general", "pagos", "rentabilidad-mensual"]) {
    const report = findReport(id)!;
    const result = results.get(id)!;

    const xlsx = await toXlsx(report, result, {
      organizationName: org.name,
      generatedAt: new Date(),
      timeZone: "America/Bogota",
    });

    const workbook = new ExcelJS.Workbook();
    // Node's Buffer generic and ExcelJS's declared Buffer disagree; the bytes
    // are identical, so hand it the underlying ArrayBuffer instead.
    const bytes = xlsx.body as Buffer;
    await workbook.xlsx.load(
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    );
    const sheet = workbook.worksheets[0]!;

    // Title, subtitle, header, then the data.
    const expectedRows = 3 + result.rows.length + (result.totals ? 1 : 0);

    check(
      `Excel ${report.label.padEnd(20)}`,
      sheet.rowCount === expectedRows,
      `${sheet.rowCount} filas de ${expectedRows}`,
    );

    // The point of Excel over CSV: money must be a NUMBER, not text.
    const moneyColumn = report.columns.findIndex((c) => c.type === "money");
    if (moneyColumn >= 0 && result.rows.length > 0) {
      const cell = sheet.getRow(4).getCell(moneyColumn + 1);
      check(
        `  ${report.label}: el dinero es número, no texto`,
        typeof cell.value === "number" || cell.value === null,
        `${typeof cell.value}`,
      );
      check(
        `  ${report.label}: la celda lleva formato de pesos`,
        typeof cell.numFmt === "string" && cell.numFmt.includes("$"),
        cell.numFmt ?? "sin formato",
      );
    }
  }

  console.log(
    failures === 0
      ? "\nLos quince reportes y sus exportaciones funcionan.\n"
      : `\n${failures} verificaciones fallaron.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

async function runOne(id: string, organizationId: string) {
  const report = findReport(id);
  if (!report) throw new Error(`Reporte desconocido: ${id}`);
  return report.run(organizationId, {});
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
