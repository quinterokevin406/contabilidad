import { hash } from "@node-rs/argon2";

import type { FinancialClass, Prisma } from "@/generated/prisma";

type Tx = Prisma.TransactionClient;

/**
 * Everything a fresh installation needs before anyone can log in.
 *
 * Idempotent: running it twice updates rather than duplicating, so an operator
 * can safely re-run the seed after editing .env.
 */

export interface BootstrapInput {
  organizationName: string;
  organizationSlug: string;
  adminEmail: string;
  adminPassword: string;
  adminName: string;
}

export interface BootstrapResult {
  organizationId: string;
  adminUserId: string;
  cashAccountId: string;
  paymentMethods: Record<string, string>;
  expenseCategories: Record<string, string>;
  incomeCategories: Record<string, string>;
}

/**
 * Argon2id parameters.
 *
 * Deliberately stated rather than left to defaults: these are a security
 * decision, and a reviewer should be able to see them. 19 MiB of memory with two
 * iterations is the OWASP baseline for interactive logins.
 */
const ARGON2 = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2);
}

/** Default expense categories (point 74). All of them editable afterwards. */
const EXPENSE_CATEGORIES: readonly { key: string; name: string }[] = [
  { key: "transport", name: "Transporte" },
  { key: "fuel", name: "Combustible" },
  { key: "payroll", name: "Nómina" },
  { key: "commissions", name: "Comisiones" },
  { key: "advertising", name: "Publicidad" },
  { key: "utilities", name: "Servicios" },
  { key: "stationery", name: "Papelería" },
  { key: "technology", name: "Tecnología" },
  { key: "professional_fees", name: "Honorarios" },
  { key: "taxes", name: "Impuestos" },
  { key: "other_expense", name: "Otros" },
];

/**
 * Default income categories (point 75).
 *
 * "Intereses cobrados" exists so every report can label interest consistently,
 * but it is a SYSTEM category: interest is derived from payment allocations, and
 * the income service refuses manual entries against system categories. That is
 * what stops recovered capital from ever being reclassified as earnings by hand.
 */
const INCOME_CATEGORIES: readonly {
  key: string;
  name: string;
  financialClass: FinancialClass;
  isSystem: boolean;
}[] = [
  {
    key: "interest_collected",
    name: "Intereses cobrados",
    financialClass: "INTEREST",
    isSystem: true,
  },
  {
    key: "other_operating_income",
    name: "Otros ingresos operativos",
    financialClass: "OPERATING_INCOME",
    isSystem: false,
  },
  {
    key: "other_income",
    name: "Otros",
    financialClass: "OPERATING_INCOME",
    isSystem: false,
  },
];

const PAYMENT_METHODS: readonly { key: string; name: string }[] = [
  { key: "cash", name: "Efectivo" },
  { key: "transfer", name: "Transferencia" },
  { key: "other", name: "Otro" },
];

export async function bootstrap(
  tx: Tx,
  input: BootstrapInput,
): Promise<BootstrapResult> {
  const organization = await tx.organization.upsert({
    where: { slug: input.organizationSlug },
    update: { name: input.organizationName },
    create: {
      slug: input.organizationSlug,
      name: input.organizationName,
      status: "ACTIVE",
    },
    select: { id: true },
  });

  const organizationId = organization.id;

  await tx.organizationSettings.upsert({
    where: { organizationId },
    update: {},
    create: {
      organizationId,
      businessName: input.organizationName,
      currencyCode: "COP",
      timeZone: "America/Bogota",
      locale: "es-CO",
      defaultInterestMethod: "SIMPLE_ON_ORIGINAL_PRINCIPAL",
      defaultPeriodicity: "MONTHLY",
      defaultAllocationStrategy: "INTEREST_FIRST",
      defaultPeriodAnchor: "CALENDAR",
      defaultRoundingMode: "HALF_UP",
      // Whole pesos: nobody charges centavos in Colombia.
      moneyQuantum: "1",
      defaultOpenPeriodPolicy: "FULL_PERIOD",
      defaultRenewalDueBasis: "PREVIOUS_DUE_DATE",
      dueSoonLeadDays: 3,
      overdueGraceDays: 0,
      receiptPrefix: "REC",
    },
  });

  const adminUser = await tx.user.upsert({
    where: {
      organizationId_email: { organizationId, email: input.adminEmail },
    },
    update: { name: input.adminName },
    create: {
      organizationId,
      email: input.adminEmail,
      name: input.adminName,
      passwordHash: await hashPassword(input.adminPassword),
      role: "ADMIN",
      status: "ACTIVE",
    },
    select: { id: true },
  });

  const cashAccount = await tx.cashAccount.upsert({
    where: { organizationId_name: { organizationId, name: "Caja principal" } },
    update: {},
    create: {
      organizationId,
      name: "Caja principal",
      openingBalance: "0",
      openedOn: new Date(Date.UTC(2026, 0, 1)),
      isDefault: true,
      isActive: true,
    },
    select: { id: true },
  });

  const paymentMethods: Record<string, string> = {};
  for (const [index, method] of PAYMENT_METHODS.entries()) {
    const row = await tx.paymentMethod.upsert({
      where: { organizationId_name: { organizationId, name: method.name } },
      update: {},
      create: {
        organizationId,
        name: method.name,
        systemKey: method.key,
        sortOrder: index,
        isActive: true,
      },
      select: { id: true },
    });
    paymentMethods[method.key] = row.id;
  }

  const expenseCategories: Record<string, string> = {};
  for (const [index, category] of EXPENSE_CATEGORIES.entries()) {
    const row = await tx.transactionCategory.upsert({
      where: {
        organizationId_name_financialClass: {
          organizationId,
          name: category.name,
          financialClass: "OPERATING_EXPENSE",
        },
      },
      update: {},
      create: {
        organizationId,
        name: category.name,
        financialClass: "OPERATING_EXPENSE",
        systemKey: category.key,
        isSystem: false,
        sortOrder: index,
        isActive: true,
      },
      select: { id: true },
    });
    expenseCategories[category.key] = row.id;
  }

  const incomeCategories: Record<string, string> = {};
  for (const [index, category] of INCOME_CATEGORIES.entries()) {
    const row = await tx.transactionCategory.upsert({
      where: {
        organizationId_name_financialClass: {
          organizationId,
          name: category.name,
          financialClass: category.financialClass,
        },
      },
      update: {},
      create: {
        organizationId,
        name: category.name,
        financialClass: category.financialClass,
        systemKey: category.key,
        isSystem: category.isSystem,
        sortOrder: index,
        isActive: true,
      },
      select: { id: true },
    });
    incomeCategories[category.key] = row.id;
  }

  return {
    organizationId,
    adminUserId: adminUser.id,
    cashAccountId: cashAccount.id,
    paymentMethods,
    expenseCategories,
    incomeCategories,
  };
}
