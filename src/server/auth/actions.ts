"use server";

import { verify } from "@node-rs/argon2";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { prisma } from "@/infra/db/client";
import { setRequestTenant } from "@/infra/db/request-tenant";
import { withSystemAccess } from "@/infra/db/tenancy";

import { getCurrentUser } from "./dal";
import { clearSessionCookie, setSessionCookie, signSession } from "./session";

/**
 * Login and logout.
 *
 * Failed attempts are counted on the user row and lock the account temporarily
 * (point 45). Persisting the counter rather than keeping it in memory means the
 * lock survives a restart and works across however many instances are running —
 * an in-memory counter is decorative the moment there are two processes.
 */

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Ingresá tu correo.")
    .email("El correo no tiene un formato válido."),
  password: z.string().min(1, "Ingresá tu contraseña."),
});

export interface LoginState {
  error: string | null;
  fieldErrors?: Partial<Record<"email" | "password", string>>;
}

export async function login(
  _previous: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    const fieldErrors: LoginState["fieldErrors"] = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (field === "email" || field === "password") {
        fieldErrors[field] ??= issue.message;
      }
    }
    return { error: null, fieldErrors };
  }

  const email = parsed.data.email.toLowerCase();

  // The only query in the application that legitimately crosses tenants: at
  // this point nobody has proven who they are, and an email address does not
  // say which organization it belongs to. Everything after the lookup runs
  // scoped to whatever organization it landed in.
  const user = await withSystemAccess(() =>
    prisma.user.findFirst({
      where: { email, archivedAt: null },
      select: {
        id: true,
        organizationId: true,
        email: true,
        passwordHash: true,
        role: true,
        status: true,
        sessionVersion: true,
        failedAttempts: true,
        lockedUntil: true,
        organization: { select: { status: true } },
      },
    }),
  );

  // A single generic message for every failure path. Telling an attacker
  // whether the address exists is free reconnaissance.
  const GENERIC = "Correo o contraseña incorrectos.";

  const requestHeaders = await headers();
  const ipAddress =
    requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = requestHeaders.get("user-agent");

  if (!user) {
    await recordFailedLogin(null, email, ipAddress, userAgent);
    return { error: GENERIC };
  }

  // The organization is known now, so the rest of the sign-in — the failed
  // attempt counter, the audit entry — is scoped like any other request.
  setRequestTenant(user.organizationId);

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const minutes = Math.max(
      1,
      Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000),
    );
    return {
      error:
        `La cuenta está bloqueada por intentos fallidos. ` +
        `Intentá de nuevo en ${minutes} ${minutes === 1 ? "minuto" : "minutos"}.`,
    };
  }

  const passwordMatches = await verify(user.passwordHash, parsed.data.password);

  if (!passwordMatches) {
    const attempts = user.failedAttempts + 1;
    const locked = attempts >= MAX_FAILED_ATTEMPTS;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedAttempts: locked ? 0 : attempts,
        lockedUntil: locked
          ? new Date(Date.now() + LOCK_MINUTES * 60_000)
          : null,
      },
    });

    await recordFailedLogin(user.id, email, ipAddress, userAgent);

    return {
      error: locked
        ? `Demasiados intentos fallidos. La cuenta queda bloqueada por ${LOCK_MINUTES} minutos.`
        : GENERIC,
    };
  }

  if (user.status !== "ACTIVE" || user.organization.status !== "ACTIVE") {
    return {
      error: "Tu cuenta está inactiva. Contactá al administrador.",
    };
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  await prisma.auditLog.create({
    data: {
      organizationId: user.organizationId,
      action: "LOGIN",
      entity: "User",
      entityId: user.id,
      summary: `Inicio de sesión de ${user.email}`,
      actorId: user.id,
      actorEmail: user.email,
      ipAddress,
      userAgent,
    },
  });

  const token = await signSession({
    userId: user.id,
    organizationId: user.organizationId,
    role: user.role,
    sessionVersion: user.sessionVersion,
  });

  await setSessionCookie(token);

  redirect("/");
}

async function recordFailedLogin(
  userId: string | null,
  email: string,
  ipAddress: string | null,
  userAgent: string | null,
): Promise<void> {
  // Without a user there is no organization to attribute the attempt to, so the
  // record is only kept when one is known.
  if (!userId) return;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { organizationId: true },
  });
  if (!user) return;

  await prisma.auditLog.create({
    data: {
      organizationId: user.organizationId,
      action: "LOGIN_FAILED",
      entity: "User",
      entityId: userId,
      summary: `Intento fallido de inicio de sesión para ${email}`,
      actorId: userId,
      actorEmail: email,
      ipAddress,
      userAgent,
    },
  });
}

export async function logout(): Promise<void> {
  const user = await getCurrentUser();

  if (user) {
    await prisma.auditLog.create({
      data: {
        organizationId: user.organizationId,
        action: "LOGOUT",
        entity: "User",
        entityId: user.id,
        summary: `Cierre de sesión de ${user.email}`,
        actorId: user.id,
        actorEmail: user.email,
      },
    });
  }

  await clearSessionCookie();
  redirect("/login");
}
