#!/usr/bin/env node
/**
 * Runs the app against the throwaway database instead of the real one.
 *
 *   npm run dev:test
 *
 * `next dev` reads .env, and after a deploy that file points at the live
 * business. Clicking through a new feature there means test clients and test
 * loans in the real books — and the one thing this system promises is that
 * nothing financial gets deleted, so that rubbish would be there to stay.
 *
 * This loads .env.test instead (built by `npm run db:test`, always local, full
 * of demo data) and hands it to Next through the environment, which takes
 * precedence over any .env file. Same app, same code, nothing at stake.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envTest = join(projectRoot, ".env.test");

if (!existsSync(envTest)) {
  console.error(
    "\nThere is no .env.test yet. Run `npm run db:test` first: it builds the " +
      "scratch database and writes that file.\n",
  );
  process.exit(1);
}

process.loadEnvFile(envTest);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("\n.env.test has no DATABASE_URL.\n");
  process.exit(1);
}

// The same refusal `db:test` makes, for the same reason: this script exists to
// keep the real database out of reach, so it has to be certain which one it got.
const LOCAL = ["localhost", "127.0.0.1", "::1"];
const host = new URL(url).hostname;
if (!LOCAL.includes(host)) {
  console.error(
    `\n.env.test points at ${host}, which is not this machine.\n\n` +
      "This command only runs against a local scratch database. Use " +
      "`npm run dev` if you really meant the configured one.\n",
  );
  process.exit(1);
}

console.log(`\nRunning against the local test database. Nothing here is real.\n`);

const child = spawn("npx", ["next", "dev"], {
  stdio: "inherit",
  shell: true,
  cwd: projectRoot,
  env: {
    ...process.env,
    // Migrations and the driver adapter both read this; locally there is no
    // pooler in front of anything, so it is the same string.
    DIRECT_URL: url,
  },
});

child.on("exit", (code) => process.exit(code ?? 0));
