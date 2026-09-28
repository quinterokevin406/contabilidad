import { z } from "zod";

/**
 * Validated environment.
 *
 * Every deployment of this product is installed by someone other than the
 * author, so a missing or malformed variable has to fail loudly at boot with a
 * message that says what to fix -- not surface three screens later as an
 * undefined connection string.
 */

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required.")
    .refine(
      (v) => v.startsWith("postgres://") || v.startsWith("postgresql://"),
      "DATABASE_URL must be a PostgreSQL connection string.",
    ),

  AUTH_SECRET: z
    .string()
    .min(
      32,
      "AUTH_SECRET must be at least 32 characters. Generate one with: " +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    ),

  AUTH_URL: z.string().url().optional(),

  /**
   * Allows the session cookie over plain HTTP.
   *
   * For ONE situation: an installation that lives on a computer inside a home
   * or office network, reached from phones on the same WiFi. There is no domain
   * there and therefore no certificate, and a Secure cookie would simply be
   * discarded by the browser — the login form would return to itself with no
   * error and no way to guess why.
   *
   * NEVER set this on anything reachable from the internet. Without TLS the
   * session token crosses the network in the clear, and whoever reads it is
   * that user until it expires.
   */
  ALLOW_INSECURE_COOKIES: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),

  // Seed-only values. Absent in a normal production boot.
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(8).optional(),
  SEED_ADMIN_NAME: z.string().optional(),
  SEED_ORG_NAME: z.string().optional(),
  SEED_ORG_SLUG: z.string().optional(),
  SEED_DEMO_DATA: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/**
 * Parses and caches the environment.
 *
 * Called lazily rather than at module load so that importing a domain module in
 * a unit test does not require a database URL.
 */
export function getEnv(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${details}\n\n` +
        "Copy .env.example to .env and fill in the missing values.",
    );
  }

  cached = parsed.data;

  // Said out loud, once, because the cost of forgetting it is that session
  // tokens travel the network in the clear.
  if (cached.NODE_ENV === "production" && cached.ALLOW_INSECURE_COOKIES) {
    console.warn(
      "\n  ⚠  ALLOW_INSECURE_COOKIES está activo: la sesión viaja sin cifrar.\n" +
        "     Correcto SOLO en una red local (una PC y los celulares del mismo WiFi).\n" +
        "     Si este equipo es alcanzable desde internet, apagalo y usá HTTPS.\n",
    );
  }

  return cached;
}

/** Test helper: forget the cached parse so a new process.env can be applied. */
export function resetEnvCache(): void {
  cached = null;
}
