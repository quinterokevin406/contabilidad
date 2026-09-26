#!/usr/bin/env node
/**
 * Builds the throwaway database the verification suite runs against.
 *
 *   node scripts/test-db.mjs
 *
 * The financial checks post real payments, renewals and reversals and then roll
 * them back. Rolling back is not a licence to run them against a live business:
 * a script that aborts its transactions still holds locks on rows a collector
 * may be trying to write, and one bad edit to a verification script would reach
 * real money. So they get their own database, seeded with demo data, which can
 * be dropped and rebuilt at any time.
 *
 * Reads connection details and secrets from .env, changes only the database
 * name, and writes .env.test.
 */

import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const isWindows = process.platform === "win32";

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function tool(name) {
  const binary = isWindows ? `${name}.exe` : name;
  const home =
    process.env.PGSQL_HOME ?? resolve(projectRoot, "..", ".pgsql-portable");
  const portable = join(home, "pgsql", "bin", binary);
  return existsSync(portable) ? portable : binary;
}

process.loadEnvFile(join(projectRoot, ".env"));

if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set in .env");

const source = new URL(process.env.DATABASE_URL);
const testName = `${source.pathname.slice(1)}_test`;

if (source.pathname.slice(1).endsWith("_test")) {
  fail("DATABASE_URL already points at a test database. Refusing to nest one.");
}

const target = new URL(source.toString());
target.pathname = `/${testName}`;

// Secrets are copied rather than regenerated so the seeded administrator can
// actually be used to click through the demo data.
const envTest =
  [
    `DATABASE_URL="${target.toString()}"`,
    `AUTH_SECRET="${process.env.AUTH_SECRET ?? ""}"`,
    `AUTH_URL="http://localhost:3000"`,
    `SEED_ADMIN_EMAIL="${process.env.SEED_ADMIN_EMAIL ?? "admin@capitalcontrol.local"}"`,
    `SEED_ADMIN_PASSWORD="${process.env.SEED_ADMIN_PASSWORD ?? ""}"`,
    `SEED_ADMIN_NAME="Administrador"`,
    `SEED_ORG_NAME="Demo"`,
    `SEED_ORG_SLUG="demo"`,
    // The entire point of this database.
    `SEED_DEMO_DATA="true"`,
  ].join("\n") + "\n";

writeFileSync(join(projectRoot, ".env.test"), envTest);
console.log(`Wrote .env.test -> ${testName}`);

function run(binary, args, env, label, { allowFailure = false } = {}) {
  const result = spawnSync(binary, args, {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, ...env },
    cwd: projectRoot,
  });
  if (result.status !== 0 && !allowFailure) {
    fail(`${label} failed (exit ${result.status}).`);
  }
  return result.status === 0;
}

// Already exists on a re-run, which is fine.
run(
  tool("createdb"),
  [
    "-U", source.username,
    "-h", source.hostname,
    "-p", source.port || "5432",
    "-T", "template0",
    "--locale-provider=icu",
    "--icu-locale=es-CO",
    "-E", "UTF8",
    testName,
  ],
  { PGPASSWORD: decodeURIComponent(source.password) },
  "createdb",
  { allowFailure: true },
);

const testEnv = {
  DATABASE_URL: target.toString(),
  SEED_DEMO_DATA: "true",
  SEED_ORG_NAME: "Demo",
  SEED_ORG_SLUG: "demo",
};

run("npx", ["prisma", "migrate", "deploy", "--config", "prisma7.config.ts"], testEnv, "migrate deploy");
run("npx", ["tsx", "prisma/seed.ts"], testEnv, "seed");

console.log("\nReady. Run `npm run verify`.\n");
