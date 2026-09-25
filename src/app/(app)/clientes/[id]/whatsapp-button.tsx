"use client";

import { MessageCircle, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { formatMoney } from "@/core/money/format";
import { formatDate } from "@/core/time/format";
import type { CalendarDate } from "@/core/time/calendar-date";

/**
 * WhatsApp contact (point 23).
 *
 * Deliberately a two-step flow: the message is drafted, shown, and editable, and
 * nothing leaves the building until the operator presses the second button. The
 * system never sends on its own — these are debt reminders to real people, and
 * an automatic send is how a business ends up messaging someone who already paid.
 *
 * The draft is neutral by default. No threats, no pressure; a reminder of a date
 * and an amount.
 */

export interface WhatsAppButtonProps {
  phone: string;
  clientName: string;
  nextDueOn: CalendarDate | null;
  /** Decimal string, or null when nothing is outstanding. */
  amountDue: string | null;
}

export function WhatsAppButton({
  phone,
  clientName,
  nextDueOn,
  amountDue,
}: WhatsAppButtonProps) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState(() =>
    defaultMessage(clientName, nextDueOn, amountDue),
  );

  function openWhatsApp() {
    const digits = phone.replace(/\D/g, "");
    // Colombian numbers are stored without the country code; wa.me needs it.
    const international = digits.length === 10 ? `57${digits}` : digits;
    const url = `https://wa.me/${international}?text=${encodeURIComponent(message)}`;
    window.open(url, "_blank", "noopener,noreferrer");
    setOpen(false);
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <MessageCircle />
        Contactar por WhatsApp
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Cerrar"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-overlay backdrop-blur-sm"
          />

          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="wa-title"
            className="cc-card relative w-full max-w-md shadow-[var(--shadow-pop)]"
          >
            <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
              <div>
                <h2 id="wa-title" className="text-sm font-semibold text-ink">
                  Mensaje para {clientName.split(" ")[0]}
                </h2>
                <p className="mt-0.5 text-xs text-ink-muted">
                  Revisalo y editalo antes de enviar
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md p-1 text-ink-subtle hover:bg-surface-hover hover:text-ink"
              >
                <X className="size-4" />
                <span className="sr-only">Cerrar</span>
              </button>
            </div>

            <div className="px-5 py-4">
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                rows={5}
                className="w-full resize-y rounded-[var(--radius-control)] border border-line bg-canvas px-3.5 py-3 text-sm text-ink outline-none focus:border-accent/50"
              />
              <p className="mt-2 text-xs text-ink-subtle">
                Se abrirá WhatsApp con el mensaje listo. No se envía solo.
              </p>
            </div>

            <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancelar
              </Button>
              <Button
                variant="primary"
                onClick={openWhatsApp}
                disabled={message.trim().length === 0}
              >
                <MessageCircle />
                Abrir WhatsApp
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function defaultMessage(
  clientName: string,
  nextDueOn: CalendarDate | null,
  amountDue: string | null,
): string {
  const firstName = clientName.trim().split(/\s+/)[0] ?? clientName;

  if (nextDueOn && amountDue && Number(amountDue) > 0) {
    return (
      `Hola ${firstName}, te recordamos que tienes un pago programado para el ` +
      `${formatDate(nextDueOn)} por ${formatMoney(amountDue)}. Gracias.`
    );
  }

  if (nextDueOn) {
    return (
      `Hola ${firstName}, te recordamos que tienes un pago programado para el ` +
      `${formatDate(nextDueOn)}. Gracias.`
    );
  }

  return `Hola ${firstName}, te escribimos de parte de Capital Control. `;
}
