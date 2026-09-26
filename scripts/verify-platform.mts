/**
 * Proof that suspending a customer locks the door without touching the books.
 *
 * The commercial reason this screen exists is to stop someone who has not paid.
 * The obligation that comes with it is that their business survives untouched
 * while they are locked out — a lender who lost their records over a late
 * subscription would be entitled to sue, and would be right.
 *
 * So this counts every financial row before and after, and refuses to accept a
 * suspension that changed any of them.
 */

import { prisma, tenantTransaction } from "@/infra/db/client";
import { createSystemClient } from "@/infra/db/system-client";
import { withSystemAccess } from "@/infra/db/tenancy";
import { listOrganizations } from "@/server/platform/queries";
import { setOrganizationStatus } from "@/services/platform/set-organization-status";

const system = createSystemClient();

let failures = 0;

function check(label: string, pass: boolean, detail = "") {
  if (!pass) failures += 1;
  console.log(
    `  ${pass ? "OK  " : "FALLA"} ${label}${detail ? ` — ${detail}` : ""}`,
  );
}

/** Every row that represents money or a customer of the lender. */
async function financialFootprint(organizationId: string) {
  const [clients, loans, periods, payments, allocations, movements] =
    await Promise.all([
      system.client.count({ where: { organizationId } }),
      system.loan.count({ where: { organizationId } }),
      system.loanPeriod.count({ where: { organizationId } }),
      system.payment.count({ where: { organizationId } }),
      system.paymentAllocation.count({ where: { organizationId } }),
      system.cashMovement.count({ where: { organizationId } }),
    ]);
  return { clients, loans, periods, payments, allocations, movements };
}

const actor = { userId: null, email: "verificacion@plataforma" };

async function main() {
  const org = await system.organization.findFirstOrThrow({
    select: { id: true, name: true, status: true },
  });

  if (org.status !== "ACTIVE") {
    throw new Error(
      `La organización de prueba está ${org.status}. Reactivala antes de correr esto.`,
    );
  }

  console.log(`\nNegocio de prueba: ${org.name}\n`);

  const before = await financialFootprint(org.id);
  console.log("1. Suspender no toca ni una fila financiera");

  await withSystemAccess(() =>
    tenantTransaction((tx) =>
      setOrganizationStatus(tx, {
        organizationId: org.id,
        status: "SUSPENDED",
        reason: "Verificación automática de la plataforma",
        actor,
      }),
    ),
  );

  const after = await financialFootprint(org.id);

  for (const key of Object.keys(before) as (keyof typeof before)[]) {
    check(
      `${key} intactos`,
      before[key] === after[key],
      `${before[key]} → ${after[key]}`,
    );
  }

  // --- The guard reads this, so it is what actually cuts access -----------

  console.log("\n2. El acceso queda cortado");

  const suspended = await system.organization.findUniqueOrThrow({
    where: { id: org.id },
    select: { status: true },
  });
  check("la organización figura SUSPENDED", suspended.status === "SUSPENDED");

  // Exactly the shape src/server/auth/dal.ts reads on every single request.
  const asTheGuardSeesIt = await system.user.findFirst({
    where: { organizationId: org.id, archivedAt: null },
    select: { id: true, status: true, organization: { select: { status: true } } },
  });
  check(
    "la verificación de sesión ve la organización suspendida",
    asTheGuardSeesIt?.organization.status === "SUSPENDED",
    "dal.ts devuelve null y manda al login",
  );
  check(
    "el usuario en sí NO fue desactivado",
    asTheGuardSeesIt?.status === "ACTIVE",
    "se cierra la puerta, no se borra a la persona",
  );

  // --- The customer can see why -------------------------------------------

  console.log("\n3. El cliente puede ver por qué");

  const entry = await system.auditLog.findFirst({
    where: { organizationId: org.id, entity: "Organization" },
    orderBy: { createdAt: "desc" },
    select: { organizationId: true, reason: true, summary: true },
  });
  check(
    "la anotación queda en el historial del propio cliente",
    entry?.organizationId === org.id,
  );
  check(
    "con el motivo escrito",
    entry?.reason === "Verificación automática de la plataforma",
    entry?.reason ?? "sin motivo",
  );

  // --- No refusing twice ---------------------------------------------------

  console.log("\n4. No se suspende dos veces");

  let refused = false;
  try {
    await withSystemAccess(() =>
      tenantTransaction((tx) =>
        setOrganizationStatus(tx, {
          organizationId: org.id,
          status: "SUSPENDED",
          reason: "Intento repetido de suspensión",
          actor,
        }),
      ),
    );
  } catch {
    refused = true;
  }
  check("el segundo intento fue rechazado", refused);

  let reasonRequired = false;
  try {
    await withSystemAccess(() =>
      tenantTransaction((tx) =>
        setOrganizationStatus(tx, {
          organizationId: org.id,
          status: "ACTIVE",
          reason: "ok",
          actor,
        }),
      ),
    );
  } catch {
    reasonRequired = true;
  }
  check("no se acepta sin un motivo escrito", reasonRequired);

  // --- Reactivating restores the business ---------------------------------

  console.log("\n5. Reactivar devuelve el negocio como estaba");

  await withSystemAccess(() =>
    tenantTransaction((tx) =>
      setOrganizationStatus(tx, {
        organizationId: org.id,
        status: "ACTIVE",
        reason: "Fin de la verificación automática",
        actor,
      }),
    ),
  );

  const restored = await system.organization.findUniqueOrThrow({
    where: { id: org.id },
    select: { status: true },
  });
  check("la organización vuelve a ACTIVE", restored.status === "ACTIVE");

  const finalCounts = await financialFootprint(org.id);
  check(
    "todas las filas financieras siguen ahí",
    JSON.stringify(finalCounts) === JSON.stringify(before),
    `${before.payments} pagos, ${before.movements} movimientos`,
  );

  // --- The screen must not become a window into the books -----------------

  console.log("\n6. La pantalla no expone dinero");

  const summaries = await listOrganizations();
  const fields = new Set(summaries.flatMap((s) => Object.keys(s)));
  const moneyish = [...fields].filter((f) =>
    /amount|balance|total|principal|interest|saldo|monto/i.test(f),
  );
  check(
    "ningún campo con importes",
    moneyish.length === 0,
    moneyish.length ? `encontrados: ${moneyish.join(", ")}` : [...fields].join(", "),
  );

  console.log(
    failures === 0
      ? "\nTodo en orden.\n"
      : `\n${failures} comprobación(es) fallaron.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await system.$disconnect();
    await prisma.$disconnect();
  });
