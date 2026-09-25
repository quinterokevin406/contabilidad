"use client";

import { Check, Copy, MessageCircle, Printer } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * Receipt actions (point 32): print, PDF and share.
 *
 * PDF is the browser's own print dialog rather than a generated file. On a
 * phone that is "Guardar como PDF" in the share sheet; on a desktop it is the
 * print destination. It costs no dependency, gets accents and fonts right, and
 * the operator chooses the paper size — which matters when half of them print
 * on a thermal roll and half on letter.
 */
export function ReceiptActions({
  shareText,
  phone,
}: {
  shareText: string;
  phone: string | null;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(shareText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure origin, denied permission). The print and
      // WhatsApp paths still work, so this fails quietly rather than alarming.
    }
  }

  function shareWhatsApp() {
    if (!phone) return;
    const digits = phone.replace(/\D/g, "");
    const international = digits.length === 10 ? `57${digits}` : digits;
    window.open(
      `https://wa.me/${international}?text=${encodeURIComponent(shareText)}`,
      "_blank",
      "noopener,noreferrer",
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" size="sm" onClick={copy}>
        {copied ? <Check /> : <Copy />}
        {copied ? "Copiado" : "Copiar"}
      </Button>

      {phone && (
        <Button variant="secondary" size="sm" onClick={shareWhatsApp}>
          <MessageCircle />
          WhatsApp
        </Button>
      )}

      <Button variant="primary" size="sm" onClick={() => window.print()}>
        <Printer />
        Imprimir / PDF
      </Button>
    </div>
  );
}
