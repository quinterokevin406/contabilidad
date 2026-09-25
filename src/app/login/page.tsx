import type { Metadata } from "next";

import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Ingresar",
};

export default function LoginPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      {/*
        A single soft radial wash behind the card. Enough to keep a full-screen
        near-black page from feeling like a terminal, without the heavy gradients
        that make financial software look like a crypto landing page.
      */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 opacity-60"
        style={{
          background:
            "radial-gradient(60rem 40rem at 50% -10%, #00d68f14, transparent 70%)",
        }}
      />

      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 grid size-12 place-items-center rounded-xl bg-accent text-lg font-bold text-accent-ink shadow-[var(--shadow-card)]">
            CC
          </div>
          <h1 className="text-xl font-semibold text-ink">Capital Control</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Administración de préstamos y cartera
          </p>
        </div>

        <div className="cc-card px-6 py-7">
          <LoginForm />
        </div>

        <p className="mt-6 text-center text-xs text-ink-subtle">
          Sistema privado. Todos los accesos quedan registrados.
        </p>
      </div>
    </div>
  );
}
