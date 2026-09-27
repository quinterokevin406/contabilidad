/**
 * Changes a user's password from the server.
 *
 *   npm run user:password -- --list
 *   npm run user:password -- correo@ejemplo.com
 *   npm run user:password -- correo@ejemplo.com --password "una que elijas"
 *   npm run user:password -- correo@ejemplo.com --unlock
 *
 * THIS IS THE ONLY WAY BACK IN. The system has no password-reset email and no
 * security question, deliberately: it is private software that sends nothing to
 * anybody and depends on no mail service. The cost of that choice is this
 * script, which needs shell access to the server — something the owner of an
 * installation has and an attacker on the internet does not.
 *
 * With no --password it generates a strong one and prints it ONCE. Copy it,
 * hand it over through something other than the terminal history, and have the
 * person change it.
 *
 * Every open session for that user is invalidated, and a lockout from failed
 * attempts is cleared at the same time — being locked out is usually exactly
 * why somebody is running this.
 */

import { hash } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";

import { createSystemClient } from "@/infra/db/system-client";

/** Identical to the seed's parameters; a different cost would still verify,
 *  but keeping them in step means every hash in the table looks the same. */
const ARGON2 = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

const prisma = createSystemClient();

const args = process.argv.slice(2);
const wantsList = args.includes("--list");
const unlockOnly = args.includes("--unlock");
const email = args.find((a) => !a.startsWith("--"))?.toLowerCase();

function flag(name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

/**
 * A password a person can read aloud over the phone without mistakes.
 *
 * No look-alike characters: a password nobody can transcribe gets written on a
 * sticky note, which is worse than a slightly shorter one.
 */
function generatePassword(): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(20);
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return `${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10, 15)}-${out.slice(15, 20)}`;
}

function usage(): never {
  console.error(
    [
      "",
      "  npm run user:password -- --list",
      "  npm run user:password -- <correo>",
      '  npm run user:password -- <correo> --password "la que elijas"',
      "  npm run user:password -- <correo> --unlock",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

async function main() {
  if (wantsList) {
    const users = await prisma.user.findMany({
      where: { archivedAt: null },
      orderBy: [{ organizationId: "asc" }, { email: "asc" }],
      select: {
        email: true,
        name: true,
        role: true,
        status: true,
        lockedUntil: true,
        organization: { select: { name: true } },
      },
    });

    if (users.length === 0) {
      console.log("\n  No hay usuarios. ¿Corriste `npm run db:seed`?\n");
      return;
    }

    console.log(`\n  ${users.length} usuario(s):\n`);
    for (const user of users) {
      const locked =
        user.lockedUntil && user.lockedUntil > new Date()
          ? "  [BLOQUEADO]"
          : "";
      console.log(
        `    ${user.email}  —  ${user.name} · ${user.role} · ${user.organization.name}${locked}`,
      );
    }
    console.log("");
    return;
  }

  if (!email) usage();

  const user = await prisma.user.findFirst({
    where: { email, archivedAt: null },
    select: {
      id: true,
      email: true,
      name: true,
      status: true,
      lockedUntil: true,
      organization: { select: { name: true, status: true } },
    },
  });

  if (!user) {
    console.error(
      `\n  No hay ningún usuario con ese correo: ${email}` +
        "\n  Probá `npm run user:password -- --list` para ver cuáles existen.\n",
    );
    process.exitCode = 1;
    return;
  }

  // Unlocking on its own, for somebody who remembers their password and just
  // mistyped it five times.
  if (unlockOnly) {
    await prisma.user.update({
      where: { id: user.id },
      data: { failedAttempts: 0, lockedUntil: null },
    });
    console.log(
      `\n  ${user.email} quedó desbloqueado. Su contraseña no cambió.\n`,
    );
    return;
  }

  const chosen = flag("--password");

  if (chosen !== null && chosen.length < 8) {
    console.error("\n  La contraseña tiene que tener al menos 8 caracteres.\n");
    process.exitCode = 1;
    return;
  }

  const password = chosen ?? generatePassword();

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hash(password, ARGON2),
      // Anything already signed in as this user stops working now.
      sessionVersion: { increment: 1 },
      // Whoever is running this is usually locked out. Clear it.
      failedAttempts: 0,
      lockedUntil: null,
    },
  });

  console.log(`\n  Contraseña cambiada para ${user.email} (${user.name}).`);

  if (chosen === null) {
    console.log(`\n      ${password}\n`);
    console.log("  Copiala ahora: no se vuelve a mostrar y no queda guardada.");
  }

  console.log("  Sus sesiones abiertas quedaron cerradas.");

  if (user.status !== "ACTIVE") {
    console.log(
      `\n  OJO: este usuario está ${user.status}, así que todavía no va a poder entrar.`,
    );
  }
  if (user.organization.status !== "ACTIVE") {
    console.log(
      `\n  OJO: la organización "${user.organization.name}" está suspendida.` +
        "\n  Mientras siga así, nadie de ese negocio puede entrar.",
    );
  }
  console.log("");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
