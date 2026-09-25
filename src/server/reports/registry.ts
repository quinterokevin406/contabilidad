import "server-only";

import { describeLoanState, resolveAgingBucket } from "@/core/loans/state";
import { Money } from "@/core/money/money";
import {
  fromPrismaDate,
  toPrismaDate,
  type CalendarDate,
} from "@/core/time/calendar-date";
import { formatMonthShort } from "@/core/time/format";
import { prisma } from "@/infra/db/client";
import { fromDb } from "@/infra/db/money";
import { MOVEMENT_LABEL } from "@/server/cash/queries";

import {
  sumColumn,
  type ReportDefinition,
  type ReportFilters,
  type ReportRow,
} from "./definitions";

/**
 * The fifteen reports of point 29.
 *
 * Every money column is emitted as an exact decimal STRING, never a float. The
 * export layer converts to a spreadsheet number at the very last step, where the
 * cell's own format handles display — so a report that is correct on screen is
 * correct in Excel and correct in CSV, by construction.
 */

function dateWindow(filters: ReportFilters) {
  if (!filters.from && !filters.to) return {};
  return {
    ...(filters.from ? { gte: toPrismaDate(filters.from) } : {}),
    ...(filters.to ? { lte: toPrismaDate(filters.to) } : {}),
  };
}

const MONEY = (label: string, key: string, width = 16) =>
  ({ key, label, type: "money" as const, width });
const TEXT = (label: string, key: string, width = 22) =>
  ({ key, label, type: "text" as const, width });
const DATE = (label: string, key: string) =>
  ({ key, label, type: "date" as const, width: 12 });
const NUM = (label: string, key: string, width = 10) =>
  ({ key, label, type: "number" as const, width });
const PCT = (label: string, key: string, width = 12) =>
  ({ key, label, type: "percent" as const, width });

// --- Portfolio ---------------------------------------------------------------

const carteraGeneral: ReportDefinition = {
  id: "cartera-general",
  label: "Cartera general",
  description: "Todos los préstamos activos con su saldo actual",
  filters: ["clientId", "periodicity", "status"],
  columns: [
    TEXT("Préstamo", "code", 14),
    TEXT("Cliente", "client", 28),
    TEXT("Documento", "document", 14),
    DATE("Desembolso", "disbursedOn"),
    MONEY("Capital original", "original"),
    MONEY("Capital pendiente", "principal"),
    MONEY("Interés pendiente", "interest"),
    MONEY("Total pendiente", "total"),
    TEXT("Tasa", "rate", 10),
    TEXT("Periodicidad", "periodicity", 14),
    DATE("Próximo vence", "nextDueOn"),
    TEXT("Estado", "state", 14),
  ],
  async run(organizationId, filters) {
    const loans = await prisma.loan.findMany({
      where: {
        organizationId,
        archivedAt: null,
        lifecycle: filters.status === "ALL" || !filters.status
          ? "ACTIVE"
          : (filters.status as "ACTIVE"),
        ...(filters.clientId ? { clientId: filters.clientId } : {}),
        ...(filters.periodicity
          ? { periodicity: filters.periodicity as "MONTHLY" }
          : {}),
      },
      orderBy: [{ compliance: "desc" }, { code: "asc" }],
      select: {
        code: true,
        disbursedOn: true,
        originalPrincipal: true,
        outstandingPrincipal: true,
        ratePercent: true,
        periodicity: true,
        nextDueOn: true,
        daysOverdue: true,
        lifecycle: true,
        compliance: true,
        client: { select: { fullName: true, documentNumber: true } },
        periods: {
          where: { status: { in: ["PENDING", "PARTIALLY_PAID"] } },
          select: {
            interestAccrued: true,
            interestPaid: true,
            interestWaived: true,
          },
        },
      },
    });

    const rows: ReportRow[] = loans.map((loan) => {
      const interest = loan.periods.reduce((acc, p) => {
        const owed = fromDb(p.interestAccrued)
          .minus(fromDb(p.interestPaid))
          .minus(fromDb(p.interestWaived));
        return owed.isPositive() ? acc.plus(owed) : acc;
      }, Money.zero());

      const principal = fromDb(loan.outstandingPrincipal);

      return {
        code: loan.code,
        client: loan.client.fullName,
        document: loan.client.documentNumber,
        disbursedOn: fromPrismaDate(loan.disbursedOn),
        original: fromDb(loan.originalPrincipal).toDatabaseString(),
        principal: principal.toDatabaseString(),
        interest: interest.toDatabaseString(),
        total: principal.plus(interest).toDatabaseString(),
        rate: `${loan.ratePercent.toFixed()}%`,
        periodicity: loan.periodicity,
        nextDueOn: loan.nextDueOn ? fromPrismaDate(loan.nextDueOn) : null,
        state: describeLoanState({
          lifecycle: loan.lifecycle,
          compliance: loan.compliance,
          debt: { outstandingPrincipal: principal, outstandingInterest: interest },
          daysOverdue: loan.daysOverdue,
        }).label,
      };
    });

    return {
      rows,
      totals: {
        code: "TOTAL",
        original: sumColumn(rows, "original"),
        principal: sumColumn(rows, "principal"),
        interest: sumColumn(rows, "interest"),
        total: sumColumn(rows, "total"),
      },
    };
  },
};

