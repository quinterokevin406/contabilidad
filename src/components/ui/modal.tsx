"use client";

import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Modal shell.
 *
 * Slides up from the bottom edge on a phone and centres on a desktop, because a
 * centred dialog on a small screen puts its buttons under the thumb reach and
 * its inputs under the keyboard.
 *
 * `busy` locks the dismiss paths while a financial operation is in flight: a
 * stray Escape mid-transaction leaves the operator unsure whether the payment
 * went through.
 */
export function Modal({
  title,
  subtitle,
  onClose,
  busy = false,
  footer,
  size = "md",
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  busy?: boolean;
  footer?: ReactNode;
  size?: "md" | "lg";
  children: ReactNode;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, busy]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <button
        type="button"
        aria-label="Cerrar"
        onClick={() => !busy && onClose()}
        className="absolute inset-0 bg-overlay backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "cc-card relative flex max-h-[92dvh] w-full flex-col overflow-hidden",
          "rounded-b-none sm:rounded-b-[var(--radius-card)]",
          size === "lg" ? "max-w-2xl" : "max-w-lg",
        )}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            {subtitle && (
              <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => !busy && onClose()}
            className="rounded-md p-1 text-ink-subtle hover:bg-surface-hover hover:text-ink"
          >
            <X className="size-4" />
            <span className="sr-only">Cerrar</span>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

        {footer && (
          <div className="flex shrink-0 justify-end gap-2 border-t border-line px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export const modalInputClass = cn(
  "h-10 w-full rounded-[var(--radius-control)] border border-line bg-canvas px-3",
  "text-sm text-ink placeholder:text-ink-subtle",
  "transition-colors outline-none focus:border-accent/50",
);

export function ModalField({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm text-ink-muted">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1.5 text-xs text-ink-subtle">{hint}</p>}
    </div>
  );
}
