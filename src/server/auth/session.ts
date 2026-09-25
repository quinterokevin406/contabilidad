import "server-only";

import { jwtVerify, SignJWT } from "jose";
import { cookies } from "next/headers";

import { getEnv } from "@/lib/env";

/**
 * Stateless session tokens.
 *
 * A signed JWT in an httpOnly cookie. The token carries only what the proxy
 * needs for an optimistic redirect; anything that grants access is re-checked
 * against the database on every request by the data access layer.
 *
 * `sessionVersion` is the revocation lever: bumping it on the user row
 * invalidates every token ever issued to them, without any server-side session
 * store to keep in sync.
 */

export const SESSION_COOKIE = "cc_session";

/** Eight hours: a working day, after which an unattended machine locks itself. */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;

const ALGORITHM = "HS256";
const ISSUER = "capital-control";
const AUDIENCE = "capital-control-app";

export interface SessionClaims {
  userId: string;
  organizationId: string;
  role: "ADMIN" | "COLLECTOR" | "VIEWER";
  sessionVersion: number;
}

function secretKey(): Uint8Array {
  return new TextEncoder().encode(getEnv().AUTH_SECRET);
}

export async function signSession(claims: SessionClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(secretKey());
}

/**
 * Verifies a token's signature and claims.
 *
 * Returns null rather than throwing: an expired or tampered cookie is an
 * ordinary "not logged in", not an application error.
 */
export async function verifySessionToken(
  token: string | undefined | null,
): Promise<SessionClaims | null> {
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      algorithms: [ALGORITHM],
      issuer: ISSUER,
      audience: AUDIENCE,
    });

    if (
      typeof payload.userId !== "string" ||
      typeof payload.organizationId !== "string" ||
      typeof payload.sessionVersion !== "number" ||
      (payload.role !== "ADMIN" &&
        payload.role !== "COLLECTOR" &&
        payload.role !== "VIEWER")
    ) {
      return null;
    }

    return {
      userId: payload.userId,
      organizationId: payload.organizationId,
      role: payload.role,
      sessionVersion: payload.sessionVersion,
    };
  } catch {
    return null;
  }
}

/**
 * Writes the session cookie.
 *
 * httpOnly keeps it away from any script on the page, sameSite=lax blocks the
 * cross-site form posts that CSRF relies on, and secure is set whenever the
 * deployment is not plain local http.
 */
export async function setSessionCookie(token: string): Promise<void> {
  const env = getEnv();
  const store = await cookies();

  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/** Reads and verifies the cookie on the current request. */
export async function readSession(): Promise<SessionClaims | null> {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}
