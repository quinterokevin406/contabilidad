import { Money } from "@/core/money/money";
import {
  addMonths,
  calendarDate,
  startOfMonth,
  toPrismaDate,
  type CalendarDate,
} from "@/core/time/calendar-date";
import type { CapitalChange } from "@/core/loans/renewal";
import type {
  AllocationStrategy,
  InterestMethod,
  Periodicity,
  Prisma,
} from "@/generated/prisma";
import { toDb } from "@/infra/db/money";
import { closePeriod } from "@/services/analytics/close-period";
import { accrueLoan, refreshLoanState } from "@/services/loans/accrue";
import { createLoan } from "@/services/loans/create-loan";
import { renewLoan } from "@/services/loans/renew";
import { postPayment } from "@/services/payments/post-payment";
import { recordCashMovement, type Actor } from "@/services/shared";

import type { BootstrapResult } from "./bootstrap";

type Tx = Prisma.TransactionClient;

const d = calendarDate;

/**
 * Demo dataset (point 49).
 *
 * Built by REPLAYING real operations through the real services, on their real
 * dates, rather than by inserting rows. That matters: hand-written rows would
 * look plausible on screen while the till, the portfolio and the growth metrics
 * quietly disagreed with each other. Driving the services means the demo data is
 * arithmetically sound by construction, and it doubles as an end-to-end exercise
 * of the whole financial engine.
 */

const SETTINGS = { dueSoonLeadDays: 3, overdueGraceDays: 0 } as const;

interface ClientSpec {
  key: string;
  fullName: string;
  documentNumber: string;
  phone: string;
  city: string;
  address: string;
  referenceName: string;
  referencePhone: string;
  createdOn: CalendarDate;
  status?: "ACTIVE" | "INACTIVE" | "BLOCKED";
  notes?: string;
}

const CLIENTS: readonly ClientSpec[] = [
  {
    key: "juan",
    fullName: "Juan Pérez Molina",
    documentNumber: "1032456789",
    phone: "3012345678",
    city: "Bogotá",
    address: "Calle 45 # 12-30, Chapinero",
    referenceName: "Marta Molina",
    referencePhone: "3109876543",
    createdOn: d("2026-03-20"),
  },
  {
    key: "maria",
    fullName: "María Rodríguez Ñungo",
    documentNumber: "52987654",
    phone: "3145556677",
    city: "Bogotá",
    address: "Carrera 68 # 24-15, Salitre",
    referenceName: "Jorge Rodríguez",
    referencePhone: "3001112233",
    createdOn: d("2026-05-05"),
  },
  {
    key: "carlos",
    fullName: "Carlos López Ávila",
    documentNumber: "79456123",
    phone: "3208889900",
    city: "Medellín",
    address: "Calle 10 # 40-22, El Poblado",
    referenceName: "Sandra Ávila",
    referencePhone: "3187776655",
    createdOn: d("2026-04-10"),
  },
  {
    key: "andres",
    fullName: "Andrés Gómez Castaño",
    documentNumber: "1017889900",
    phone: "3123334455",
    city: "Bogotá",
    address: "Diagonal 22 # 55-10, Kennedy",
    referenceName: "Paula Castaño",
    referencePhone: "3156667788",
    createdOn: d("2026-06-15"),
    notes: "Cliente con historial de atrasos. Revisar antes de renovar.",
  },
  {
    key: "luisa",
    fullName: "Luisa Martínez Peña",
    documentNumber: "1098765432",
    phone: "3134445566",
    city: "Cali",
    address: "Avenida 6N # 23-40, Granada",
    referenceName: "Hernán Peña",
    referencePhone: "3172223344",
    createdOn: d("2026-07-25"),
  },
  {
    key: "ricardo",
    fullName: "Ricardo Sánchez Duarte",
    documentNumber: "80123456",
    phone: "3009998877",
    city: "Bogotá",
    address: "Calle 80 # 100-25, Engativá",
    referenceName: "Claudia Duarte",
    referencePhone: "3115554433",
    createdOn: d("2026-04-28"),
  },
  {
    key: "patricia",
    fullName: "Patricia Herrera Ocampo",
    documentNumber: "43567890",
    phone: "3167778899",
    city: "Medellín",
    address: "Carrera 70 # 45-18, Laureles",
    referenceName: "Andrés Ocampo",
    referencePhone: "3024445566",
    createdOn: d("2026-05-18"),
  },
  {
    key: "jorge",
    fullName: "Jorge Iván Muñoz Realpe",
    documentNumber: "94876543",
    phone: "3182223311",
    city: "Cali",
    address: "Calle 5 # 38-70, San Fernando",
    referenceName: "Liliana Realpe",
    referencePhone: "3193334422",
    createdOn: d("2026-06-02"),
  },
  {
    key: "diana",
    fullName: "Diana Carolina Vargas Ruiz",
    documentNumber: "1026778899",
    phone: "3053334477",
    city: "Bogotá",
    address: "Transversal 15 # 120-45, Usaquén",
    referenceName: "Camilo Vargas",
    referencePhone: "3046667799",
    createdOn: d("2026-03-28"),
  },
  {
    key: "esteban",
    fullName: "Esteban Quintero Ibáñez",
    documentNumber: "71234567",
    phone: "3141119988",
    city: "Barranquilla",
    address: "Carrera 53 # 76-30, El Prado",
    referenceName: "Rocío Ibáñez",
    referencePhone: "3158882277",
    createdOn: d("2026-08-08"),
    status: "INACTIVE",
    notes: "Liquidó su préstamo y no ha solicitado uno nuevo.",
  },
];