const carteraVencida: ReportDefinition = {
  id: "cartera-vencida",
  label: "Cartera vencida",
  description: "Préstamos en mora, con antigüedad y último pago",
  filters: ["clientId"],
  columns: [
    TEXT("Préstamo", "code", 14),
    TEXT("Cliente", "client", 28),
    TEXT("Teléfono", "phone", 14),
    MONEY("Capital pendiente", "principal"),
    MONEY("Interés pendiente", "interest"),
    MONEY("Total pendiente", "total"),
    DATE("Venció", "oldestDueOn"),
    NUM("Días vencido", "days", 12),
    TEXT("Antigüedad", "bucket", 14),
    DATE("Último pago", "lastPaymentOn"),
  ],
  async run(organizationId, filters) {
    const loans = await prisma.loan.findMany({
      where: {
        organizationId,
        archivedAt: null,
        lifecycle: "ACTIVE",
        compliance: "OVERDUE",
        ...(filters.clientId ? { clientId: filters.clientId } : {}),
      },
      orderBy: { daysOverdue: "desc" },
      select: {
        code: true,
        outstandingPrincipal: true,
        daysOverdue: true,
        client: { select: { fullName: true, phone: true } },
        periods: {
          where: { status: { in: ["PENDING", "PARTIALLY_PAID"] } },
          orderBy: { dueOn: "asc" },
          select: {
            dueOn: true,
            interestAccrued: true,
            interestPaid: true,
            interestWaived: true,
          },
        },
        payments: {
          where: { status: "POSTED" },
          orderBy: { paidOn: "desc" },
          take: 1,
          select: { paidOn: true },
        },
      },
    });

    const rows: ReportRow[] = loans.map((loan) => {
      let interest = Money.zero();
      let oldest: CalendarDate | null = null;

      for (const period of loan.periods) {
        const owed = fromDb(period.interestAccrued)
          .minus(fromDb(period.interestPaid))
          .minus(fromDb(period.interestWaived));
        if (!owed.isPositive()) continue;
        interest = interest.plus(owed);
        if (!oldest) oldest = fromPrismaDate(period.dueOn);
      }

      const principal = fromDb(loan.outstandingPrincipal);

      return {
        code: loan.code,
        client: loan.client.fullName,
        phone: loan.client.phone,
        principal: principal.toDatabaseString(),
        interest: interest.toDatabaseString(),
        total: principal.plus(interest).toDatabaseString(),
        oldestDueOn: oldest,
        days: loan.daysOverdue,
        bucket: resolveAgingBucket(loan.daysOverdue)?.label ?? "—",
        lastPaymentOn: loan.payments[0]
          ? fromPrismaDate(loan.payments[0].paidOn)
          : null,
      };
    });

    return {
      rows,
      totals: {
        code: "TOTAL",
        principal: sumColumn(rows, "principal"),
        interest: sumColumn(rows, "interest"),
        total: sumColumn(rows, "total"),
      },
    };
  },
};

