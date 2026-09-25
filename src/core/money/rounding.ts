import Decimal from "decimal.js";

/**
 * Rounding policy for monetary quantization.
 *
 * Mirrors the RoundingMode enum in the Prisma schema. Every loan stores the mode
 * it was created with, so changing an organization default tomorrow cannot
 * restate a balance that was already computed.
 */
export type RoundingMode = "HALF_UP" | "HALF_EVEN" | "DOWN" | "UP";

export const ROUNDING_MODES: readonly RoundingMode[] = [
  "HALF_UP",
  "HALF_EVEN",
  "DOWN",
  "UP",
] as const;

/** Maps our domain mode onto the decimal.js constant. */
export function toDecimalRounding(mode: RoundingMode): Decimal.Rounding {
  switch (mode) {
    case "HALF_UP":
      return Decimal.ROUND_HALF_UP;
    case "HALF_EVEN":
      return Decimal.ROUND_HALF_EVEN;
    case "DOWN":
      // Toward zero.
      return Decimal.ROUND_DOWN;
    case "UP":
      // Away from zero.
      return Decimal.ROUND_UP;
  }
}

export function isRoundingMode(value: unknown): value is RoundingMode {
  return (
    typeof value === "string" &&
    (ROUNDING_MODES as readonly string[]).includes(value)
  );
}