type DemoEvent =
  | { kind: "payment"; on: CalendarDate; amount: string; note?: string }
  | {
      kind: "principal";
      on: CalendarDate;
      interest: string;
      principal: string;
      note?: string;
    }
  | {
      kind: "renewal";
      on: CalendarDate;
      interestPaid: string;
      capital: CapitalChange;
      note?: string;
    };

interface LoanSpec {
  clientKey: string;
  principal: string;
  ratePercent: string;
  periodicity: Periodicity;
  customPeriodDays?: number;
  interestMethod: InterestMethod;
  allocationStrategy?: AllocationStrategy;
  disbursedOn: CalendarDate;
  firstDueOn: CalendarDate;
  notes?: string;
  events: readonly DemoEvent[];
}

/**
 * Fifteen loans covering every screen the product has: on-time, partially paid,
 * overdue across several aging buckets, renewed, renewed with more capital,
 * reduced by a capital payment, and fully settled. Amounts are deliberately round
 * so any figure on screen can be checked by hand.
 */
const LOANS: readonly LoanSpec[] = [
  // 1. Textbook case from the specification: pays its interest every month.
  {
    clientKey: "juan",
    principal: "1000000",
    ratePercent: "20",
    periodicity: "MONTHLY",
    interestMethod: "SIMPLE_ON_ORIGINAL_PRINCIPAL",
    disbursedOn: d("2026-03-24"),
    firstDueOn: d("2026-04-24"),
    notes: "Cliente puntual. Paga el interés cada mes.",
    events: [
      { kind: "payment", on: d("2026-04-24"), amount: "200000" },
      { kind: "payment", on: d("2026-05-24"), amount: "200000" },
      { kind: "payment", on: d("2026-06-24"), amount: "200000" },
      { kind: "payment", on: d("2026-07-24"), amount: "200000" },
      { kind: "payment", on: d("2026-08-24"), amount: "200000" },
      { kind: "payment", on: d("2026-09-24"), amount: "200000" },
    ],
  },

  // 2. Partial payment, then two missed periods: overdue in the 31-60 bucket.
  {
    clientKey: "maria",
    principal: "3000000",
    ratePercent: "15",
    periodicity: "MONTHLY",
    interestMethod: "SIMPLE_ON_OUTSTANDING_PRINCIPAL",
    disbursedOn: d("2026-05-10"),
    firstDueOn: d("2026-06-10"),
    events: [
      { kind: "payment", on: d("2026-06-10"), amount: "450000" },
      { kind: "payment", on: d("2026-07-10"), amount: "200000", note: "Abono parcial" },
    ],
  },

  // 3. Renewed twice, the second time taking more capital (point 14).
  {
    clientKey: "carlos",
    principal: "5000000",
    ratePercent: "18",
    periodicity: "MONTHLY",
    interestMethod: "SIMPLE_ON_ORIGINAL_PRINCIPAL",
    disbursedOn: d("2026-04-15"),
    firstDueOn: d("2026-05-15"),
    events: [
      {
        kind: "renewal",
        on: d("2026-05-15"),
        interestPaid: "900000",
        capital: { kind: "UNCHANGED" },
      },
      {
        kind: "renewal",
        on: d("2026-06-15"),
        interestPaid: "900000",
        capital: { kind: "INCREASE", additionalDisbursed: "2000000" },
        note: "Solicita capital adicional",
      },
      { kind: "payment", on: d("2026-07-15"), amount: "1260000" },
      { kind: "payment", on: d("2026-08-15"), amount: "1260000" },
      { kind: "payment", on: d("2026-09-15"), amount: "1260000" },
    ],
  },

  // 4. Never paid: three periods overdue, lands in the 61-90 bucket.
  {
    clientKey: "andres",
    principal: "2000000",
    ratePercent: "20",
    periodicity: "MONTHLY",
    interestMethod: "SIMPLE_ON_ORIGINAL_PRINCIPAL",
    disbursedOn: d("2026-06-20"),
    firstDueOn: d("2026-07-20"),
    notes: "Sin pagos desde el desembolso.",
    events: [],
  },

  // 5. Weekly schedule, paying on time.
  {
    clientKey: "luisa",
    principal: "800000",
    ratePercent: "5",
    periodicity: "WEEKLY",
    interestMethod: "SIMPLE_ON_ORIGINAL_PRINCIPAL",
    disbursedOn: d("2026-08-01"),
    firstDueOn: d("2026-08-08"),
    events: [
      { kind: "payment", on: d("2026-08-08"), amount: "40000" },
      { kind: "payment", on: d("2026-08-15"), amount: "40000" },
      { kind: "payment", on: d("2026-08-22"), amount: "40000" },
      { kind: "payment", on: d("2026-08-29"), amount: "40000" },
      { kind: "payment", on: d("2026-09-05"), amount: "40000" },
      { kind: "payment", on: d("2026-09-12"), amount: "40000" },
      { kind: "payment", on: d("2026-09-19"), amount: "40000" },
    ],
  },

  // 6. Capital reduction: interest plus a principal payment (point 15).
  {
    clientKey: "ricardo",
    principal: "4000000",
    ratePercent: "16",
    periodicity: "MONTHLY",
    interestMethod: "SIMPLE_ON_OUTSTANDING_PRINCIPAL",
    disbursedOn: d("2026-05-02"),
    firstDueOn: d("2026-06-02"),
    events: [
      { kind: "payment", on: d("2026-06-02"), amount: "640000" },
      {
        kind: "principal",
        on: d("2026-07-02"),
        interest: "640000",
        principal: "1000000",
        note: "Abono a capital",
      },
      // Balance is now 3.000.000, so interest drops to 480.000.
      { kind: "payment", on: d("2026-08-02"), amount: "480000" },
      { kind: "payment", on: d("2026-09-02"), amount: "480000" },
    ],
  },

  // 7. Biweekly, one period behind.
  {
    clientKey: "patricia",
    principal: "1500000",
    ratePercent: "8",
    periodicity: "BIWEEKLY",
    interestMethod: "SIMPLE_ON_ORIGINAL_PRINCIPAL",
    disbursedOn: d("2026-07-05"),
    firstDueOn: d("2026-07-20"),
    events: [
      { kind: "payment", on: d("2026-07-20"), amount: "120000" },
      { kind: "payment", on: d("2026-08-04"), amount: "120000" },
      { kind: "payment", on: d("2026-08-19"), amount: "120000" },
      { kind: "payment", on: d("2026-09-03"), amount: "120000" },
    ],
  },

  // 8. Overdue in the 16-30 bucket.
  {
    clientKey: "jorge",
    principal: "2500000",
    ratePercent: "17",
    periodicity: "MONTHLY",
    interestMethod: "SIMPLE_ON_ORIGINAL_PRINCIPAL",
    disbursedOn: d("2026-06-05"),
    firstDueOn: d("2026-07-05"),
    events: [{ kind: "payment", on: d("2026-07-05"), amount: "425000" }],
  },

  // 9. Large, healthy, renewed once.
  {
    clientKey: "diana",
    principal: "8000000",
    ratePercent: "14",
    periodicity: "MONTHLY",
    interestMethod: "SIMPLE_ON_ORIGINAL_PRINCIPAL",
    disbursedOn: d("2026-03-30"),
    firstDueOn: d("2026-04-30"),
    events: [
      {
        kind: "renewal",
        on: d("2026-04-30"),
        interestPaid: "1120000",
        capital: { kind: "UNCHANGED" },
      },
      { kind: "payment", on: d("2026-05-30"), amount: "1120000" },
      { kind: "payment", on: d("2026-06-30"), amount: "1120000" },
      { kind: "payment", on: d("2026-07-30"), amount: "1120000" },
      { kind: "payment", on: d("2026-08-30"), amount: "1120000" },
    ],
  },

  // 10. Settled in full: interest plus the entire principal (point 16).
  {
    clientKey: "esteban",
    principal: "1200000",
    ratePercent: "20",
    periodicity: "MONTHLY",
    interestMethod: "SIMPLE_ON_ORIGINAL_PRINCIPAL",
    disbursedOn: d("2026-08-08"),
    firstDueOn: d("2026-09-08"),
    notes: "Liquidado anticipadamente.",
    events: [
      {
        kind: "principal",
        on: d("2026-09-08"),
        interest: "240000",
        principal: "1200000",
        note: "Liquidación total",
      },
    ],
  },

  // 11. Second loan for Juan: fresh, nothing due yet.
  {
    clientKey: "juan",
    principal: "600000",
    ratePercent: "20",
    periodicity: "MONTHLY",
    interestMethod: "SIMPLE_ON_ORIGINAL_PRINCIPAL",
    disbursedOn: d("2026-09-18"),
    firstDueOn: d("2026-10-18"),
    events: [],
  },

  // 12. Second loan for Carlos, custom 45-day schedule.
  {
    clientKey: "carlos",
    principal: "3500000",
    ratePercent: "22",
    periodicity: "CUSTOM",
    customPeriodDays: 45,
    interestMethod: "SIMPLE_ON_ORIGINAL_PRINCIPAL",
    disbursedOn: d("2026-06-01"),
    firstDueOn: d("2026-07-16"),
    events: [
      { kind: "payment", on: d("2026-07-16"), amount: "770000" },
      { kind: "payment", on: d("2026-08-30"), amount: "770000" },
    ],
  },

  // 13. Overdue in the 1-7 bucket: only just late.
  {
    clientKey: "patricia",
    principal: "900000",
    ratePercent: "19",
    periodicity: "MONTHLY",
    interestMethod: "SIMPLE_ON_ORIGINAL_PRINCIPAL",
    disbursedOn: d("2026-07-22"),
    firstDueOn: d("2026-08-22"),
    events: [{ kind: "payment", on: d("2026-08-22"), amount: "171000" }],
  },

  // 14. Deeply overdue: more than 90 days.
  {
    clientKey: "jorge",
    principal: "1800000",
    ratePercent: "20",
    periodicity: "MONTHLY",
    interestMethod: "SIMPLE_ON_ORIGINAL_PRINCIPAL",
    disbursedOn: d("2026-04-18"),
    firstDueOn: d("2026-05-18"),
    notes: "Cartera en mora profunda. Escalar cobranza.",
    events: [],
  },

  // 15. Second loan for María, paying on time.
  {
    clientKey: "maria",
    principal: "2200000",
    ratePercent: "16",
    periodicity: "MONTHLY",
    interestMethod: "SIMPLE_ON_ORIGINAL_PRINCIPAL",
    disbursedOn: d("2026-08-12"),
    firstDueOn: d("2026-09-12"),
    events: [{ kind: "payment", on: d("2026-09-12"), amount: "352000" }],
  },
];

