#!/usr/bin/env node
/**
 * Backup and restore (point 47).
 *
 *   node scripts/backup.mjs create [--out <dir>] [--keep <n>]
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
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
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

/** Grants a connection access across every tenant. Tooling only. */
const SYSTEM_CONTEXT = { PGOPTIONS: "-c app.organization_id=*" };

function run(binary, args, label, env = {}, { cleanUp = null } = {}) {
  const result = spawnSync(binary, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  // A half-written dump left on disk is indistinguishable from a real one at a
  // glance, and someone will eventually reach for it.
  if ((result.error || result.status !== 0) && cleanUp && existsSync(cleanUp)) {
    unlinkSync(cleanUp);
    console.error(`Removed the incomplete file: ${cleanUp}`);
  }
  if (result.error) {
    fail(
      `Could not run ${binary}.\n` +
        "Install the PostgreSQL client tools, or set PGSQL_HOME to a portable copy.",
    );
  }
  if (result.status !== 0) fail(`${label} failed (exit ${result.status}).`);
}

/** Runs one SQL statement and returns the single value it produced. */
function queryScalar(sql) {
  const result = spawnSync(
    tool("psql"),
    [
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--command",
      sql,
      connectionString(),
    ],
    { encoding: "utf8", env: { ...process.env, ...SYSTEM_CONTEXT } },
  );
  if (result.error || result.status !== 0) return null;
  return (result.stdout ?? "").trim();
}

/**
 * Refuses to dump unless this connection can see every tenant's rows.
 *
 * Without the check the failure is silent: pg_dump exits 0 and writes a file
 * with no data in it. Measured against a live database — dumping the clients
 * table with the context produced 10 rows, and without it, 0. A backup file
 * that looks fine and is empty is worse than no backup at all, because you stop
 * looking for the problem.
 */
function assertSystemContext() {
  const isSystem = queryScalar("SELECT app_is_system()");

  if (isSystem === null) {
    fail(
      "Could not reach the database to verify the backup context.\n" +
        "psql has to be available: install the PostgreSQL client tools, or set\n" +
        "PGSQL_HOME to a portable copy.",
    );
  }

  if (isSystem !== "t") {
    fail(
      "This connection cannot see every tenant, so the backup would be EMPTY\n" +
        "while appearing to succeed. Refusing to write it.\n\n" +
        "PGOPTIONS did not reach the server, or the database is missing the\n" +
        "app_is_system() function (migration 20260926040000_row_level_security).",
    );
  }
}

/** How many rows the dump has to contain, taken from the live database. */
function liveRowCount(table) {
  const value = queryScalar(`SELECT count(*) FROM "${table}"`);
  return value === null || value === "" ? null : Number(value);
}

/**
 * Counts the rows the dump actually holds for one table.
 *
 * The pre-flight check should make this impossible to fail, which is exactly
 * why it is worth doing: a backup is the one thing nobody notices is broken
 * until the day it has to work.
 */
function dumpedRowCount(file, table) {
  const result = spawnSync(
    tool("pg_restore"),
    ["--data-only", `--table=${table}`, file],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) return null;

  const lines = (result.stdout ?? "").split("\n");
  const start = lines.findIndex((line) => line.startsWith("COPY "));
  if (start === -1) return 0;

  let rows = 0;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i] === "\\.") break;
    if (lines[i] !== "") rows += 1;
  }
  return rows;
}

function backupDir() {
  const dir = resolve(projectRoot, flag("--out", "backups"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function create() {
  const dir = backupDir();
  const file = join(dir, `capital-control-${stamp()}.dump`);

  assertSystemContext();

  // Read before the dump, so the comparison afterwards is against a number
  // this script did not get from the dump itself.
  const expected = liveRowCount("clients");

  console.log(`Backing up to ${file} ...`);
  run(
    tool("pg_dump"),
    [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      // Required: the tables enforce their policies against the owner too.
      "--enable-row-security",
      "--file",
      file,
      connectionString(),
    ],
    "pg_dump",
    SYSTEM_CONTEXT,
  );

  if (expected !== null && expected > 0) {
    const dumped = dumpedRowCount(file, "clients");
    if (dumped !== null && dumped !== expected) {
      fail(
        "The backup is incomplete. It has been left in place for inspection:\n" +
          `  ${file}\n\n` +
          `The database holds ${expected} clients; the dump contains ${dumped}.\n` +
          "Do NOT rely on this file.",
      );
    }
    console.log(`Verified: ${expected} clients present in the dump.`);
  }

  const size = statSync(file).size;
  console.log(`\nDone — ${(size / 1024 / 1024).toFixed(2)} MB`);
  prune(dir);

  warnIfSameMachine(dir);
}

/**
 * Says so when the backup landed on the same disk as the database.
 *
 * The failure this protects against — a dead drive, a stolen laptop,
 * ransomware — takes the original and the copy together when they sit in the
 * same box. Generic advice gets ignored; a path you can paste does not, so if
 * there is a synced folder on this machine the message names it.
 */
function warnIfSameMachine(dir) {
  const inProject = resolve(dir).startsWith(resolve(projectRoot));
  const synced = [
    process.env.OneDrive,
    process.env.OneDriveConsumer,
    join(process.env.USERPROFILE ?? process.env.HOME ?? "", "OneDrive"),
    join(process.env.USERPROFILE ?? process.env.HOME ?? "", "Google Drive"),
    join(process.env.HOME ?? "", "Dropbox"),
  ].find((candidate) => candidate && existsSync(candidate));

  const isSynced = synced && resolve(dir).startsWith(resolve(synced));

  if (isSynced) {
    console.log(
      "\nSaved inside a synced folder, so a copy leaves this machine on its own.",
    );
    return;
  }

  console.log("\nA backup that only exists on this machine is not a backup.");

  if (inProject && synced) {
    console.log(
      "A synced folder was found on this computer. Writing the backup there\n" +
        "gets it off the disk automatically:\n\n" +
        `  npm run backup -- --out "${join(synced, "CapitalControl-Backups")}"`,
    );
  } else {
    console.log("Copy it somewhere else before you need it.");
  }
}

/**
 * Keeps the newest N dumps and deletes the rest.
 *
 * Without this a nightly scheduled backup fills the disk and then starts
 * failing — silently, because nobody reads the log of a job that has worked
 * every night for a year. Pre-restore safety copies are never pruned: those
 * exist precisely because something already went wrong.
 */
function prune(dir) {
  const keep = Number(flag("--keep", "30"));
  if (!Number.isInteger(keep) || keep < 1) return;

  const dumps = readdirSync(dir)
    .filter((name) => name.endsWith(".dump") && !name.startsWith("pre-restore-"))
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const stale = dumps.slice(keep);
  for (const { name } of stale) unlinkSync(join(dir, name));

  if (stale.length > 0) {
    console.log(`Removed ${stale.length} older backup(s); keeping ${keep}.`);
  }
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
  assertSystemContext();
  run(
    tool("pg_dump"),
    [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      "--enable-row-security",
      "--file",
      safety,
      connectionString(),
    ],
    "safety pg_dump",
    SYSTEM_CONTEXT,
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
    // Restoring writes into tenant tables, which the policies also govern.
    SYSTEM_CONTEXT,
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
        "  node scripts/backup.mjs create [--out <dir>] [--keep <n>]",
        "  node scripts/backup.mjs list [--out <dir>]",
        "  node scripts/backup.mjs restore <file> --force",
        "",
        "See docs/BACKUP.md.",
      ].join("\n"),
    );
}
