import Decimal from "decimal.js";

import { Money, type MoneyInput } from "./money";

/**
 * Presentation layer for money (point 2).
 *
 * Colombian convention: thousands separated by a dot, no decimals unless they
 * carry information, and no space after the symbol.
 *
 *   $1.000.000     not  $ 1.000.000,00
 *   $250.000
 *   $35.500.000
 *
 * `Intl.NumberFormat("es-CO")` inserts a non-breaking space after the symbol, so
 * it is stripped explicitly rather than left to the runtime.
 */

export interface FormatMoneyOptions {
  /** Include the currency symbol. Default true. */
  showSymbol?: boolean;
  /**
   * Show decimals. Default "auto": hidden when the amount is a whole unit,
   * shown with two places otherwise, so a residual centavo is never invisible.
   */
  decimals?: "auto" | "never" | "always";
  /** Prefix non-negative amounts with "+". Useful in movement lists. */
  signed?: boolean;
  locale?: string;
  currency?: string;
}

const SPACE_AFTER_SYMBOL = / | |\s/g;

export function formatMoney(
  value: MoneyInput,
  options: FormatMoneyOptions = {},
): string {
  const {
    showSymbol = true,
    decimals = "auto",
    signed = false,
    locale = "es-CO",
    currency = "COP",
  } = options;

  const amount = Money.of(value).toDecimal();
  const hasFraction = !amount.decimalPlaces || !amount.isInteger();
  const fractionDigits =
    decimals === "always" ? 2 : decimals === "never" ? 0 : hasFraction ? 2 : 0;

  const formatter = new Intl.NumberFormat(locale, {
    style: showSymbol ? "currency" : "decimal",
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
    currencyDisplay: "narrowSymbol",
  });

  // Format the absolute value, then attach the sign ourselves, so a negative
  // never renders as "-$1.000" in one place and "$-1.000" in another.
  const body = formatter
    .format(Number(amount.abs().toFixed(fractionDigits)))
    .replace(SPACE_AFTER_SYMBOL, "");

  if (amount.isNegative()) return `-${body}`;
  if (signed && amount.greaterThan(0)) return `+${body}`;
  return body;
}

/** Compact form for chart axes and dense tables: $1,2 M, $850 K. */
export function formatMoneyCompact(
  value: MoneyInput,
  options: { locale?: string } = {},
): string {
  const { locale = "es-CO" } = options;
  const amount = Money.of(value).toDecimal();
  const abs = amount.abs();
  const sign = amount.isNegative() ? "-" : "";

  const units: readonly [Decimal, string][] = [
    [new Decimal("1000000000000"), "B"],
    [new Decimal("1000000000"), "MM"],
    [new Decimal("1000000"), "M"],
    [new Decimal("1000"), "K"],
  ];

  for (const [threshold, suffix] of units) {
    if (abs.greaterThanOrEqualTo(threshold)) {
      const scaled = abs.dividedBy(threshold);
      const text = new Intl.NumberFormat(locale, {
        minimumFractionDigits: 0,
        maximumFractionDigits: scaled.lessThan(10) ? 1 : 0,
      }).format(Number(scaled.toFixed(2)));
      return `${sign}$${text} ${suffix}`;
    }
  }

  return `${sign}$${new Intl.NumberFormat(locale).format(Number(abs.toFixed(0)))}`;
}

/**
 * Renders a rate together with its period, so a 20% monthly rate can never be
 * mistaken for an annual one (point 6).
 */
export type RatePeriodLabel =
  | "DAILY"
  | "WEEKLY"
  | "BIWEEKLY"
  | "MONTHLY"
  | "CUSTOM";

const PERIOD_ADVERB: Record<RatePeriodLabel, string> = {
  DAILY: "diario",
  WEEKLY: "semanal",
  BIWEEKLY: "quincenal",
  MONTHLY: "mensual",
  CUSTOM: "por período",
};

export function formatRate(
  ratePercent: Decimal | string | number,
  periodicity: RatePeriodLabel,
  options: { customPeriodDays?: number | null; locale?: string } = {},
): string {
  const { customPeriodDays, locale = "es-CO" } = options;
  const rate = new Decimal(ratePercent.toString());

  const text = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(Number(rate.toFixed(4)));

  if (periodicity === "CUSTOM" && customPeriodDays) {
    return `${text}% cada ${customPeriodDays} días`;
  }
  return `${text}% ${PERIOD_ADVERB[periodicity]}`;
}

/**
 * Formats a ratio as a percentage, or "N/D" when it is not comparable.
 *
 * Point 73: a zero denominator must never surface as Infinity, NaN or a
 * misleading 0%.
 */
export function formatPercent(
  value: Decimal | string | number | null | undefined,
  options: { decimals?: number; signed?: boolean; locale?: string } = {},
): string {
  const { decimals = 1, signed = false, locale = "es-CO" } = options;
  if (value === null || value === undefined) return "N/D";

  const pct = new Decimal(value.toString());
  if (!pct.isFinite()) return "N/D";

  const text = new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Number(pct.toFixed(decimals + 2)));

  const prefix = signed && pct.greaterThan(0) ? "+" : "";
  return `${prefix}${text}%`;
}

/**
 * Formats a change measured in percentage points, which is what a delinquency
 * ratio moving from 6,5% to 10% actually is (point 71). Calling that a "+53,8%
 * increase" is technically true and practically misleading, so ratios report
 * their delta in points.
 */
export function formatPercentagePoints(
  delta: Decimal | string | number | null | undefined,
  options: { decimals?: number; locale?: string } = {},
): string {
  const { decimals = 1, locale = "es-CO" } = options;
  if (delta === null || delta === undefined) return "N/D";

  const d = new Decimal(delta.toString());
  if (!d.isFinite()) return "N/D";

  const text = new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Number(d.abs().toFixed(decimals + 2)));

  const sign = d.isNegative() ? "-" : d.greaterThan(0) ? "+" : "";
  // Pluralize on what is displayed, not on the numeric value: "1 punto" is
  // singular, but "1,0 puntos" reads plural in Spanish.
  const unit = text === "1" ? "punto" : "puntos";
  return `${sign}${text} ${unit}`;
}