const clientes: ReportDefinition = {
  id: "clientes",
  label: "Clientes",
  description: "Directorio con saldos y actividad",
  filters: ["status"],
  columns: [
    TEXT("Código", "code", 12),
    TEXT("Nombre", "name", 30),
    TEXT("Documento", "document", 14),
    TEXT("Teléfono", "phone", 14),
    TEXT("Ciudad", "city", 16),
    TEXT("Estado", "status", 12),
    NUM("Préstamos activos", "activeLoans", 16),
    MONEY("Capital pendiente", "principal"),
    MONEY("Total pagado", "paid"),
  ],
  async run(organizationId, filters) {
    const clients = await prisma.client.findMany({
      where: {
        organizationId,
        archivedAt: null,
        ...(filters.status && filters.status !== "ALL"
          ? { status: filters.status as "ACTIVE" }
          : {}),
      },
      orderBy: { fullName: "asc" },
      select: {
        code: true,
        fullName: true,
        documentNumber: true,
        phone: true,
        city: true,
        status: true,
        loans: {
          where: { archivedAt: null },
          select: { lifecycle: true, outstandingPrincipal: true },
        },
        payments: {
          where: { status: "POSTED" },
          select: { amount: true },
        },
      },
    });

    const rows: ReportRow[] = clients.map((client) => ({
      code: client.code,
      name: client.fullName,
      document: client.documentNumber,
      phone: client.phone,
      city: client.city,
      status: client.status,
      activeLoans: client.loans.filter((l) => l.lifecycle === "ACTIVE").length,
      principal: Money.sum(
        client.loans
          .filter((l) => l.lifecycle === "ACTIVE")
          .map((l) => fromDb(l.outstandingPrincipal)),
      ).toDatabaseString(),
      paid: Money.sum(
        client.payments.map((p) => fromDb(p.amount)),
      ).toDatabaseString(),
    }));

    return {
      rows,
      totals: {
        code: "TOTAL",
        principal: sumColumn(rows, "principal"),
        paid: sumColumn(rows, "paid"),
      },
    };
  },
};

const prestamos: ReportDefinition = {
  id: "prestamos",
  label: "Préstamos",
  description: "Todos los préstamos, incluidos los cerrados",
  filters: ["from", "to", "clientId", "status", "periodicity"],
  columns: [
    TEXT("Préstamo", "code", 14),
    TEXT("Cliente", "client", 28),
    DATE("Desembolso", "disbursedOn"),
    MONEY("Capital original", "original"),
    MONEY("Capital pendiente", "principal"),
    TEXT("Tasa", "rate", 10),
    TEXT("Método", "method", 30),
    NUM("Renovaciones", "renewals", 14),
    TEXT("Estado", "lifecycle", 14),
    DATE("Cerrado", "closedOn"),
  ],
  async run(organizationId, filters) {
    const window = dateWindow(filters);

    const loans = await prisma.loan.findMany({
      where: {
        organizationId,
        archivedAt: null,
        ...(Object.keys(window).length ? { disbursedOn: window } : {}),
        ...(filters.clientId ? { clientId: filters.clientId } : {}),
        ...(filters.status && filters.status !== "ALL"
          ? { lifecycle: filters.status as "ACTIVE" }
          : {}),
        ...(filters.periodicity
          ? { periodicity: filters.periodicity as "MONTHLY" }
          : {}),
      },
      orderBy: { disbursedOn: "desc" },
      select: {
        code: true,
        disbursedOn: true,
        originalPrincipal: true,
        outstandingPrincipal: true,
        ratePercent: true,
        periodicity: true,
        interestMethod: true,
        renewalCount: true,
        lifecycle: true,
        closedOn: true,
        client: { select: { fullName: true } },
      },
    });

    const rows: ReportRow[] = loans.map((loan) => ({
      code: loan.code,
      client: loan.client.fullName,
      disbursedOn: fromPrismaDate(loan.disbursedOn),
      original: fromDb(loan.originalPrincipal).toDatabaseString(),
      principal: fromDb(loan.outstandingPrincipal).toDatabaseString(),
      rate: `${loan.ratePercent.toFixed()}% ${loan.periodicity}`,
      method:
        loan.interestMethod === "SIMPLE_ON_ORIGINAL_PRINCIPAL"
          ? "Simple sobre capital original"
          : "Sobre saldo pendiente",
      renewals: loan.renewalCount,
      lifecycle: loan.lifecycle,
      closedOn: loan.closedOn ? fromPrismaDate(loan.closedOn) : null,
    }));

    return {
      rows,
      totals: {
        code: "TOTAL",
        original: sumColumn(rows, "original"),
        principal: sumColumn(rows, "principal"),
      },
    };
  },
};

