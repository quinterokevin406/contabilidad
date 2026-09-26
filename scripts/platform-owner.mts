/**
 * Grants or revokes the platform operator flag.
 *
 *   npm run platform:owner -- --list
 *   npm run platform:owner -- vos@tunegocio.co
 *   npm run platform:owner -- vos@tunegocio.co --revoke
 *
 * DELIBERATELY NOT IN THE INTERFACE. The flag lets one account see every
 * business on the deployment, so the only way to obtain it is shell access to
 * the server — which whoever sells the software has and their customers do not.
 * If a screen could grant it, a stolen administrator session would be one click
 * away from becoming a stolen everything.
 *
 * Revoking takes effect on the next request: the session is re-verified against
 * the database every time, and this also bumps sessionVersion so anything
 * already open is invalidated immediately.
 */

import { createSystemClient } from "@/infra/db/system-client";

const prisma = createSystemClient();

const args = process.argv.slice(2);
const wantsList = args.includes("--list");
const revoke = args.includes("--revoke");
const email = args.find((a) => !a.startsWith("--"))?.toLowerCase();

function usage(): never {
  console.error(
    [
      "",
      "  npm run platform:owner -- --list",
      "  npm run platform:owner -- <email>",
      "  npm run platform:owner -- <email> --revoke",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

async function main() {
  if (wantsList) {
    const owners = await prisma.user.findMany({
      where: { isPlatformOwner: true },
      select: {
        email: true,
        name: true,
        organization: { select: { name: true } },
      },
      orderBy: { email: "asc" },
    });

    if (owners.length === 0) {
      console.log("\n  Nadie tiene el permiso de operación de plataforma.\n");
      return;
    }

    console.log("\n  Operadores de la plataforma:\n");
    for (const owner of owners) {
      console.log(
        `    ${owner.email}  (${owner.name} — ${owner.organization.name})`,
      );
    }
    console.log("");
    return;
  }

  if (!email) usage();

  const user = await prisma.user.findFirst({
    where: { email, archivedAt: null },
    select: { id: true, email: true, name: true, isPlatformOwner: true },
  });

  if (!user) {
    console.error(`\n  No hay ningún usuario con ese correo: ${email}\n`);
    process.exitCode = 1;
    return;
  }

  if (user.isPlatformOwner === !revoke) {
    console.log(
      `\n  ${user.email} ya ${revoke ? "no tiene" : "tiene"} el permiso. No se cambió nada.\n`,
    );
    return;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      isPlatformOwner: !revoke,
      sessionVersion: { increment: 1 },
    },
  });

  console.log(
    `\n  ${revoke ? "Revocado a" : "Otorgado a"} ${user.email}.` +
      `\n  Sus sesiones abiertas quedaron invalidadas: tiene que entrar de nuevo.\n`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
