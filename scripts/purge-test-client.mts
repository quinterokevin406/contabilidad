/**
 * Removes a TEST client and everything that was created for them.
 *
 *   npm run client:purge -- CL-000003
 *   npm run client:purge -- CL-000003 --force
 *
 * WHY THIS IS A COMMAND AND NOT A BUTTON. The application has no code path
 * that deletes a client, a loan, a payment or a cash movement, and
 * `verify:no-deletion` reads the source on every run to keep it that way. That
 * guarantee is worth more than the convenience of a button, so this lives out
 * here instead: it needs shell access to the server, which whoever owns the
 * installation has and nobody else does.
 *
 * It exists for one situation only — the test entries everybody makes in the
 * first hour, before the first real client. It refuses the moment there is
 * anything that resembles a real history:
 *
 *   - any payment received, even one
 *   - any renewal, settlement or reversal
 *   - any cash movement that is not the loan's own disbursement
 *
 * If any of those exist, the right answer is to archive the client, not to
 * erase evidence. The refusal says so.
 */

import { createSystemClient } from "@/infra/db/system-client";

const prisma = createSystemClient();

const args = process.argv.slice(2);
const force = args.includes("--force");
const code = args.find((a) => !a.startsWith("--"))?.toUpperCase();

function bail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

async function main() {
  if (!code) {
    bail(
      [
        "  npm run client:purge -- <código del cliente>",
        "  npm run client:purge -- <código del cliente> --force",
        "",
        "  El código es el que aparece en su ficha, por ejemplo CL-000003.",
      ].join("\n"),
    );
  }

  const client = await prisma.client.findFirst({
    where: { code },
    select: {
      id: true,
      code: true,
      fullName: true,
      createdAt: true,
      organizationId: true,
      _count: { select: { loans: true, payments: true, cashMovements: true } },
    },
  });

  if (!client) bail(`No hay ningún cliente con el código ${code}.`);

  // --- The refusals, in the order that matters -----------------------------

  if (client._count.payments > 0) {
    bail(
      `${client.fullName} ya recibió ${client._count.payments} pago(s).\n\n` +
        "Eso es historia real: el recibo existe, la plata entró a la caja y los\n" +
        "reportes lo cuentan. Borrarlo destruiría la prueba de algo que pasó.\n\n" +
        "Lo que corresponde es archivarlo desde su ficha. Si todavía tiene un\n" +
        "préstamo activo, liquidalo o cancelalo primero.",
    );
  }

  const loans = await prisma.loan.findMany({
    where: { clientId: client.id },
    select: {
      id: true,
      code: true,
      outstandingPrincipal: true,
      _count: { select: { periods: true, renewals: true, payments: true } },
    },
  });

  const renewals = loans.reduce((n, l) => n + l._count.renewals, 0);
  if (renewals > 0) {
    bail(`${client.fullName} tiene ${renewals} renovación(es). No es prueba.`);
  }

  const settlements = await prisma.settlement.count({
    where: { loan: { clientId: client.id } },
  });
  if (settlements > 0) {
    bail(`${client.fullName} tiene ${settlements} liquidación(es). No es prueba.`);
  }

  // Everything in the ledger that belongs to this client. A disbursement is
  // expected — one per loan. Anything else means money moved in a way this
  // tool has no business undoing.
  const movements = await prisma.cashMovement.findMany({
    where: { clientId: client.id },
    select: { id: true, type: true, amount: true },
  });

  const unexpected = movements.filter((m) => m.type !== "LOAN_DISBURSEMENT");
  if (unexpected.length > 0) {
    bail(
      `${client.fullName} tiene ${unexpected.length} movimiento(s) de caja que no\n` +
        `son desembolsos: ${[...new Set(unexpected.map((m) => m.type))].join(", ")}.\n\n` +
        "Archivalo en vez de borrarlo.",
    );
  }

  // --- What would go --------------------------------------------------------

  const periods = loans.reduce((n, l) => n + l._count.periods, 0);

  console.log(`\n  ${client.code} — ${client.fullName}`);
  console.log(`  registrado el ${client.createdAt.toISOString().slice(0, 10)}\n`);
  console.log(`  préstamos:            ${loans.length}`);
  for (const l of loans) {
    console.log(`     ${l.code} · capital ${l.outstandingPrincipal.toString()}`);
  }
  console.log(`  períodos:             ${periods}`);
  console.log(`  desembolsos en caja:  ${movements.length}`);
  console.log(`  pagos recibidos:      0`);

  if (!force) {
    console.log(
      "\n  Nada fue borrado. Esto NO se puede deshacer: volvé a correrlo con\n" +
        "  --force si estás seguro de que son datos de prueba.\n",
    );
    return;
  }

  // --- Do it ---------------------------------------------------------------

  await prisma.$transaction(async (tx) => {
    const loanIds = loans.map((l) => l.id);

    if (loanIds.length > 0) {
      await tx.cashMovement.deleteMany({ where: { loanId: { in: loanIds } } });
      await tx.loanPeriod.deleteMany({ where: { loanId: { in: loanIds } } });
      await tx.loan.deleteMany({ where: { id: { in: loanIds } } });
    }
    await tx.cashMovement.deleteMany({ where: { clientId: client.id } });
    await tx.clientTagLink.deleteMany({ where: { clientId: client.id } });
    await tx.client.delete({ where: { id: client.id } });

    // The client is gone; the note that they were removed is not. Somebody
    // reading the history in a year should find out what happened to CL-000003
    // rather than wonder why the numbering skips.
    await tx.auditLog.create({
      data: {
        organizationId: client.organizationId,
        action: "ARCHIVE",
        entity: "Client",
        entityId: client.id,
        summary: `${client.code} ${client.fullName} eliminado como dato de prueba`,
        reason:
          `Sin pagos recibidos. Se borraron ${loans.length} préstamo(s), ` +
          `${periods} período(s) y ${movements.length} desembolso(s).`,
        actorId: null,
        actorEmail: "purga@terminal",
        beforeValues: {
          code: client.code,
          fullName: client.fullName,
          loans: loans.map((l) => l.code),
        },
      },
    });
  });

  console.log(
    `\n  ${client.code} eliminado. La caja vuelve a quedar como antes del\n` +
      "  desembolso, y queda una anotación en el historial de que esto pasó.\n",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