// --- Payments ----------------------------------------------------------------

const pagos: ReportDefinition = {
  id: "pagos",
  label: "Pagos",
  description: "Cada pago con el destino exacto de cada peso",
  filters: ["from", "to", "clientId"],
  columns: [
    TEXT("Recibo", "receipt", 14),
    DATE("Fecha", "paidOn"),
    TEXT("Cliente", "client", 28),
    TEXT("Préstamo", "loan", 14),
    MONEY("Recibido", "amount"),
    MONEY("A interés", "interest"),
    MONEY("A capital", "principal"),
    MONEY("Otros", "fees"),
    TEXT("Método", "method", 14),
    TEXT("Estado", "status", 12),
  ],
  async run(organizationId, filters) {
    const window = dateWindow(filters);

    const payments = await prisma.payment.findMany({
      where: {
        organizationId,
        ...(Object.keys(window).length ? { paidOn: window } : {}),
        ...(filters.clientId ? { clientId: filters.clientId } : {}),
      },
      orderBy: { paidOn: "desc" },
      select: {
        receiptNumber: true,
        paidOn: true,
        amount: true,
        status: true,
        client: { select: { fullName: true } },
        loan: { select: { code: true } },
        paymentMethod: { select: { name: true } },
        allocations: { select: { kind: true, amount: true } },
      },
    });

    const rows: ReportRow[] = payments.map((payment) => {
      let interest = Money.zero();
      let principal = Money.zero();
      let fees = Money.zero();

      for (const allocation of payment.allocations) {
        const value = fromDb(allocation.amount);
        if (allocation.kind === "INTEREST") interest = interest.plus(value);
        else if (allocation.kind === "PRINCIPAL") principal = principal.plus(value);
        else fees = fees.plus(value);
      }

      return {
        receipt: payment.receiptNumber,
        paidOn: fromPrismaDate(payment.paidOn),
        client: payment.client.fullName,
        loan: payment.loan.code,
        amount: fromDb(payment.amount).toDatabaseString(),
        interest: interest.toDatabaseString(),
        principal: principal.toDatabaseString(),
        fees: fees.toDatabaseString(),
        method: payment.paymentMethod?.name ?? "—",
        status: payment.status === "POSTED" ? "Registrado" : "Anulado",
      };
    });

    return {
      rows,
      totals: {
        receipt: "TOTAL",
        amount: sumColumn(rows, "amount"),
        interest: sumColumn(rows, "interest"),
        principal: sumColumn(rows, "principal"),
        fees: sumColumn(rows, "fees"),
      },
    };
  },
};

