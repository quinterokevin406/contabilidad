import Decimal from "decimal.js";

import { toDecimalRounding, type RoundingMode } from "./rounding";

// Enough head room that no chain of loan arithmetic can hit the precision wall.
// 40 significant digits against amounts capped at NUMERIC(18,2) is generous by
// many orders of magnitude.
Decimal.set({ precision: 40, toExpPos: 40, toExpNeg: -40 });

/** Anything we accept as a money-like input. `number` is deliberately absent. */
export type MoneyInput = Money | Decimal | string | bigint;

export class MoneyError extends Error {}

/**
 * An exact monetary amount.
 *
 * Design rules, in order of importance:
 *
 * 1. Never a JavaScript `number`. A float cannot hold 0.1 exactly, and a
 *    financial ledger that drifts by a centavo per operation is worthless. The
 *    constructor refuses `number` inputs outright, at the type level and at
 *    runtime, so the mistake cannot be made accidentally.
 * 2. Never rounds implicitly. Arithmetic keeps full precision. Rounding happens
 *    only through `quantize`, with an explicit mode and quantum, at the exact
 *    point the domain decides a figure becomes an official amount.
 * 3. Immutable. Every operation returns a new instance.
 */
export class Money {
  private readonly amount: Decimal;

  private constructor(amount: Decimal) {
    this.amount = amount;
  }

  // --- Construction --------------------------------------------------------

  /**
   * Builds a Money from an exact representation.
   *
   * Accepts a decimal string ("1000000", "1000000.55"), a bigint, a Decimal or
   * another Money. Rejects `number` because binary floats cannot represent
   * decimal money exactly.
   */
  static of(input: MoneyInput): Money {
    if (input instanceof Money) return input;
    if (input instanceof Decimal) return new Money(Money.assertFinite(input));
    if (typeof input === "bigint") return new Money(new Decimal(input.toString()));

    if (typeof input === "string") {
      const trimmed = input.trim();
      if (trimmed === "") {
        throw new MoneyError("Money.of received an empty string.");
      }
      // Reject thousands separators and currency symbols: parsing display text
      // is the caller's job, and silently accepting "1.000.000" would read as
      // one peso with fractional centavos.
      if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
        throw new MoneyError(
          `Money.of expects a plain decimal string, received "${input}". ` +
            "Parse formatted input before constructing Money.",
        );
      }
      return new Money(Money.assertFinite(new Decimal(trimmed)));
    }

