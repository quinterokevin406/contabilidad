/**
 * Suspends every business whose grace window has run out.
 *
 *   npm run billing:enforce -- --dry-run     (shows what it would do)
 *   npm run billing:enforce
 *
 * Meant to run once a day from cron or Task Scheduler. It only ever acts on
 * what the billing engine already decided: a trial is never touched, and
 * neither is someone who is merely late but still inside their grace days.
 *
 * DRY RUN FIRST, ALWAYS, the first time you wire it up. Cutting off a paying
 * customer because the clock or the grace days were set wrong costs more than
 * the month you were trying to collect.
 */

import { todayIn } from "@/core/time/calendar-date";
import { tenantTransaction } from "@/infra/db/client";
import { createSystemClient } from "@/infra/db/system-client";
import { withSystemAccess } from "@/infra/db/tenancy";
import { enforceSubscriptions } from "@/services/billing/record-payment";

const system = createSystemClient();
const dryRun = process.argv.includes("--dry-run");

async function main() {
  const settings = await system.organizationSettings.findFirst({
    select: { timeZone: true },
  });
  const timeZone = settings?.timeZone ?? "America/Bogota";
  const today = todayIn(timeZone);

  console.log(
    `\nCorte de mensualidades — ${today} (${timeZone})` +
      (dryRun ? "  [SIMULACIÓN]" : ""),
  );

  const result = await withSystemAccess(() =>
    tenantTransaction((tx) =>
      enforceSubscriptions(tx, {
        timeZone,
        actor: { userId: null, email: "cobranza@plataforma" },
        dryRun,
      }),
    ),
  );

  console.log(`  suscripciones revisadas: ${result.checked}`);

  if (result.suspended.length === 0) {
    console.log("  nadie para suspender.\n");
    return;
  }

  console.log(
    `\n  ${dryRun ? "Se suspenderían" : "Suspendidos"}: ${result.suspended.length}\n`,
  );
  for (const row of result.suspended) {
    console.log(`    ${row.name} — ${row.daysPastDue} días de atraso`);
  }

  if (dryRun) {
    console.log("\n  Nada fue modificado. Quitá --dry-run para aplicarlo.\n");
  } else {
    console.log(
      "\n  Sus datos quedaron intactos. Registrar el pago devuelve el acceso.\n",
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => system.$disconnect());