/** Allocation-level reports: one row per peso destination, not per payment. */
function allocationReport(
  id: string,
  label: string,
  description: string,
  kind: "PRINCIPAL" | "INTEREST",
): ReportDefinition {
  return {
    id,
    label,
    description,
    filters: ["from", "to", "clientId"],
    columns: [
      DATE("Fecha", "paidOn"),
      TEXT("Recibo", "receipt", 14),
      TEXT("Cliente", "client", 28),
      TEXT("Préstamo", "loan", 14),
      MONEY("Valor", "amount"),
    ],
    async run(organizationId, filters) {
      const window = dateWindow(filters);

      const allocations = await prisma.paymentAllocation.findMany({
        where: {
          organizationId,
          kind,
          payment: {
            status: "POSTED",
            ...(Object.keys(window).length ? { paidOn: window } : {}),
            ...(filters.clientId ? { clientId: filters.clientId } : {}),
          },
        },
        orderBy: { payment: { paidOn: "desc" } },
        select: {
          amount: true,
          payment: {
            select: {
              receiptNumber: true,
              paidOn: true,
              client: { select: { fullName: true } },
              loan: { select: { code: true } },
            },
          },
        },
      });

      const rows: ReportRow[] = allocations.map((allocation) => ({
        paidOn: fromPrismaDate(allocation.payment.paidOn),
        receipt: allocation.payment.receiptNumber,
        client: allocation.payment.client.fullName,
        loan: allocation.payment.loan.code,
        amount: fromDb(allocation.amount).toDatabaseString(),
      }));

      return {
        rows,
        totals: { paidOn: "TOTAL", amount: sumColumn(rows, "amount") },
      };
    },
  };
}

const interesesPendientes: ReportDefinition = {
  id: "intereses-pendientes",
  label: "Intereses pendientes",
  description: "Períodos causados que siguen sin pagarse",
  filters: ["from", "to", "clientId"],
  columns: [
    DATE("Vencimiento", "dueOn"),
    TEXT("Cliente", "client", 28),
    TEXT("Préstamo", "loan", 14),
    NUM("Período", "index", 10),
    MONEY("Causado", "accrued"),
    MONEY("Pagado", "paid"),
    MONEY("Pendiente", "outstanding"),
    TEXT("Estado", "status", 14),
  ],
  async run(organizationId, filters) {
    const window = dateWindow(filters);

    const periods = await prisma.loanPeriod.findMany({
      where: {
        organizationId,
        status: { in: ["PENDING", "PARTIALLY_PAID"] },
        ...(Object.keys(window).length ? { dueOn: window } : {}),
        loan: {
          archivedAt: null,
          lifecycle: "ACTIVE",
          ...(filters.clientId ? { clientId: filters.clientId } : {}),
        },
      },
      orderBy: { dueOn: "asc" },
      select: {
        periodIndex: true,
        dueOn: true,
        interestAccrued: true,
        interestPaid: true,
        interestWaived: true,
        status: true,
        loan: {
          select: { code: true, client: { select: { fullName: true } } },
        },
      },
    });

    const rows: ReportRow[] = periods
      .map((period) => {
        const accrued = fromDb(period.interestAccrued);
        const paid = fromDb(period.interestPaid);
        return {
          dueOn: fromPrismaDate(period.dueOn),
          client: period.loan.client.fullName,
          loan: period.loan.code,
          index: period.periodIndex,
          accrued: accrued.toDatabaseString(),
          paid: paid.toDatabaseString(),
          outstanding: accrued
            .minus(paid)
            .minus(fromDb(period.interestWaived))
            .toDatabaseString(),
          status: period.status === "PENDING" ? "Pendiente" : "Parcial",
        };
      })
      .filter((row) => Number(row.outstanding) > 0);

    return {
      rows,
      totals: {
        dueOn: "TOTAL",
        accrued: sumColumn(rows, "accrued"),
        paid: sumColumn(rows, "paid"),
        outstanding: sumColumn(rows, "outstanding"),
      },
    };
  },
};

