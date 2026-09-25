import type { NextRequest } from "next/server";

import { calendarDate } from "@/core/time/calendar-date";
import { prisma } from "@/infra/db/client";
import { getCurrentUser, getOrganizationSettings } from "@/server/auth/dal";
import type { ReportFilters } from "@/server/reports/definitions";
import { toCsv, toXlsx, type ExportFormat } from "@/server/reports/export";
import { findReport } from "@/server/reports/registry";

/**
 * Report download (point 31).
 *
 * The export honours exactly the filters that produced the preview, because both
 * read the same query string and call the same report definition. An export that
 * silently returns more rows than the screen showed is how someone sends a client
 * list they never meant to send.
 *
 * Authorization is checked here and not left to the proxy: a route handler is an
 * entry point of its own, and the proxy is an optimistic redirect, not a gate.
 */

function parseFilters(params: URLSearchParams): ReportFilters {
  const filters: ReportFilters = {};

  const from = params.get("desde");
  const to = params.get("hasta");

  try {
    if (from) filters.from = calendarDate(from);
    if (to) filters.to = calendarDate(to);
  } catch {
    // A malformed date is simply not applied; the report still runs unfiltered
    // rather than failing on a typo in a URL.
  }

  const clientId = params.get("cliente");
  if (clientId) filters.clientId = clientId;

  const status = params.get("estado");
  if (status && status !== "ALL") filters.status = status;

  const periodicity = params.get("periodicidad");
  if (periodicity && periodicity !== "ALL") filters.periodicity = periodicity;

  const userId = params.get("usuario");
  if (userId) filters.userId = userId;

  return filters;
}

export async function GET(
  request: NextRequest,
  context: RouteContext<"/api/reportes/[id]">,
) {
  const user = await getCurrentUser();
  if (!user) {
    return new Response("No autorizado", { status: 401 });
  }

  const { id } = await context.params;
  const report = findReport(id);

  if (!report) {
    return new Response("El reporte no existe", { status: 404 });
  }

  const params = request.nextUrl.searchParams;
  const format = (params.get("formato") ?? "csv") as ExportFormat;

  if (format !== "csv" && format !== "xlsx") {
    return new Response("Formato no soportado", { status: 400 });
  }

  const result = await report.run(user.organizationId, parseFilters(params));

  const settings = await getOrganizationSettings();
  const organization = await prisma.organization.findUnique({
    where: { id: user.organizationId },
    select: { name: true },
  });

  const file =
    format === "csv"
      ? toCsv(report, result)
      : await toXlsx(report, result, {
          organizationName: organization?.name ?? settings.businessName,
          generatedAt: new Date(),
          timeZone: settings.timeZone,
        });

  // Exporting a report is an access to client data, so it leaves a trail
  // (point 33): who took what, when, and how many rows left the building.
  await prisma.auditLog.create({
    data: {
      organizationId: user.organizationId,
      action: "EXPORT",
      entity: "Report",
      entityId: report.id,
      summary: `Exportó "${report.label}" (${format.toUpperCase()}, ${result.rows.length} filas)`,
      afterValues: {
        format,
        rows: result.rows.length,
        filters: Object.fromEntries(params.entries()),
      },
      actorId: user.id,
      actorEmail: user.email,
      ipAddress:
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: request.headers.get("user-agent"),
    },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = file.filename.replace(/\.(csv|xlsx)$/, `-${stamp}.$1`);

  return new Response(file.body as BodyInit, {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      // A report is a point-in-time extract; never let a proxy serve a stale one.
      "Cache-Control": "no-store",
    },
  });
}
