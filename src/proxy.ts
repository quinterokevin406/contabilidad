import { jwtVerify } from "jose";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic auth routing (Next.js 16 renamed `middleware` to `proxy`).
 *
 * This is NOT the authorization boundary, and the Next documentation is explicit
 * that it must not be treated as one. All it does is keep an unauthenticated
 * visitor from seeing the application shell flash before a redirect, and keep a
 * signed-in user off the login page.
 *
 * The real check lives in the data access layer (src/server/auth/dal.ts), which
 * re-verifies the session against the database on every request. The proxy runs
 * in the Edge runtime and cannot reach Prisma, so it verifies the signature only
 * — enough to reject a forged or expired cookie, not enough to prove the account
 * is still active.
 */

const SESSION_COOKIE = "cc_session";

/**
 * Paths reachable without a session.
 *
 * `/offline` is the service worker's fallback page. It shows no figures at all,
 * and it has to render for someone whose connection dropped mid-session — a
 * redirect to a login page they also cannot reach would be a dead end.
 */
const PUBLIC_PATHS = ["/login", "/offline"] as const;

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

async function hasValidSignature(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const secret = process.env.AUTH_SECRET;
  if (!secret) return false;

  try {
    await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ["HS256"],
      issuer: "capital-control",
      audience: "capital-control-app",
    });
    return true;
  } catch {
    return false;
  }
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  const signedIn = await hasValidSignature(
    request.cookies.get(SESSION_COOKIE)?.value,
  );

  if (isPublic(pathname)) {
    if (signedIn) {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return NextResponse.next();
  }

  if (!signedIn) {
    // An API route answers with a status, never a redirect. Sending a 307 to a
    // login page means a fetch follows it and receives HTML where it expected
    // data — and a download link silently saves a login page as a .xlsx. The
    // handler re-checks authorization itself; this only avoids the wrong shape
    // of failure.
    if (pathname.startsWith("/api/")) {
      return new NextResponse("No autorizado", { status: 401 });
    }

    const loginUrl = new URL("/login", request.url);
    // Remember where they were headed so the login can send them back.
    if (pathname !== "/") {
      loginUrl.searchParams.set("next", `${pathname}${search}`);
    }
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Everything except Next internals, the favicon and static assets.
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|sw.js|manifest.webmanifest|.*\\.(?:png|jpg|jpeg|svg|webp|ico)$).*)",
  ],
};