/** Monthly operating expenses, so the profit and growth charts have shape. */
const EXPENSES: readonly {
  on: CalendarDate;
  categoryKey: string;
  amount: string;
  concept: string;
}[] = [
  { on: d("2026-03-31"), categoryKey: "transport", amount: "180000", concept: "Transporte de cobranza marzo" },
  { on: d("2026-04-30"), categoryKey: "transport", amount: "210000", concept: "Transporte de cobranza abril" },
  { on: d("2026-04-30"), categoryKey: "fuel", amount: "150000", concept: "Combustible abril" },
  { on: d("2026-05-31"), categoryKey: "transport", amount: "195000", concept: "Transporte de cobranza mayo" },
  { on: d("2026-05-31"), categoryKey: "stationery", amount: "60000", concept: "Papelería y recibos" },
  { on: d("2026-06-30"), categoryKey: "transport", amount: "230000", concept: "Transporte de cobranza junio" },
  { on: d("2026-06-30"), categoryKey: "technology", amount: "120000", concept: "Plan de datos y celular" },
  { on: d("2026-07-31"), categoryKey: "transport", amount: "240000", concept: "Transporte de cobranza julio" },
  { on: d("2026-07-31"), categoryKey: "commissions", amount: "400000", concept: "Comisión de cobranza julio" },
  { on: d("2026-08-31"), categoryKey: "transport", amount: "260000", concept: "Transporte de cobranza agosto" },
  { on: d("2026-08-31"), categoryKey: "commissions", amount: "450000", concept: "Comisión de cobranza agosto" },
  { on: d("2026-08-31"), categoryKey: "advertising", amount: "180000", concept: "Publicidad en redes" },
  { on: d("2026-09-20"), categoryKey: "transport", amount: "195000", concept: "Transporte de cobranza septiembre" },
  { on: d("2026-09-20"), categoryKey: "utilities", amount: "95000", concept: "Servicios oficina" },
];

