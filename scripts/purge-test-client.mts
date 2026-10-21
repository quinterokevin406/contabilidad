/**
 * Removes a test client from the command line.
 *
 *   npm run client:purge -- CL-000003
 *   npm run client:purge -- CL-000003 --force
 *
 * The same thing the delete button does, for an operator who would rather work
 * from a terminal or who is cleaning up before handing the system over. It
 * deliberately holds NO rules of its own: everything it is allowed to do comes
 * from src/services/clients/purge-client.ts, which is the one file in the
 * system permitted to delete a financial row and the one `verify:no-deletion`
 * watches. Two copies of a rule like that drift apart, and the copy that drifts
 * is the one nobody is testing.
 */

import { createSystemClient } from "@/infra/db/system-client";
import { previewPurge, purgeClient } from "@/services/clients/purge-client";

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
    select: { id: true, organizationId: true },
  });

  if (!client) bail(`No hay ningún cliente con el código ${code}.`);

  const input = {
    organizationId: client.organizationId,
    clientId: client.id,
    actor: { userId: null, email: "purga@terminal" },
  };

  const preview = await prisma.$transaction((tx) => previewPurge(tx, input));

  console.log(`\n  ${preview.code} — ${preview.fullName}\n`);
  console.log(`  préstamos:            ${preview.loans.length}`);
  for (const l of preview.loans) {
    console.log(`     ${l.code} · capital ${l.principal}`);
  }
  console.log(`  períodos:             ${preview.periods}`);
  console.log(`  desembolsos en caja:  ${preview.disbursements}`);

  if (preview.blockedBecause) {
    bail(`  NO SE PUEDE BORRAR\n\n  ${preview.blockedBecause}`);
  }

  if (!force) {
    console.log(
      "\n  Nada fue borrado. Esto NO se puede deshacer: volvé a correrlo con\n" +
        "  --force si estás seguro de que son datos de prueba.\n",
    );
    return;
  }

  const result = await prisma.$transaction((tx) => purgeClient(tx, input));

  console.log(
    `\n  ${result.code} eliminado. La caja vuelve a quedar como antes del\n` +
      "  desembolso, y queda una anotación en el historial de que esto pasó.\n",
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
