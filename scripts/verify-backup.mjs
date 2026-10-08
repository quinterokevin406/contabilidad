#!/usr/bin/env node
/**
 * Proof that a backup actually contains the data.
 *
 * This check exists because the opposite already happened. Enabling Row-Level
 * Security broke pg_dump, and the workaround for that — `--enable-row-security`
 * — makes pg_dump exit successfully while writing a file with ZERO rows in it
 * when no tenant context is set. Measured: 10 clients with the context, 0
 * without, same exit code, same reassuring output.
 *
 * A backup nobody has restored is a hypothesis. A backup that silently holds
 * nothing is worse, because it stops you from looking for the problem. So this
 * takes a real dump of the test database and counts what came out.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const outDir = join(projectRoot, "backups", "verify");

let failures = 0;

function check(label, pass, detail = "") {
  if (!pass) failures += 1;
  console.log(
    `  ${pass ? "OK  " : "FALLA"} ${label}${detail ? ` — ${detail}` : ""}`,
  );
}

const envFile = join(projectRoot, ".env.test");
if (!existsSync(envFile)) {
  console.error("\n  Falta .env.test. Corré `npm run db:test` primero.\n");
  process.exit(1);
}
process.loadEnvFile(envFile);

function backup(args, env = {}) {
  return spawnSync(
    process.execPath,
    [join(projectRoot, "scripts", "backup.mjs"), ...args],
    {
      encoding: "utf8",
      cwd: projectRoot,
      env: { ...process.env, ...env },
    },
  );
}

console.log("\n1. El backup verifica su propio contenido");

rmSync(outDir, { recursive: true, force: true });
const created = backup(["create", "--out", "backups/verify"]);
const output = `${created.stdout ?? ""}${created.stderr ?? ""}`;

check("el backup se completó", created.status === 0);
check(
  "informa cuántos clientes quedaron adentro",
  /Verified: \d+ clients read back from the dump/.test(output),
  output.match(/Verified: \d+ clients[^\n]*/)?.[0] ?? "no lo informó",
);

const dumps = existsSync(outDir)
  ? readdirSync(outDir).filter((f) => f.endsWith(".dump"))
  : [];
check("quedó exactamente un archivo", dumps.length === 1, `${dumps.length}`);

if (dumps.length === 1) {
  const size = statSync(join(outDir, dumps[0])).size;
  // A dump of a database with ten clients and fifteen loans cannot be tiny.
  check("el archivo no está vacío", size > 50_000, `${size} bytes`);
}

console.log("\n2. Sin contexto de inquilino, se niega a escribir");

rmSync(outDir, { recursive: true, force: true });
// PGSQL_HOME pointing nowhere removes psql, so the pre-flight cannot run.
const blind = backup(["create", "--out", "backups/verify"], {
  PGSQL_HOME: join(projectRoot, "no-such-postgres"),
});

check("falla en vez de escribir a ciegas", blind.status !== 0);
check(
  "no dejó ningún archivo",
  !existsSync(outDir) || readdirSync(outDir).length === 0,
);

rmSync(outDir, { recursive: true, force: true });

console.log(
  failures === 0
    ? "\nTodo en orden.\n"
    : `\n${failures} comprobación(es) fallaron.\n`,
);
process.exit(failures === 0 ? 0 : 1);
