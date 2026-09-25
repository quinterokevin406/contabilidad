import Decimal from "decimal.js";

import { Money, type MoneyInput } from "@/core/money/money";

/**
 * The boundary between the domain's Money and Prisma's Decimal columns.
 *
 * Prisma ships its own bundled decimal.js instance, so a `Prisma.Decimal` is not
 * `instanceof` the `Decimal` the domain imports even though both are decimal.js.
 * Every conversion therefore goes through an exact decimal STRING, which is the
 * one representation both sides agree on and which cannot lose a centavo.
 *
 * Never convert through `number`. That is the whole point.
 */

/** Anything a Prisma Decimal column hands back. */
export interface DecimalLike {
  toFixed(decimalPlaces?: number): string;
  toString(): string;
}

/** Reads a NUMERIC column into a Money. */
export function fromDb(value: DecimalLike | string | null | undefined): Money {
  if (value === null || value === undefined) return Money.zero();
  // toFixed() with no argument yields the exact value without exponent notation.
  return Money.of(typeof value === "string" ? value : value.toFixed());
}

/**
 * Prepares a Money for a NUMERIC(18,2) column.
 *
 * Returns a string, which Prisma accepts for Decimal fields and which keeps the
 * value exact all the way into Postgres. Throws if the amount still carries more
 * precision than the column can hold, rather than letting the driver silently
 * truncate it.
 */
export function toDb(value: MoneyInput): string {
  return Money.of(value).toDatabaseString();
}

/** Reads a NUMERIC column holding a rate or a ratio, not money. */
export function rateFromDb(value: DecimalLike | string | null | undefined): Decimal {
  if (value === null || value === undefined) return new Decimal(0);
  return new Decimal(typeof value === "string" ? value : value.toFixed());
}

/** Prepares a rate or ratio for a NUMERIC column. */
export function rateToDb(value: Decimal | string | number): string {
  return new Decimal(value.toString()).toFixed();
}