const renovaciones: ReportDefinition = {
  id: "renovaciones",
  label: "Renovaciones",
  description: "Cada renovación con el cambio de capital",
  filters: ["from", "to", "clientId"],
  columns: [
    DATE("Fecha", "effectiveOn"),
    TEXT("Cliente", "client", 28),
    TEXT("Préstamo", "loan", 14),
    NUM("N°", "sequence", 8),
    MONEY("Capital antes", "before"),
    MONEY("Capital después", "after"),
    MONEY("Capital entregado", "disbursed"),
    MONEY("Capital recibido", "collected"),
    MONEY("Interés cobrado", "interest"),
    DATE("Nuevo vence", "newDueOn"),
  ],
  async run(organizationId, filters) {
    const window = dateWindow(filters);

    const renewals = await prisma.renewal.findMany({
      where: {
        organizationId,
        reversedAt: null,
        ...(Object.keys(window).length ? { effectiveOn: window } : {}),
        ...(filters.clientId ? { loan: { clientId: filters.clientId } } : {}),
      },
      orderBy: { effectiveOn: "desc" },
      select: {
        effectiveOn: true,
        sequence: true,
        previousPrincipalBase: true,
        newPrincipalBase: true,
        additionalDisbursed: true,
        principalCollected: true,
        interestCollected: true,
        newDueOn: true,
        loan: {
          select: { code: true, client: { select: { fullName: true } } },
        },
      },
    });

    const rows: ReportRow[] = renewals.map((renewal) => ({
      effectiveOn: fromPrismaDate(renewal.effectiveOn),
      client: renewal.loan.client.fullName,
      loan: renewal.loan.code,
      sequence: renewal.sequence,
      before: fromDb(renewal.previousPrincipalBase).toDatabaseString(),
      after: fromDb(renewal.newPrincipalBase).toDatabaseString(),
      disbursed: fromDb(renewal.additionalDisbursed).toDatabaseString(),
      collected: fromDb(renewal.principalCollected).toDatabaseString(),
      interest: fromDb(renewal.interestCollected).toDatabaseString(),
      newDueOn: fromPrismaDate(renewal.newDueOn),
    }));

    return {
      rows,
      totals: {
        effectiveOn: "TOTAL",
        disbursed: sumColumn(rows, "disbursed"),
        collected: sumColumn(rows, "collected"),
        interest: sumColumn(rows, "interest"),
      },
    };
  },
};

// --- Income and expense ------------------------------------------------------

function entryReport(
  id: string,
  label: string,
  description: string,
  table: "income" | "expense",
): ReportDefinition {
  return {
    id,
    label,
    description,
    filters: ["from", "to"],
    columns: [
      DATE("Fecha", "occurredOn"),
      TEXT("Categoría", "category", 24),
      TEXT("Concepto", "concept", 34),
      MONEY("Valor", "amount"),
      TEXT("Registró", "user", 20),
    ],
    async run(organizationId, filters) {
      const window = dateWindow(filters);
      const where = {
        organizationId,
        reversedAt: null,
        ...(Object.keys(window).length ? { occurredOn: window } : {}),
      };
      const select = {
        occurredOn: true,
        amount: true,
        concept: true,
        category: { select: { name: true } },
        createdBy: { select: { name: true } },
      } as const;

      const entries =
        table === "income"
          ? await prisma.incomeEntry.findMany({
              where,
              orderBy: { occurredOn: "desc" },
              select,
            })
          : await prisma.expenseEntry.findMany({
              where,
              orderBy: { occurredOn: "desc" },
              select,
            });

      const rows: ReportRow[] = entries.map((entry) => ({
        occurredOn: fromPrismaDate(entry.occurredOn),
        category: entry.category.name,
        concept: entry.concept,
        amount: fromDb(entry.amount).toDatabaseString(),
        user: entry.createdBy?.name ?? "—",
      }));

      return {
        rows,
        totals: { occurredOn: "TOTAL", amount: sumColumn(rows, "amount") },
      };
    },
  };
}

const flujoCaja: ReportDefinition = {
  id: "flujo-caja",
  label: "Flujo de caja",
  description: "Todos los movimientos, con su clasificación contable",
  filters: ["from", "to"],
  columns: [
    DATE("Fecha", "occurredOn"),
    TEXT("Tipo", "type", 24),
    TEXT("Clase", "class", 22),
    TEXT("Detalle", "note", 40),
    MONEY("Entrada", "in"),
    MONEY("Salida", "out"),
    TEXT("Mueve caja", "affectsCash", 12),
  ],
  async run(organizationId, filters) {
    const window = dateWindow(filters);

    const movements = await prisma.cashMovement.findMany({
      where: {
        organizationId,
        reversedAt: null,
        ...(Object.keys(window).length ? { occurredOn: window } : {}),
      },
      orderBy: [{ occurredOn: "desc" }, { postedAt: "desc" }],
      select: {
        occurredOn: true,
        type: true,
        direction: true,
        amount: true,
        financialClass: true,
        affectsCash: true,
        note: true,
      },
    });

    const rows: ReportRow[] = movements.map((movement) => ({
      occurredOn: fromPrismaDate(movement.occurredOn),
      type: MOVEMENT_LABEL[movement.type],
      class: movement.financialClass,
      note: movement.note,
      in:
        movement.direction === "IN"
          ? fromDb(movement.amount).toDatabaseString()
          : "0.00",
      out:
        movement.direction === "OUT"
          ? fromDb(movement.amount).toDatabaseString()
          : "0.00",
      affectsCash: movement.affectsCash ? "Sí" : "No",
    }));

    return {
      rows,
      totals: {
        occurredOn: "TOTAL",
        in: sumColumn(rows, "in"),
        out: sumColumn(rows, "out"),
      },
    };
  },
};

