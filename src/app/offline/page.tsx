import type { Metadata } from "next";
import { WifiOff } from "lucide-react";

export const metadata: Metadata = { title: "Sin conexión" };

/**
 * Offline fallback (point 62).
 *
 * It deliberately shows NOTHING: no balance, no total, no last-known figure.
 * A cached number is a wrong number, and an operator who takes a payment
 * against one corrupts the ledger. Better an honest blank page.
 */
export default function OfflinePage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6">
      <div className="max-w-sm text-center">
        <div className="mx-auto flex size-14 items-center justify-center rounded-full border border-line bg-surface">
          <WifiOff className="size-6 text-ink-subtle" />
        </div>

        <h1 className="mt-5 text-lg font-semibold text-ink">Sin conexión</h1>

        <p className="mt-2 text-sm text-ink-muted">
          No se puede mostrar ningún saldo en este momento. Los números de este
          sistema se calculan en el servidor cada vez que se piden, y un saldo
          guardado en el teléfono podría estar desactualizado.
        </p>

        <p className="mt-4 text-xs text-ink-subtle">
          Volvé a intentarlo cuando tengas señal.
        </p>
      </div>
    </main>
  );
}
