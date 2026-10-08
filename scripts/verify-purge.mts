/**
 * Proof that purging a test client leaves the books exactly as it found them.
 *
 * This is the one piece of deletion code in the whole system, which makes it
 * the one that has to be watched hardest. Two things must be true: it refuses
 * anything that carries real history, and when it does run, the cash position
 * ends at the number it started at — because the disbursement it removes is
 * money that never actually left.
 *
 * It creates its own client and loan in the test database, purges them, and
 * checks the ledger before and after. Unlike the other checks this one does
 * NOT roll back: the thing being verified is a command-line tool that commits.
 */

import { spawnSync } from "node:child_process";

import { Money } from "@/core/money/money";
import { addDays, todayIn } from "@/core/time/calendar-date";
import { createSystemClient } from "@/infra/db/system-client";
import { fromDb } from "@/infra/db/money";
import { createClient } from "@/services/clients/create-client";
import { createLoan } from "@/services/loans/create-loan";

const prisma = createSystemClient();
const TZ = "America/Bogota";

let failures = 0;

function check(label: string, pass: boolean, detail = "") {
  if (!pass) failures += 1;
  console.log(
    `  ${pass ? "OK  " : "FALLA"} ${label}${detail ? ` — ${detail}` : ""}`,
  );
}

/** Everything in the till, derived from the movements as the app does it. */
async function cashPosition(organizationId: string): Promise<string> {
  const rows = await prisma.cashMovement.findMany({
    where: { organizationId, affectsCash: true },
    select: { amount: true, direction: true },
  });
  return rows
    .reduce(
      (sum, r) =>
        r.direction === "IN"
          ? sum.plus(fromDb(r.amount))
          : sum.minus(fromDb(r.amount)),
      Money.zero(),
    )
    .toString();
}

function runPurge(code: string, force: boolean) {
  return spawnSync(
    "npx",
    [
      "tsx",
      "--conditions=react-server",
      "--env-file=.env.test",
      "scripts/purge-test-client.mts",
      code,
      ...(force ? ["--force"] : []),
    ],
    { encoding: "utf8", shell: true },
  );
}

async function main() {
  const org = await prisma.organization.findFirstOrThrow({
    select: { id: true },
  });
  const today = todayIn(TZ);
  const actor = { userId: null, email: "verificacion@purga" };

  const cashBefore = await cashPosition(org.id);
  const clientsBefore = await prisma.client.count({
    where: { organizationId: org.id },
  });

  console.log(`\nCaja antes de todo: ${cashBefore}\n`);

  // --- A client and a loan, exactly like a first-hour test ----------------

  console.log("1. Se crea un cliente de prueba con un préstamo");

  const made = await prisma.$transaction(async (tx) => {
    const client = await createClient(tx, {
      organizationId: org.id,
      fullName: "Purga Automatica De Prueba",
      documentNumber: `P${Date.now()}`.slice(0, 12),
      actor,
    });
    const loan = await createLoan(tx, {
      organizationId: org.id,
      clientId: client.clientId,
      principal: Money.of("750000"),
      ratePercent: "10",
      periodicity: "MONTHLY",
      interestMethod: "SIMPLE_ON_ORIGINAL_PRINCIPAL",
      allocationStrategy: "INTEREST_FIRST",
      periodAnchor: "CALENDAR",
      roundingMode: "HALF_UP",
      moneyQuantum: "1",
      openPeriodPolicy: "FULL_PERIOD",
      renewalDueBasis: "PREVIOUS_DUE_DATE",
      disbursedOn: today,
      firstDueOn: addDays(today, 30),
      actor,
      idempotencyKey: `purge_${crypto.randomUUID()}`,
    });
    return { client, loan };
  });

  const cashAfterLoan = await cashPosition(org.id);
  check(
    "el desembolso bajó la caja",
    cashAfterLoan !== cashBefore,
    `${cashBefore} → ${cashAfterLoan}`,
  );

  // --- Without --force it must only report ---------------------------------

  console.log("\n2. Sin --force no toca nada");

  const dry = runPurge(made.client.code, false);
  const stillThere = await prisma.client.count({
    where: { id: made.client.clientId },
  });
  check("sigue existiendo después de la simulación", stillThere === 1);
  check(
    "avisa que no borró nada",
    (dry.stdout ?? "").includes("Nada fue borrado"),
  );

  // --- With --force it removes it and the till comes back ------------------

  console.log("\n3. Con --force borra y la caja vuelve a su lugar");

  const real = runPurge(made.client.code, true);
  check("el comando terminó bien", real.status === 0, `exit ${real.status}`);

  const gone = await prisma.client.count({
    where: { id: made.client.clientId },
  });
  check("el cliente ya no está", gone === 0);

  const loanGone = await prisma.loan.count({
    where: { id: made.loan.loanId },
  });
  check("el préstamo ya no está", loanGone === 0);

  const periodsGone = await prisma.loanPeriod.count({
    where: { loanId: made.loan.loanId },
  });
  check("sus períodos ya no están", periodsGone === 0);

  const cashAfterPurge = await cashPosition(org.id);
  check(
    "la caja volvió EXACTAMENTE a como estaba",
    cashAfterPurge === cashBefore,
    `${cashAfterPurge} vs ${cashBefore}`,
  );

  const clientsAfter = await prisma.client.count({
    where: { organizationId: org.id },
  });
  check(
    "no se llevó puesto a nadie más",
    clientsAfter === clientsBefore,
    `${clientsBefore} antes, ${clientsAfter} después`,
  );

  // --- The record of the removal survives ----------------------------------

  console.log("\n4. Queda constancia de que se borró");

  const note = await prisma.auditLog.findFirst({
    where: { entityId: made.client.clientId },
    orderBy: { createdAt: "desc" },
    select: { summary: true, reason: true },
  });
  check(
    "hay una anotación en el historial",
    Boolean(note?.summary?.includes(made.client.code)),
    note?.summary ?? "ninguna",
  );

  // --- And it still refuses anything with a payment ------------------------

  console.log("\n5. Sigue negándose con historia real");

  const withPayment = await prisma.client.findFirst({
    where: { organizationId: org.id, payments: { some: {} } },
    select: { code: true },
  });

  if (!withPayment) {
    console.log("  (sin clientes con pagos en esta base; se omite)");
  } else {
    const refused = runPurge(withPayment.code, true);
    check("rechaza a quien ya recibió pagos", refused.status !== 0);
    check(
      "y explica que hay que archivarlo",
      (refused.stderr ?? "").includes("archivarlo"),
    );
  }

  console.log(
    failures === 0
      ? "\nBorra solo lo que nunca movió plata, y deja la caja intacta.\n"
      : `\n${failures} comprobación(es) fallaron.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
