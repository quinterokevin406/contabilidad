import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Button.
 *
 * `danger` is visually distinct rather than merely red, because the actions it
 * carries — reversing a payment, writing off a loan — are the ones that must
 * never be clicked by muscle memory.
 */
const buttonStyles = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap",
    "font-medium transition-[background-color,border-color,color,transform]",
    "duration-150 active:translate-y-px",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary:
          "bg-accent text-accent-ink hover:bg-accent-strong font-semibold",
        secondary:
          "bg-surface-raised text-ink border border-line-strong hover:bg-surface-hover",
        ghost: "text-ink-muted hover:bg-surface-raised hover:text-ink",
        danger:
          "bg-danger-soft text-danger border border-danger/30 hover:bg-danger hover:text-white",
        outline:
          "border border-line-strong text-ink hover:border-accent hover:text-accent",
      },
      size: {
        sm: "h-8 rounded-[var(--radius-control)] px-3 text-xs [&_svg]:size-3.5",
        md: "h-10 rounded-[var(--radius-control)] px-4 text-sm [&_svg]:size-4",
        lg: "h-12 rounded-[var(--radius-control)] px-6 text-base [&_svg]:size-5",
        icon: "size-10 rounded-[var(--radius-control)] [&_svg]:size-4",
      },
      block: { true: "w-full", false: "" },
    },
    defaultVariants: { variant: "secondary", size: "md", block: false },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonStyles> {
  children?: ReactNode;
}

export function Button({
  className,
  variant,
  size,
  block,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      // Defaulting to "button" avoids the classic bug where a button inside a
      // form submits it by accident.
      type={type}
      className={cn(buttonStyles({ variant, size, block }), className)}
      {...props}
    />
  );
}

export { buttonStyles };
