/**
 * One-off check: exercise the client profile query against the real database and
 * assert its totals reconcile with the ledger.
 *
 * Compiling is not rendering, and a type-correct query can still return numbers
 * that disagree with the movements they came from. This runs the real query and
 * checks the arithmetic.
 */

import { Money } from "@/core/money/money";
import { fromDb } from "@/infra/db/money";
import { createSystemClient } from "@/infra/db/system-client";
import { enterOrganizationForProcess } from "@/infra/db/tenancy";

if (!process.env.DATABASE_URL) process.loadEnvFile(".env");

const prisma = createSystemClient();

let failures = 0;

function check(label: string, pass: boolean, detail: string) {
  const mark = pass ? "OK  " : "FALLA";
  if (!pass) failures += 1;
  console.log(`  ${mark} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const org = await prisma.organization.findFirstOrThrow({
    select: { id: true, name: true },
  });

  // Everything below queries through the application layer, which is scoped
  // by Row-Level Security like any request would be.
  enterOrganizationForProcess(org.id);

  const { getClientDetail } = await import("@/server/clients/detail");

  const clients = await prisma.client.findMany({
    where: { organizationId: org.id },
    select: { id: true, fullName: true },
    orderBy: { code: "asc" },
  });

  console.log(`\nVerificando ${clients.length} perfiles de cliente\n`);

  let totalPrincipal = Money.zero();
  let totalInterest = Money.zero();
  let totalPaidAll = Money.zero();

  for (const stub of clients) {
    const detail = await getClientDetail(org.id, stub.id);
    if (!detail) {
      check(stub.fullName, false, "el perfil no cargó");
      continue;
    }

    totalPrincipal = totalPrincipal.plus(detail.principalOutstanding);
    totalInterest = totalInterest.plus(detail.interestOutstanding);
    totalPaidAll = totalPaidAll.plus(detail.totalPaid);

    // The profile's own arithmetic must be internally consistent.
    const sum = detail.principalOutstanding.plus(detail.interestOutstanding);
    check(
      detail.fullName.padEnd(30),
      sum.equals(detail.totalOutstanding) &&
        !detail.principalOutstanding.isNegative() &&
        !detail.interestOutstanding.isNegative(),
      `saldo ${detail.totalOutstanding.toDatabaseString()} · ` +
        `pagado ${detail.totalPaid.toDatabaseString()} · ` +
        `${detail.timeline.length} eventos · ` +
        `${detail.activeLoans.length} activos`,
    );
  }

  console.log("\nContra el libro mayor:\n");

  // Outstanding principal across the profiles must equal the loans table.
  const loanSum = await prisma.loan.aggregate({
    where: { organizationId: org.id, lifecycle: "ACTIVE", archivedAt: null },
    _sum: { outstandingPrincipal: true },
  });
  const ledgerPrincipal = fromDb(
    loanSum._sum.outstandingPrincipal?.toFixed() ?? "0",
  );
  check(
    "capital pendiente = suma de préstamos activos",
    totalPrincipal.equals(ledgerPrincipal),
    `${totalPrincipal.toDatabaseString()} vs ${ledgerPrincipal.toDatabaseString()}`,
  );

  // Total paid across the profiles must equal every posted payment.
  const paymentSum = await prisma.payment.aggregate({
    where: { organizationId: org.id, status: "POSTED" },
    _sum: { amount: true },
  });
  const ledgerPaid = fromDb(paymentSum._sum.amount?.toFixed() ?? "0");
  check(
    "total pagado = suma de pagos registrados",
    totalPaidAll.equals(ledgerPaid),
    `${totalPaidAll.toDatabaseString()} vs ${ledgerPaid.toDatabaseString()}`,
  );

  // Outstanding interest must equal the open period rows.
  const periods = await prisma.loanPeriod.findMany({
    where: {
      organizationId: org.id,
      status: { in: ["PENDING", "PARTIALLY_PAID"] },
      loan: { lifecycle: "ACTIVE", archivedAt: null },
    },
    select: {
      interestAccrued: true,
      interestPaid: true,
      interestWaived: true,
    },
  });
  const ledgerInterest = periods.reduce((acc, p) => {
    const owed = fromDb(p.interestAccrued)
      .minus(fromDb(p.interestPaid))
      .minus(fromDb(p.interestWaived));
    return owed.isPositive() ? acc.plus(owed) : acc;
  }, Money.zero());
  check(
    "interés pendiente = suma de períodos abiertos",
    totalInterest.equals(ledgerInterest),
    `${totalInterest.toDatabaseString()} vs ${ledgerInterest.toDatabaseString()}`,
  );

  console.log(
    failures === 0
      ? "\nTodo cuadra.\n"
      : `\n${failures} verificaciones fallaron.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
