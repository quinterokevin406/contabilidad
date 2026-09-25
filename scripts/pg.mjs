#!/usr/bin/env node
// Controls the portable PostgreSQL cluster used for local development.
//
// The cluster lives OUTSIDE the repository so a 360 MB database engine never
// ends up in git. Override its location with PGSQL_HOME if you keep it
// somewhere else; production deployments use docker compose or a real server
// and never touch this script.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");

const home =
  process.env.PGSQL_HOME ?? resolve(projectRoot, "..", ".pgsql-portable");

const binDir = join(home, "pgsql", "bin");
const dataDir = join(home, "data");
const logFile = join(home, "postgres.log");
const pgCtl = join(binDir, process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl");
const psql = join(binDir, process.platform === "win32" ? "psql.exe" : "psql");

const PORT = process.env.PGPORT ?? "5432";

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

if (!existsSync(pgCtl)) {
  fail(
    `No portable PostgreSQL found at:\n  ${home}\n\n` +
      "Set PGSQL_HOME to its location, or see README.md for how to install it.",
  );
}

const command = process.argv[2];

switch (command) {
  case "start": {
    // pg_ctl holds the terminal open on Windows when it inherits stdio, so the
    // child is detached and its output goes to the log file instead.
    const child = spawn(pgCtl, ["-D", dataDir, "-l", logFile, "-o", `-p ${PORT}`, "start"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    console.log(`PostgreSQL starting on port ${PORT}.`);
    console.log(`  data: ${dataDir}`);
    console.log(`  log:  ${logFile}`);
    console.log("\nCheck it with: npm run db:status");
    break;
  }

  case "stop": {
    const result = spawnSync(pgCtl, ["-D", dataDir, "-m", "fast", "stop"], {
      encoding: "utf8",
      windowsHide: true,
    });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 0);
    break;
  }

  case "status": {
    const result = spawnSync(pgCtl, ["-D", dataDir, "status"], {
      encoding: "utf8",
      windowsHide: true,
    });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 0);
    break;
  }

  case "psql": {
    // Read the connection from DATABASE_URL so psql never stops to ask for a
    // password, which would hang a non-interactive caller.
    if (!process.env.DATABASE_URL) {
      try {
        process.loadEnvFile(join(projectRoot, ".env"));
      } catch {
        fail("DATABASE_URL is not set and .env could not be read.");
      }
    }

    let url;
    try {
      url = new URL(process.env.DATABASE_URL ?? "");
    } catch {
      fail("DATABASE_URL is not a valid connection string.");
    }

    const result = spawnSync(
      psql,
      [
        "-h", url.hostname || "127.0.0.1",
        "-p", url.port || PORT,
        "-U", decodeURIComponent(url.username),
        "-d", url.pathname.replace(/^\//, ""),
        ...process.argv.slice(3),
      ],
      {
        stdio: "inherit",
        windowsHide: true,
        env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) },
      },
    );
    process.exit(result.status ?? 0);
    break;
  }

  default:
    console.log("Usage: node scripts/pg.mjs <start|stop|status|psql>");
    process.exit(1);
}