const OTHER_INCOME: readonly {
  on: CalendarDate;
  amount: string;
  concept: string;
}[] = [
  { on: d("2026-06-18"), amount: "150000", concept: "Recuperación de gastos de cobranza" },
  { on: d("2026-08-25"), amount: "220000", concept: "Venta de equipo de oficina usado" },
];

export interface DemoResult {
  clients: number;
  loans: number;
  payments: number;
  renewals: number;
  expenses: number;
  incomes: number;
  closedMonths: number;
}

export async function seedDemo(
  tx: Tx,
  bootstrapped: BootstrapResult,
  today: CalendarDate,
): Promise<DemoResult> {
  const { organizationId, adminUserId, cashAccountId } = bootstrapped;

  const actor: Actor = {
    userId: adminUserId,
    email: null,
    ipAddress: null,
    userAgent: null,
  };

  const admin = await tx.user.findUnique({
    where: { id: adminUserId },
    select: { email: true },
  });
  actor.email = admin?.email ?? null;

  // The owner funds the business. Equity, never revenue -- which is exactly the
  // distinction the growth module depends on.
  const contribution = await tx.capitalEvent.create({
    data: {
      organizationId,
      kind: "CONTRIBUTION",
      amount: toDb(Money.of("60000000")),
      occurredOn: toPrismaDate(d("2026-03-01")),
      concept: "Aporte inicial del propietario",
      createdById: adminUserId,
    },
    select: { id: true },
  });

  await recordCashMovement(tx, {
    organizationId,
    cashAccountId,
    type: "CAPITAL_CONTRIBUTION",
    direction: "IN",
    amount: Money.of("60000000"),
    financialClass: "EQUITY_CONTRIBUTION",
    occurredOn: d("2026-03-01"),
    capitalEventId: contribution.id,
    note: "Aporte inicial del propietario",
    createdById: adminUserId,
  });

  // --- Clients -------------------------------------------------------------

  const clientIds = new Map<string, string>();

  for (const [index, spec] of CLIENTS.entries()) {
    const code = `CL-${String(index + 1).padStart(6, "0")}`;
    const client = await tx.client.create({
      data: {
        organizationId,
        code,
        fullName: spec.fullName,
        documentType: "CC",
        documentNumber: spec.documentNumber,
        phone: spec.phone,
        whatsappPhone: spec.phone,
        address: spec.address,
        city: spec.city,
        referenceName: spec.referenceName,
        referencePhone: spec.referencePhone,
        notes: spec.notes ?? null,
        status: spec.status ?? "ACTIVE",
        createdAt: toPrismaDate(spec.createdOn),
      },
      select: { id: true },
    });
    clientIds.set(spec.key, client.id);
  }

  // Keep the loan sequence aligned with the client codes already handed out.
  await tx.receiptSequence.upsert({
    where: { organizationId_scope: { organizationId, scope: "CLIENT" } },
    update: { lastNumber: CLIENTS.length },
    create: {
      organizationId,
      scope: "CLIENT",
      prefix: "CL",
      lastNumber: CLIENTS.length,
    },
  });

  // --- Loans and their history ---------------------------------------------

  let payments = 0;
  let renewals = 0;
  const loanIds: string[] = [];

  for (const spec of LOANS) {
    const clientId = clientIds.get(spec.clientKey);
    if (!clientId) throw new Error(`Unknown demo client: ${spec.clientKey}`);

    const created = await createLoan(tx, {
      organizationId,
      clientId,
      principal: spec.principal,
      ratePercent: spec.ratePercent,
      periodicity: spec.periodicity,
      customPeriodDays: spec.customPeriodDays ?? null,
      interestMethod: spec.interestMethod,
      allocationStrategy: spec.allocationStrategy ?? "INTEREST_FIRST",
      periodAnchor: spec.periodicity === "MONTHLY" ? "CALENDAR" : "FIXED_DAYS",
      roundingMode: "HALF_UP",
      moneyQuantum: "1",
      openPeriodPolicy: "FULL_PERIOD",
      renewalDueBasis: "PREVIOUS_DUE_DATE",
      disbursedOn: spec.disbursedOn,
      firstDueOn: spec.firstDueOn,
      notes: spec.notes ?? null,
      actor,
      cashAccountId,
    });

    loanIds.push(created.loanId);

    for (const event of spec.events) {
      switch (event.kind) {
        case "payment":
          await postPayment(tx, {
            organizationId,
            loanId: created.loanId,
            amount: event.amount,
            paidOn: event.on,
            paymentMethodId: bootstrapped.paymentMethods.cash ?? null,
            notes: event.note ?? null,
            actor,
            cashAccountId,
            settings: SETTINGS,
          });
          payments += 1;
          break;

        case "principal": {
          // Manual distribution: the operator states exactly how much goes to
          // interest and how much reduces the capital (point 11).
          //
          // The split has to be computed against periods that already exist, and
          // it is the payment that normally triggers accrual. So accrue first --
          // the same order the UI follows when it renders the manual allocation
          // form before submitting it.
          await accrueLoan(tx, created.loanId, event.on);

          const total = Money.of(event.interest).plus(event.principal);
          await postPayment(tx, {
            organizationId,
            loanId: created.loanId,
            amount: total,
            paidOn: event.on,
            paymentMethodId: bootstrapped.paymentMethods.transfer ?? null,
            strategy: "MANUAL_ONLY",
            manual: {
              interest: await interestSplit(tx, created.loanId, event.interest),
              principal: event.principal,
            },
            notes: event.note ?? null,
            actor,
            cashAccountId,
            settings: SETTINGS,
          });
          payments += 1;
          break;
        }

        case "renewal":
          await renewLoan(tx, {
            organizationId,
            loanId: created.loanId,
            interestPaid: event.interestPaid,
            capitalChange: event.capital,
            effectiveOn: event.on,
            paymentMethodId: bootstrapped.paymentMethods.cash ?? null,
            notes: event.note ?? null,
            actor,
            cashAccountId,
            settings: SETTINGS,
          });
          renewals += 1;
          break;
      }
    }
  }

  // Bring every loan up to today so overdue portfolio and aging are real.
  for (const loanId of loanIds) {
    await accrueLoan(tx, loanId, today);
    await refreshLoanState(tx, loanId, today, SETTINGS);
  }

  // --- Expenses and other income -------------------------------------------

  for (const expense of EXPENSES) {
    const categoryId = bootstrapped.expenseCategories[expense.categoryKey];
    if (!categoryId) continue;

    const row = await tx.expenseEntry.create({
      data: {
        organizationId,
        categoryId,
        amount: toDb(Money.of(expense.amount)),
        occurredOn: toPrismaDate(expense.on),
        concept: expense.concept,
        createdById: adminUserId,
      },
      select: { id: true },
    });

    await recordCashMovement(tx, {
      organizationId,
      cashAccountId,
      type: "EXPENSE",
      direction: "OUT",
      amount: Money.of(expense.amount),
      financialClass: "OPERATING_EXPENSE",
      occurredOn: expense.on,
      expenseId: row.id,
      note: expense.concept,
      createdById: adminUserId,
    });
  }

  const otherIncomeCategoryId = bootstrapped.incomeCategories.other_operating_income;

  for (const income of OTHER_INCOME) {
    if (!otherIncomeCategoryId) break;

    const row = await tx.incomeEntry.create({
      data: {
        organizationId,
        categoryId: otherIncomeCategoryId,
        amount: toDb(Money.of(income.amount)),
        occurredOn: toPrismaDate(income.on),
        concept: income.concept,
        createdById: adminUserId,
      },
      select: { id: true },
    });

    await recordCashMovement(tx, {
      organizationId,
      cashAccountId,
      type: "EXTRAORDINARY_INCOME",
      direction: "IN",
      amount: Money.of(income.amount),
      financialClass: "OPERATING_INCOME",
      occurredOn: income.on,
      incomeId: row.id,
      note: income.concept,
      createdById: adminUserId,
    });
  }

  // The owner takes a draw. Equity, never an expense.
  const withdrawal = await tx.capitalEvent.create({
    data: {
      organizationId,
      kind: "WITHDRAWAL",
      amount: toDb(Money.of("3000000")),
      occurredOn: toPrismaDate(d("2026-08-31")),
      concept: "Retiro del propietario",
      createdById: adminUserId,
    },
    select: { id: true },
  });

  await recordCashMovement(tx, {
    organizationId,
    cashAccountId,
    type: "OWNER_WITHDRAWAL",
    direction: "OUT",
    amount: Money.of("3000000"),
    financialClass: "EQUITY_WITHDRAWAL",
    occurredOn: d("2026-08-31"),
    capitalEventId: withdrawal.id,
    note: "Retiro del propietario",
    createdById: adminUserId,
  });

  // --- Goals and alert rules (points 85 and 86) ----------------------------

  await tx.goal.createMany({
    data: [
      {
        organizationId,
        kind: "EQUITY_TARGET",
        direction: "AT_LEAST",
        label: "Meta de capital",
        targetValue: "100000000",
        isActive: true,
      },
      {
        organizationId,
        kind: "MONTHLY_PROFIT",
        direction: "AT_LEAST",
        label: "Utilidad mensual",
        targetValue: "6000000",
        isActive: true,
      },
      {
        organizationId,
        kind: "MAX_DELINQUENCY_RATIO",
        direction: "AT_MOST",
        label: "Máximo de cartera vencida",
        targetValue: "10",
        isActive: true,
      },
      {
        organizationId,
        kind: "MAX_MONTHLY_EXPENSE",
        direction: "AT_MOST",
        label: "Máximo de gastos mensuales",
        targetValue: "1500000",
        isActive: true,
      },
    ],
  });

  await tx.alertRule.createMany({
    data: [
      {
        organizationId,
        metric: "DELINQUENCY_RATIO",
        comparator: "GREATER_THAN",
        threshold: "15",
        severity: "CRITICAL",
        label: "Cartera vencida por encima del 15%",
        isActive: true,
      },
      {
        organizationId,
        metric: "EXPENSE_TO_INCOME_RATIO",
        comparator: "GREATER_THAN",
        threshold: "40",
        severity: "WARNING",
        label: "Los gastos superan el 40% de los ingresos",
        isActive: true,
      },
      {
        organizationId,
        metric: "OVERDUE_LOAN_COUNT",
        comparator: "GREATER_OR_EQUAL",
        threshold: "5",
        severity: "WARNING",
        label: "Cinco o más préstamos en mora",
        isActive: true,
      },
      {
        organizationId,
        metric: "CASH_DISCREPANCY_ABS",
        comparator: "GREATER_THAN",
        threshold: "50000",
        severity: "CRITICAL",
        label: "Diferencia de caja superior a $50.000",
        isActive: true,
      },
    ],
  });

  // --- Historical monthly closures (points 70, 83) -------------------------
  //
  // Closed for every month that has actually ended, so the growth charts have
  // real frozen history to read instead of recomputing the past. Each snapshot
  // is derived from the ledger exactly as the application would derive it.

  let closedMonths = 0;
  const firstMonth = d("2026-03-01");
  const currentMonthStart = startOfMonth(today);

  for (
    let month = firstMonth;
    month < currentMonthStart;
    month = addMonths(month, 1)
  ) {
    await closePeriod(tx, {
      organizationId,
      kind: "MONTHLY",
      anyDateInside: month,
      today,
      actor,
    });
    closedMonths += 1;
  }

  return {
    clients: CLIENTS.length,
    loans: LOANS.length,
    payments,
    renewals,
    expenses: EXPENSES.length,
    incomes: OTHER_INCOME.length,
    closedMonths,
  };
}