const cierres: ReportDefinition = {
  id: "cierres",
  label: "Cierres de caja",
  description: "Cada cierre diario con su diferencia",
  filters: ["from", "to"],
  columns: [
    DATE("Fecha", "closureDate"),
    MONEY("Saldo inicial", "opening"),
    MONEY("Entradas", "in"),
    MONEY("Salidas", "out"),
    MONEY("Esperado", "expected"),
    MONEY("Contado", "counted"),
    MONEY("Diferencia", "difference"),
    TEXT("Cerró", "user", 20),
  ],
  async run(organizationId, filters) {
    const window = dateWindow(filters);

    const closures = await prisma.cashClosure.findMany({
      where: {
        organizationId,
        ...(Object.keys(window).length ? { closureDate: window } : {}),
      },
      orderBy: { closureDate: "desc" },
      select: {
        closureDate: true,
        openingBalance: true,
        totalIn: true,
        totalOut: true,
        expectedBalance: true,
        countedBalance: true,
        difference: true,
        closedBy: { select: { name: true } },
      },
    });

    const rows: ReportRow[] = closures.map((closure) => ({
      closureDate: fromPrismaDate(closure.closureDate),
      opening: fromDb(closure.openingBalance).toDatabaseString(),
      in: fromDb(closure.totalIn).toDatabaseString(),
      out: fromDb(closure.totalOut).toDatabaseString(),
      expected: fromDb(closure.expectedBalance).toDatabaseString(),
      counted: fromDb(closure.countedBalance).toDatabaseString(),
      difference: fromDb(closure.difference).toDatabaseString(),
      user: closure.closedBy?.name ?? "—",
    }));

    return {
      rows,
      totals: { closureDate: "TOTAL", difference: sumColumn(rows, "difference") },
    };
  },
};

// --- Result ------------------------------------------------------------------

const utilidad: ReportDefinition = {
  id: "utilidad",
  label: "Utilidad",
  description: "Resultado por mes cerrado, desde los snapshots congelados",
  filters: [],
  columns: [
    TEXT("Mes", "month", 12),
    MONEY("Intereses cobrados", "interest"),
    MONEY("Otros ingresos", "other"),
    MONEY("Ingresos operativos", "income"),
    MONEY("Gastos operativos", "expenses"),
    MONEY("Utilidad neta", "profit"),
    MONEY("Utilidad devengada", "accrual"),
  ],
  async run(organizationId) {
    const snapshots = await prisma.periodSnapshot.findMany({
      where: { organizationId, kind: "MONTHLY", status: "CLOSED" },
      orderBy: { periodStart: "asc" },
      select: {
        periodYear: true,
        periodIndex: true,
        interestCollected: true,
        otherIncome: true,
        operatingExpenses: true,
        netProfitCash: true,
        netProfitAccrual: true,
      },
    });

    const rows: ReportRow[] = snapshots.map((snapshot) => {
      const interest = fromDb(snapshot.interestCollected);
      const other = fromDb(snapshot.otherIncome);
      return {
        month: formatMonthShort(snapshot.periodYear, snapshot.periodIndex),
        interest: interest.toDatabaseString(),
        other: other.toDatabaseString(),
        income: interest.plus(other).toDatabaseString(),
        expenses: fromDb(snapshot.operatingExpenses).toDatabaseString(),
        profit: fromDb(snapshot.netProfitCash).toDatabaseString(),
        accrual: fromDb(snapshot.netProfitAccrual).toDatabaseString(),
      };
    });

    return {
      rows,
      totals: {
        month: "TOTAL",
        interest: sumColumn(rows, "interest"),
        other: sumColumn(rows, "other"),
        income: sumColumn(rows, "income"),
        expenses: sumColumn(rows, "expenses"),
        profit: sumColumn(rows, "profit"),
        accrual: sumColumn(rows, "accrual"),
      },
    };
  },
};

