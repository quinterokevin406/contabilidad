import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Status badge.
 *
 * Point 56 is a hard requirement here: colour is never the only signal. The
 * component takes its label as required children and pairs every tone with a
 * filled dot, so the badge still reads correctly in greyscale, on a washed-out
 * phone screen in daylight, and for the roughly one man in twelve with a colour
 * vision deficiency.
 */

export type BadgeTone =
  | "positive"
  | "warning"
  | "danger"
  | "info"
  | "neutral"
  | "accent";

const TONE_STYLES: Record<BadgeTone, { wrap: string; dot: string }> = {
  positive: {
    wrap: "bg-positive-soft text-positive border-positive/25",
    dot: "bg-positive",
  },
  warning: {
    wrap: "bg-warning-soft text-warning border-warning/25",
    dot: "bg-warning",
  },
  danger: {
    wrap: "bg-danger-soft text-danger border-danger/25",
    dot: "bg-danger",
  },
  info: { wrap: "bg-info-soft text-info border-info/25", dot: "bg-info" },
  accent: {
    wrap: "bg-accent-soft text-accent border-accent/25",
    dot: "bg-accent",
  },
  neutral: {
    wrap: "bg-surface-raised text-ink-muted border-line-strong",
    dot: "bg-ink-subtle",
  },
};

export interface BadgeProps {
  tone?: BadgeTone;
  /** The label. Required on purpose — a bare coloured dot is not a status. */
  children: ReactNode;
  showDot?: boolean;
  className?: string;
  /** Longer explanation, surfaced as a native tooltip. */
  title?: string;
}

export function Badge({
  tone = "neutral",
  children,
  showDot = true,
  className,
  title,
}: BadgeProps) {
  const styles = TONE_STYLES[tone];

  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1",
        "text-xs font-medium whitespace-nowrap",
        styles.wrap,
        className,
      )}
    >
      {showDot && (
        <span
          aria-hidden="true"
          className={cn("size-1.5 shrink-0 rounded-full", styles.dot)}
        />
      )}
      {children}
    </span>
  );
}