/**
 * Splits a stated interest amount across the loan's open periods, oldest first.
 *
 * The manual distribution API names a period per interest amount, so this reads
 * the current open periods and spreads the operator's figure across them the same
 * way the automatic strategy would.
 */
async function interestSplit(
  tx: Tx,
  loanId: string,
  interestTotal: string,
): Promise<{ periodId: string; amount: string }[]> {
  const periods = await tx.loanPeriod.findMany({
    where: { loanId, status: { in: ["PENDING", "PARTIALLY_PAID"] } },
    orderBy: { periodIndex: "asc" },
    select: {
      id: true,
      interestAccrued: true,
      interestPaid: true,
      interestWaived: true,
    },
  });

  let remaining = Money.of(interestTotal);
  const split: { periodId: string; amount: string }[] = [];

  for (const period of periods) {
    if (!remaining.isPositive()) break;
    const owed = Money.of(period.interestAccrued.toFixed())
      .minus(period.interestPaid.toFixed())
      .minus(period.interestWaived.toFixed());
    if (!owed.isPositive()) continue;

    const applied = Money.min(owed, remaining);
    split.push({ periodId: period.id, amount: applied.toDatabaseString() });
    remaining = remaining.minus(applied);
  }

  if (remaining.isPositive()) {
    throw new Error(
      `Demo data error: ${interestTotal} of interest was specified for loan ` +
        `${loanId} but only ${Money.of(interestTotal).minus(remaining).toString()} ` +
        "is actually owed.",
    );
  }

  return split;
}
