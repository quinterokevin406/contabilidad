import Link from "next/link";
import { Compass } from "lucide-react";

import { Card, EmptyState } from "@/components/ui/card";

/**
 * Not found, rendered inside the application shell.
 *
 * Keeping the sidebar means a wrong turn does not feel like the application
 * crashed, and the operator can carry on from where they are.
 */
export default function AppNotFound() {
  return (
    <div className="mx-auto max-w-2xl">
      <Card>
        <EmptyState
          icon={<Compass className="size-8" />}
          title="Esta página no existe"
          description="El enlace puede estar equivocado, o el módulo todavía no está construido."
          action={
            <Link
              href="/"
              className="rounded-[var(--radius-control)] bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:bg-accent-strong"
            >
              Volver al dashboard
            </Link>
          }
        />
      </Card>
    </div>
  );
}
