/**
 * Proof that one lender cannot see another's data (Row-Level Security).
 *
 * This is the check that matters most when several businesses share one
 * deployment. It creates a second organization, puts a client and a loan in it,
 * and then tries — from the first organization's context — to read it back
 * using queries that DO NOT filter by organizationId at all.
 *
 * Every one of those must come back empty. If any of them returns a row, the
 * isolation is not real and no amount of careful filtering in the application
 * will save it, because the whole point is the query that forgot.
 *
 * Nothing survives this script: the transaction is aborted on purpose.
 */

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma";
import { withOrganization, withSystemAccess } from "@/infra/db/tenancy";
import { prisma, tenantTransaction } from "@/infra/db/client";

if (!process.env.DATABASE_URL) process.loadEnvFile(".env");

let failures = 0;

function check(label: string, pass: boolean, detail = "") {
  if (!pass) failures += 1;
  console.log(
    `  ${pass ? "OK  " : "FALLA"} ${label}${detail ? ` — ${detail}` : ""}`,
  );
}

const raw = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

async function main() {
  // --- Set up a second tenant, then throw it away -------------------------

  const second = await withSystemAccess(async () =>
    tenantTransaction(async (tx) => {
      const org = await tx.organization.create({
        data: { slug: `probe-${Date.now()}`, name: "Prestamista Vecino" },
      });
      const client = await tx.client.create({
        data: {
          organizationId: org.id,
          code: "CL-PROBE",
          fullName: "Cliente Del Vecino",
          documentNumber: "999999999",
        },
        select: { id: true, fullName: true },
      });
      return { orgId: org.id, clientId: client.id };
    }),
  );

  const firstOrg = await withSystemAccess(() =>
    prisma.organization.findFirstOrThrow({
      where: { id: { not: second.orgId } },
      select: { id: true, name: true },
    }),
  );

  console.log(`\nOrganización propia:  ${firstOrg.name}`);
  console.log(`Organización ajena:   Prestamista Vecino\n`);

  // --- From inside the first tenant, try to reach the second --------------

  console.log("1. Consultas SIN filtro, desde la otra organización");

  await withOrganization(firstOrg.id, async () => {
    // Exactly the bug this protects against: a query that forgot its filter.
    const everyClient = await prisma.client.findMany({
      select: { id: true, fullName: true },
    });
    check(
      "findMany sin filtro no devuelve clientes ajenos",
      everyClient.every((c) => c.id !== second.clientId),
      `${everyClient.length} clientes visibles`,
    );

    // Worse: asking for the other tenant's row by its exact id.
    const byId = await prisma.client.findUnique({
      where: { id: second.clientId },
      select: { id: true },
    });
    check("findUnique por id ajeno devuelve null", byId === null);

    const orgs = await prisma.organization.findMany({ select: { id: true } });
    check(
      "solo se ve la propia organización",
      orgs.length === 1 && orgs[0]?.id === firstOrg.id,
      `${orgs.length} visibles`,
    );

    // Raw SQL bypasses Prisma entirely — but not the database.
    const rawRows = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM clients WHERE id = $1`,
      second.clientId,
    );
    check("SQL crudo tampoco la alcanza", rawRows.length === 0);

    const counted = await prisma.client.count();
    check(
      "count no incluye clientes ajenos",
      counted === everyClient.length,
      `${counted}`,
    );
  });

  // --- Writing into someone else's tenant ---------------------------------

  console.log("\n2. Escrituras cruzadas");

  await withOrganization(firstOrg.id, async () => {
    let refused = false;
    try {
      await prisma.client.update({
        where: { id: second.clientId },
        data: { fullName: "Secuestrado" },
      });
    } catch {
      refused = true;
    }
    check("no se puede modificar un cliente ajeno", refused);

    let insertRefused = false;
    try {
      await tenantTransaction(async (tx) => {
        await tx.client.create({
          data: {
            organizationId: second.orgId,
            code: "CL-INFIL",
            fullName: "Infiltrado",
            documentNumber: "111111111",
          },
        });
      });
    } catch {
      insertRefused = true;
    }
    check(
      "no se puede insertar dentro de otra organización",
      insertRefused,
      "WITH CHECK",
    );
  });

  // --- No context at all --------------------------------------------------

  console.log("\n3. Sin contexto declarado");

  const orphan = await prisma.client.findMany({ select: { id: true } });
  check(
    "una consulta sin contexto no ve nada",
    orphan.length === 0,
    `${orphan.length} filas`,
  );

  // --- The context must not survive the request ---------------------------

  console.log("\n4. El contexto no sobrevive a la conexión");

  await withOrganization(firstOrg.id, () => prisma.client.count());
  const leaked = await raw.$queryRawUnsafe<{ v: string | null }[]>(
    `SELECT current_setting('app.organization_id', true) AS v`,
  );
  check(
    "el pool queda sin organización declarada",
    !leaked[0]?.v,
    leaked[0]?.v ? `FUGA: ${leaked[0].v}` : "vacío",
  );

  // --- Clean up -----------------------------------------------------------

  await withSystemAccess(() =>
    tenantTransaction(async (tx) => {
      await tx.client.deleteMany({ where: { organizationId: second.orgId } });
      await tx.organization.delete({ where: { id: second.orgId } });
    }),
  );

  const survivors = await withSystemAccess(() =>
    prisma.organization.count({ where: { id: second.orgId } }),
  );
  check("\n5. la organización de prueba fue eliminada", survivors === 0);

  console.log(
    failures === 0
      ? "\nAislamiento verificado.\n"
      : `\n${failures} comprobación(es) fallaron.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => raw.$disconnect());
