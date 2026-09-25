#!/usr/bin/env node
/**
 * Backup and restore (point 47).
 *
 *   node scripts/backup.mjs create [--out <dir>]
 *   node scripts/backup.mjs list [--out <dir>]
 *   node scripts/backup.mjs restore <file> [--force]
 *
 * Uses pg_dump's custom format (-Fc): compressed, and restorable table by
 * table if a partial recovery is ever needed. A plain .sql dump cannot do that.
 *
 * WHY THIS IS NOT AUTOMATIC: a restore replaces the entire database. There is
 * no safe default for "overwrite everything", so `restore` refuses to run
 * without --force and takes a safety dump of the current state first.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const isWindows = process.platform === "win32";

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

/**
 * Finds pg_dump / pg_restore.
 *
 * The portable development cluster is checked first, then PATH, so a machine
 * with no system-wide PostgreSQL install still works.
 */
function tool(name) {
  const binary = isWindows ? `${name}.exe` : name;
  const home =
    process.env.PGSQL_HOME ?? resolve(projectRoot, "..", ".pgsql-portable");
  const portable = join(home, "pgsql", "bin", binary);
  if (existsSync(portable)) return portable;
  return binary;
}

/**
 * Prisma accepts query parameters that libpq does not. `?schema=public` makes
 * pg_dump exit with "invalid URI query parameter", so they are stripped here
 * rather than asking every operator to keep two connection strings in sync.
 */
const PRISMA_ONLY_PARAMS = [
  "schema",
  "connection_limit",
  "pool_timeout",
  "pgbouncer",
  "connect_timeout",
  "socket_timeout",
  "sslidentity",
  "sslpassword",
  "sslcert",
];

function connectionString() {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile(join(projectRoot, ".env"));
    } catch {
      // Falls through to the error below.
    }
  }
  if (!process.env.DATABASE_URL) {
    fail("DATABASE_URL is not set, and no .env file provided it.");
  }

  try {
    const url = new URL(process.env.DATABASE_URL);
    for (const param of PRISMA_ONLY_PARAMS) url.searchParams.delete(param);
    return url.toString();
  } catch {
    // Not a URL we can parse — hand it over untouched and let libpq decide.
    return process.env.DATABASE_URL;
  }
}

function flag(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

/** UTC timestamp, sortable as a filename: 20260925-143002. */
function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

function run(binary, args, label) {
  const result = spawnSync(binary, args, { stdio: "inherit" });
  if (result.error) {
    fail(
      `Could not run ${binary}.\n` +
        "Install the PostgreSQL client tools, or set PGSQL_HOME to a portable copy.",
    );
  }
  if (result.status !== 0) fail(`${label} failed (exit ${result.status}).`);
}

function backupDir() {
  const dir = resolve(projectRoot, flag("--out", "backups"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function create() {
  const dir = backupDir();
  const file = join(dir, `capital-control-${stamp()}.dump`);

  console.log(`Backing up to ${file} ...`);
  run(
    tool("pg_dump"),
    ["--format=custom", "--no-owner", "--no-privileges", "--file", file, connectionString()],
    "pg_dump",
  );

  const size = statSync(file).size;
  console.log(`\nDone — ${(size / 1024 / 1024).toFixed(2)} MB`);
  console.log(
    "\nA backup that only exists on this machine is not a backup.\n" +
      "Copy it somewhere else before you need it.",
  );
}

function list() {
  const dir = backupDir();
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".dump"))
    .map((name) => ({ name, stat: statSync(join(dir, name)) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  if (files.length === 0) {
    console.log(`No backups in ${dir}`);
    return;
  }

  console.log(`${files.length} backup(s) in ${dir}:\n`);
  for (const { name, stat } of files) {
    console.log(
      `  ${name}  ${(stat.size / 1024 / 1024).toFixed(2)} MB  ${stat.mtime.toISOString()}`,
    );
  }
}

function restore() {
  const file = process.argv[3];
  if (!file || file.startsWith("--")) {
    fail("Usage: node scripts/backup.mjs restore <file> --force");
  }

  const target = resolve(projectRoot, file);
  if (!existsSync(target)) fail(`No such file: ${target}`);

  if (!process.argv.includes("--force")) {
    fail(
      "A restore REPLACES every client, loan, payment and movement in the\n" +
        "current database with the contents of the backup. Nothing is merged.\n\n" +
        `Re-run with --force if that is what you want:\n` +
        `  node scripts/backup.mjs restore ${file} --force`,
    );
  }

  // Take a safety copy first. Restoring the wrong file is a normal human
  // mistake, and it should be survivable.
  const dir = backupDir();
  const safety = join(dir, `pre-restore-${stamp()}.dump`);
  console.log(`Saving current state to ${safety} ...`);
  run(
    tool("pg_dump"),
    ["--format=custom", "--no-owner", "--no-privileges", "--file", safety, connectionString()],
    "safety pg_dump",
  );

  console.log(`\nRestoring ${target} ...`);
  run(
    tool("pg_restore"),
    [
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
      "--dbname",
      connectionString(),
      target,
    ],
    "pg_restore",
  );

  console.log(
    "\nRestored. Run `npm run verify` to confirm the ledger still balances.",
  );
}

switch (process.argv[2]) {
  case "create":
    create();
    break;
  case "list":
    list();
    break;
  case "restore":
    restore();
    break;
  default:
    console.log(
      [
        "Capital Control — backup",
        "",
        "  node scripts/backup.mjs create [--out <dir>]",
        "  node scripts/backup.mjs list [--out <dir>]",
        "  node scripts/backup.mjs restore <file> --force",
        "",
        "See docs/BACKUP.md.",
      ].join("\n"),
    );
}
