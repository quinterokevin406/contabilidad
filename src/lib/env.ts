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
  return cached;
}

/** Test helper: forget the cached parse so a new process.env can be applied. */
export function resetEnvCache(): void {
  cached = null;
}
