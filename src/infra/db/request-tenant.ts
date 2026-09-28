import { cache } from "react";

/**
 * The organization a request belongs to, taken from its own session cookie.
 *
 * AN EARLIER VERSION OF THIS FILE kept a mutable object created by React's
 * `cache()`, which the data access layer wrote to after verifying the session.
 * It worked while rendering a page and silently did not inside a Server Action:
 * the write and the read landed on different objects, the tenant came back
 * empty, and PostgreSQL correctly refused to touch a row nobody had claimed.
 * Logging in failed on its own last statement.
 *
 * Deriving it from the signed token instead removes the whole class of problem.
 * There is nothing to set and therefore no order to get wrong, the value cannot
 * be anything other than what the session says, and it is scoped to the request
 * by construction rather than by a framework detail.
 *
 * `cache()` is still used, but only so the signature is verified once per
 * request instead of once per query. If it ever stops deduplicating, this gets
 * slower and stays correct.
 */
const resolveFromSession = cache(async (): Promise<string> => {
  // Imported lazily: scripts and the seed load this module too, and they have
  // no request to read a cookie from.
  const { readSession } = await import("@/server/auth/session");
  const claims = await readSession();
  return claims?.organizationId ?? "";
});

/**
 * Reads the current request's organization, or "" when there is none.
 *
 * Returns "" rather than throwing outside a request — scripts, the seed and the
 * verification suite have no session and declare their tenant explicitly.
 * Empty denies, so the failure mode is an empty result, never someone else's
 * data.
 */
export async function readRequestTenant(): Promise<string> {
  try {
    return await resolveFromSession();
  } catch {
    return "";
  }
}
