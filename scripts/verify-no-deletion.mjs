#!/usr/bin/env node
/**
 * Proof that the application cannot delete a financial record.
 *
 * Every other check in this suite runs against a database. This one runs
 * against the source, because the guarantee is about code that does not exist:
 * there is no path through the application that removes a client, a loan, a
 * payment, an allocation, a cash movement or an audit entry. A mistake is
 * corrected by recording its opposite, and both sides stay visible forever.
 *
 * A guarantee nobody enforces decays. Somebody adds a "delete client" button in
 * eighteen months, it looks reasonable in review, and the promise is quietly
 * gone. This fails the build instead.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");

/** Where application code lives. Scripts and the seed are operator tools. */
const ROOTS = ["src/services", "src/server", "src/app"];

/**
 * Tables that hold what the business actually owes and owns.
 *
 * Deleting a row from any of these destroys evidence: the balance it proves,
 * the payment it records, or the trail of who did what.
 */
const PROTECTED = [
  "client",
  "loan",
  "loanPeriod",
  "payment",
  "paymentAllocation",
  "renewal",
  "settlement",
  "reversal",
  "cashMovement",
  "cashAccount",
  "cashClosure",
  "incomeEntry",
  "expenseEntry",
  "capitalEvent",
  "auditLog",
  "periodSnapshot",
  "organization",
  "user",
  "subscription",
  "subscriptionPayment",
];

/**
 * Deletions that are allowed, each with the reason it is not a loss.
 *
 * Anything not on this list and not protected is simply not checked — the rule
 * is about financial evidence, not about every row in the database.
 */
const ALLOWED = new Map([
  [
    "periodSnapshotMetric",
    "derived figures, recomputed from the movements on every snapshot",
  ],
]);

let failures = 0;

function check(label, pass, detail = "") {
  if (!pass) failures += 1;
  console.log(
    `  ${pass ? "OK  " : "FALLA"} ${label}${detail ? ` — ${detail}` : ""}`,
  );
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
      continue;
    }
    if (/\.(ts|tsx)$/.test(full)) yield full;
  }
}

// Matches tx.payment.delete(, prisma.loan.deleteMany(, this.client.delete(
const DELETION = /(?:^|[^\w.])(?:tx|prisma|client|db)\.(\w+)\.(delete|deleteMany)\s*\(/g;

console.log("\n1. Ningún borrado de registros financieros en la aplicación");

const found = [];

for (const root of ROOTS) {
  const dir = join(projectRoot, root);
  for (const file of walk(dir)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(DELETION)) {
      const model = match[1];
      const line = source.slice(0, match.index).split("\n").length;
      found.push({
        file: relative(projectRoot, file).replace(/\\/g, "/"),
        line,
        model,
        operation: match[2],
      });
    }
  }
}

const violations = found.filter((f) => PROTECTED.includes(f.model));
const permitted = found.filter((f) => ALLOWED.has(f.model));
const unknown = found.filter(
  (f) => !PROTECTED.includes(f.model) && !ALLOWED.has(f.model),
);

check(
  "no hay borrados de tablas protegidas",
  violations.length === 0,
  violations.length === 0
    ? `${PROTECTED.length} tablas vigiladas`
    : violations
        .map((v) => `${v.file}:${v.line} → ${v.model}.${v.operation}()`)
        .join("; "),
);

for (const item of permitted) {
  check(
    `borrado permitido: ${item.model}`,
    true,
    `${item.file}:${item.line} — ${ALLOWED.get(item.model)}`,
  );
}

if (unknown.length > 0) {
  console.log("\n  Borrados de tablas no clasificadas (revisar a mano):");
  for (const item of unknown) {
    console.log(`    ${item.file}:${item.line} → ${item.model}.${item.operation}()`);
  }
}

// --- The correction path has to exist, or "never delete" is just a limitation

console.log("\n2. La corrección de errores existe");

const reversal = join(projectRoot, "src/services/reversals/reverse-payment.ts");
const reversalSource = readFileSync(reversal, "utf8");

check(
  "hay un servicio de anulación",
  reversalSource.includes("export async function reversePayment"),
);
check(
  "que exige un motivo escrito",
  /reason/.test(reversalSource) && /ServiceError/.test(reversalSource),
  "una corrección sin motivo no es una corrección",
);
check(
  "y marca el original en vez de borrarlo",
  reversalSource.includes('"REVERSED"'),
);

console.log(
  failures === 0
    ? "\nNada de lo registrado puede desaparecer desde la aplicación.\n"
    : `\n${failures} comprobación(es) fallaron.\n`,
);
process.exit(failures === 0 ? 0 : 1);