    throw new MoneyError(
      "Money.of refuses number inputs: binary floats lose decimal precision. " +
        "Pass a string, bigint or Decimal instead.",
    );
  }

  /**
   * Escape hatch for values that genuinely originate as a `number`, such as a
   * parsed form field that has already been validated. Named to be conspicuous
   * in review; never use it inside the financial engine.
   */
  static fromUnsafeNumber(value: number): Money {
    if (!Number.isFinite(value)) {
      throw new MoneyError("Money.fromUnsafeNumber received a non-finite value.");
    }
    return new Money(Money.assertFinite(new Decimal(value.toString())));
  }

  static zero(): Money {
    return new Money(new Decimal(0));
  }

  private static assertFinite(value: Decimal): Decimal {
    if (!value.isFinite()) {
      throw new MoneyError("Money cannot represent a non-finite amount.");
    }
    return value;
  }

  // --- Arithmetic ----------------------------------------------------------

  plus(other: MoneyInput): Money {
    return new Money(this.amount.plus(Money.of(other).amount));
  }

  minus(other: MoneyInput): Money {
    return new Money(this.amount.minus(Money.of(other).amount));
  }

  /** Multiplies by a dimensionless factor. Keeps full precision. */
  times(factor: Decimal | string | bigint | number): Money {
    return new Money(this.amount.times(new Decimal(factor.toString())));
  }

  /** Divides by a dimensionless divisor. Keeps full precision. */
  dividedBy(divisor: Decimal | string | bigint | number): Money {
    const d = new Decimal(divisor.toString());
    if (d.isZero()) throw new MoneyError("Money.dividedBy received zero.");
    return new Money(this.amount.dividedBy(d));
  }

  /**
   * Applies a percentage rate, unrounded.
   *
   * `percentOf("20")` on $1.000.000 yields exactly 200000. On $1.333.333 it
   * yields 266666.6 and keeps that .6 — the caller decides when and how it
   * becomes an official peso figure.
   */
  percentOf(ratePercent: Decimal | string | bigint): Money {
    return new Money(
      this.amount.times(new Decimal(ratePercent.toString())).dividedBy(100),
    );
  }

  negated(): Money {
    return new Money(this.amount.negated());
  }

  abs(): Money {
    return new Money(this.amount.abs());
  }

  // --- Rounding ------------------------------------------------------------

  /**
   * Snaps the amount to a multiple of `quantum` using `mode`.
   *
   * `quantum` is the smallest representable unit in currency terms: "1" for
   * whole pesos, "0.01" if centavos were ever needed. This is the only place in
   * the system where precision is deliberately given up, which makes rounding
   * behaviour auditable in one function instead of scattered across the app.
   */
  quantize(quantum: MoneyInput, mode: RoundingMode): Money {
    const q = Money.of(quantum).amount;
    if (q.lte(0)) {
      throw new MoneyError("quantize requires a positive quantum.");
    }
    const snapped = this.amount
      .dividedBy(q)
      .toDecimalPlaces(0, toDecimalRounding(mode))
      .times(q);
    return new Money(snapped);
  }

  // --- Comparison ----------------------------------------------------------

  isZero(): boolean {
    return this.amount.isZero();
  }

  isPositive(): boolean {
    return this.amount.greaterThan(0);
  }

  isNegative(): boolean {
    return this.amount.lessThan(0);
  }

  equals(other: MoneyInput): boolean {
    return this.amount.equals(Money.of(other).amount);
  }

  greaterThan(other: MoneyInput): boolean {
    return this.amount.greaterThan(Money.of(other).amount);
  }

  greaterThanOrEqual(other: MoneyInput): boolean {
    return this.amount.greaterThanOrEqualTo(Money.of(other).amount);
  }

  lessThan(other: MoneyInput): boolean {
    return this.amount.lessThan(Money.of(other).amount);
  }

  lessThanOrEqual(other: MoneyInput): boolean {
    return this.amount.lessThanOrEqualTo(Money.of(other).amount);
  }

  /** Returns whichever is smaller. Used constantly when capping allocations. */
  static min(a: MoneyInput, b: MoneyInput): Money {
    const left = Money.of(a);
    const right = Money.of(b);
    return left.lessThanOrEqual(right) ? left : right;
  }

  static max(a: MoneyInput, b: MoneyInput): Money {
    const left = Money.of(a);
    const right = Money.of(b);
    return left.greaterThanOrEqual(right) ? left : right;
  }

  static sum(values: readonly MoneyInput[]): Money {
    return values.reduce<Money>((acc, v) => acc.plus(v), Money.zero());
  }

  // --- Output --------------------------------------------------------------

  /**
   * Canonical persistence form: a fixed 2-decimal string matching
   * NUMERIC(18,2). Throws if the value still carries precision beyond what the
   * column can hold, because silently truncating on the way to the database is
   * exactly the class of bug this type exists to prevent.
   */
  toDatabaseString(): string {
    const rounded = this.amount.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
    if (!rounded.equals(this.amount)) {
      throw new MoneyError(
        `Money ${this.amount.toFixed()} has more precision than NUMERIC(18,2) ` +
          "can store. Quantize it before persisting.",
      );
    }
    return rounded.toFixed(2);
  }

  /** Exact decimal string with no forced scale. For logs and audit payloads. */
  toString(): string {
    return this.amount.toFixed();
  }

  toDecimal(): Decimal {
    return new Decimal(this.amount);
  }

  /**
   * Lossy conversion, for chart libraries that only accept numbers. Never feed
   * the result back into a calculation.
   */
  toChartNumber(): number {
    return this.amount.toNumber();
  }

  toJSON(): string {
    return this.toString();
  }
}

/** Convenience alias used throughout the domain. */
export const money = Money.of;