const rentabilidadMensual: ReportDefinition = {
  id: "rentabilidad-mensual",
  label: "Rentabilidad mensual",
  description: "Patrimonio, cartera e indicadores de cada cierre",
  filters: [],
  columns: [
    TEXT("Mes", "month", 12),
    MONEY("Patrimonio inicial", "openingEquity"),
    MONEY("Patrimonio final", "closingEquity"),
    MONEY("Utilidad neta", "profit"),
    MONEY("Capital colocado", "principal"),
    MONEY("Capital disponible", "cash"),
    MONEY("Cartera pendiente", "portfolio"),
    MONEY("Cartera vencida", "overdue"),
    PCT("Morosidad", "delinquency"),
    NUM("Clientes", "clients", 10),
    NUM("Préstamos", "loans", 10),
  ],
  async run(organizationId) {
    const snapshots = await prisma.periodSnapshot.findMany({
      where: { organizationId, kind: "MONTHLY", status: "CLOSED" },
      orderBy: { periodStart: "asc" },
      select: {
        periodYear: true,
        periodIndex: true,
        openingEquity: true,
        closingEquity: true,
        netProfitCash: true,
        principalOutstanding: true,
        cashAvailable: true,
        portfolioOutstanding: true,
        portfolioOverdue: true,
        activeClients: true,
        activeLoans: true,
      },
    });

    const rows: ReportRow[] = snapshots.map((snapshot) => {
      const portfolio = fromDb(snapshot.portfolioOutstanding);
      const overdue = fromDb(snapshot.portfolioOverdue);

      return {
        month: formatMonthShort(snapshot.periodYear, snapshot.periodIndex),
        openingEquity: fromDb(snapshot.openingEquity).toDatabaseString(),
        closingEquity: fromDb(snapshot.closingEquity).toDatabaseString(),
        profit: fromDb(snapshot.netProfitCash).toDatabaseString(),
        principal: fromDb(snapshot.principalOutstanding).toDatabaseString(),
        cash: fromDb(snapshot.cashAvailable).toDatabaseString(),
        portfolio: portfolio.toDatabaseString(),
        overdue: overdue.toDatabaseString(),
        // Point 73: no portfolio means no ratio, not a zero.
        delinquency: portfolio.isZero()
          ? null
          : Number(
              overdue
                .toDecimal()
                .dividedBy(portfolio.toDecimal())
                .times(100)
                .toFixed(2),
            ),
        clients: snapshot.activeClients,
        loans: snapshot.activeLoans,
      };
    });

    return { rows };
  },
};

export const REPORTS: readonly ReportDefinition[] = [
  carteraGeneral,
  carteraVencida,
  clientes,
  prestamos,
  pagos,
  allocationReport(
    "abonos-capital",
    "Abonos a capital",
    "Cada peso que se aplicó a reducir capital",
    "PRINCIPAL",
  ),
  allocationReport(
    "intereses-cobrados",
    "Intereses cobrados",
    "Cada peso cobrado como interés",
    "INTEREST",
  ),
  interesesPendientes,
  renovaciones,
  entryReport("ingresos", "Ingresos", "Ingresos operativos registrados a mano", "income"),
  entryReport("egresos", "Egresos", "Gastos operativos registrados", "expense"),
  utilidad,
  flujoCaja,
  cierres,
  rentabilidadMensual,
];

export function findReport(id: string): ReportDefinition | undefined {
  return REPORTS.find((report) => report.id === id);
}
