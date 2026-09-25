"use client";

import { useState } from "react";

import { formatMoney } from "@/core/money/format";
import { cn } from "@/lib/cn";

/**
 * Portfolio aging (point 79).
 *
 * ## Why one hue and not six
 *
 * Age bands are ORDINAL, not nominal: swapping "1–7 días" with "+90 días" would
 * change the meaning. Ordinal data takes a single-hue ramp with monotone
 * lightness steps, so the reader sees the order in the colour itself. Six
 * unrelated hues would spend the identity channel re-encoding something the
 * order already says, and would imply the buckets are unrelated categories.
 *
 * ## Why this ramp
 *
 * One hue (the danger red), stepped dim -> bright rather than light -> dark,
 * because the surface here is near-black: on a dark ground salience increases
 * with brightness, and severity should increase with salience. Lightness is
 * monotone across all six steps (0.466 -> 0.791 in OKLab), which is the check
 * that matters for a ramp.
 *
 * The dimmest step sits at 2.5:1 against the surface — above the 2:1 floor for
 * an ordinal ramp, below the 3:1 comfort line — so every bar carries a visible
 * value label rather than relying on the fill alone. That label is the required
 * relief, not decoration.
 */

const RAMP = [
  "#8f3a3e",
  "#a94449",
  "#c4545a",
  "#dc666c",
  "#f07d83",
  "#ff9a9f",
] as const;

export interface AgingBucketView {
  label: string;
  loanCount: number;
  clientCount: number;
  /** Decimal string. */
  amount: string;
}

export function AgingChart({ buckets }: { buckets: AgingBucketView[] }) {
  const [hovered, setHovered] = useState<number | null>(null);

  const max = buckets.reduce(
    (acc, bucket) => Math.max(acc, Number(bucket.amount)),
    0,
  );

  if (max === 0) {
    return (
      <p className="px-5 py-8 text-center text-sm text-ink-muted">
        No hay cartera vencida para clasificar.
      </p>
    );
  }

  return (
    <div className="px-5 py-4">
      <ul className="space-y-3">
        {buckets.map((bucket, index) => {
          const amount = Number(bucket.amount);
          const share = max === 0 ? 0 : (amount / max) * 100;
          const isHovered = hovered === index;

          return (
            <li
              key={bucket.label}
              onMouseEnter={() => setHovered(index)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(index)}
              onBlur={() => setHovered(null)}
              tabIndex={0}
              className="relative rounded-[var(--radius-control)] outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-xs text-ink-muted">{bucket.label}</span>
                {/* Direct label on every bar: the required relief for a ramp
                    whose dimmest step sits below 3:1 on this surface. */}
                <span className="cc-tabular text-xs text-ink">
                  {formatMoney(bucket.amount)}
                </span>
              </div>

              <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-surface-raised">
                <div
                  className={cn(
                    "h-full rounded-full transition-[filter,width] duration-200",
                    isHovered && "brightness-125",
                  )}
                  style={{
                    width: `${amount === 0 ? 0 : Math.max(1.5, share)}%`,
                    backgroundColor: RAMP[index] ?? RAMP[RAMP.length - 1],
                  }}
                />
              </div>

              {isHovered && amount > 0 && (
                <div
                  role="tooltip"
                  className="absolute top-full right-0 z-10 mt-1 rounded-[var(--radius-control)] border border-line-strong bg-surface-raised px-3 py-2 text-xs shadow-[var(--shadow-pop)]"
                >
                  <p className="font-medium text-ink">{bucket.label}</p>
                  <p className="mt-0.5 text-ink-muted">
                    {bucket.loanCount}{" "}
                    {bucket.loanCount === 1 ? "préstamo" : "préstamos"} ·{" "}
                    {bucket.clientCount}{" "}
                    {bucket.clientCount === 1 ? "cliente" : "clientes"}
                  </p>
                  <p className="cc-tabular mt-0.5 text-ink">
                    {formatMoney(bucket.amount)}
                  </p>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {/*
        The table view the contrast warning obligates: every figure readable
        without depending on the fills at all.
      */}
      <details className="mt-5 border-t border-line pt-3">
        <summary className="cursor-pointer text-xs text-ink-subtle hover:text-ink">
          Ver como tabla
        </summary>
        <table className="mt-3 w-full text-xs">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="py-2 font-medium text-ink-subtle">Rango</th>
              <th className="py-2 text-right font-medium text-ink-subtle">
                Préstamos
              </th>
              <th className="py-2 text-right font-medium text-ink-subtle">
                Clientes
              </th>
              <th className="py-2 text-right font-medium text-ink-subtle">
                Monto
              </th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket) => (
              <tr key={bucket.label} className="border-b border-line/60 last:border-0">
                <td className="py-2 text-ink-muted">{bucket.label}</td>
                <td className="cc-tabular py-2 text-right text-ink-muted">
                  {bucket.loanCount}
                </td>
                <td className="cc-tabular py-2 text-right text-ink-muted">
                  {bucket.clientCount}
                </td>
                <td className="cc-tabular py-2 text-right text-ink">
                  {formatMoney(bucket.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
