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

/**
 * Where the throwaway database lives.
 *
 * Reuses an existing .env.test when there is one, because once this has been
 * set up the project's own .env may well have moved on to a managed database
 * in production — and deriving the scratch database from THAT would try to
 * create one next to the real thing.
 */
const existing = join(projectRoot, ".env.test");
let sourceUrl;

if (existsSync(existing)) {
  process.loadEnvFile(existing);
  sourceUrl = process.env.DATABASE_URL;
  console.log("Reusing the database named in .env.test");
} else {
  process.loadEnvFile(join(projectRoot, ".env"));
  sourceUrl = process.env.DATABASE_URL;
}

if (!sourceUrl) fail("DATABASE_URL is not set.");

const source = new URL(sourceUrl);

// A scratch database is created, dropped and filled with demo data. Doing that
// on a managed host is one typo away from doing it to the real one, and a
// production database is not the place to find out.
const LOCAL = ["localhost", "127.0.0.1", "::1"];
if (!LOCAL.includes(source.hostname)) {
  fail(
    "The database for the verification suite must be local, and this one is " +
      `at ${source.hostname}.\n\n` +
      "Creating a scratch database next to a real one is not worth the risk.\n" +
      "Point .env.test at a PostgreSQL on this machine and run it again.",
  );
}

const testName = source.pathname.slice(1).endsWith("_test")
  ? source.pathname.slice(1)
  : `${source.pathname.slice(1)}_test`;

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
