"use client";

import { AlertCircle, Loader2, LogIn } from "lucide-react";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { login, type LoginState } from "@/server/auth/actions";
import { cn } from "@/lib/cn";

const INITIAL: LoginState = { error: null };

export function LoginForm() {
  const [state, formAction, pending] = useActionState(login, INITIAL);

  return (
    <form action={formAction} className="space-y-4">
      <Field
        label="Correo"
        name="email"
        type="email"
        autoComplete="username"
        placeholder="admin@capitalcontrol.local"
        error={state.fieldErrors?.email}
        autoFocus
      />

      <Field
        label="Contraseña"
        name="password"
        type="password"
        autoComplete="current-password"
        placeholder="••••••••"
        error={state.fieldErrors?.password}
      />

      {state.error && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-[var(--radius-control)] border border-danger/30 bg-danger-soft px-3.5 py-3"
        >
          <AlertCircle className="mt-px size-4 shrink-0 text-danger" />
          <p className="text-sm text-danger">{state.error}</p>
        </div>
      )}

      <Button
        type="submit"
        variant="primary"
        size="lg"
        block
        // Disabled while pending, so a double click cannot start two attempts.
        disabled={pending}
        className="mt-2"
      >
        {pending ? (
          <>
            <Loader2 className="animate-spin" />
            Verificando…
          </>
        ) : (
          <>
            <LogIn />
            Ingresar
          </>
        )}
      </Button>
    </form>
  );
}

function Field({
  label,
  name,
  type,
  placeholder,
  autoComplete,
  error,
  autoFocus,
}: {
  label: string;
  name: string;
  type: string;
  placeholder?: string;
  autoComplete?: string;
  error?: string;
  autoFocus?: boolean;
}) {
  const id = `field-${name}`;
  const errorId = `${id}-error`;

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm text-ink-muted">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        placeholder={placeholder}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        required
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={cn(
          "h-11 w-full rounded-[var(--radius-control)] border bg-surface px-3.5",
          "text-sm text-ink placeholder:text-ink-subtle",
          "transition-colors outline-none",
          error
            ? "border-danger/50 focus:border-danger"
            : "border-line focus:border-accent/60",
        )}
      />
      {error && (
        <p id={errorId} className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
