import { AppShell } from "@/components/layout/app-shell";
import { prisma } from "@/infra/db/client";
import { logout } from "@/server/auth/actions";
import { requireUser } from "@/server/auth/dal";

/**
 * The protected shell.
 *
 * `requireUser()` is the real authorization boundary. The proxy already
 * redirected an unauthenticated visitor, but a cookie's presence proves nothing:
 * here the session is re-verified against the database before a single figure is
 * rendered.
 */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();

  const organization = await prisma.organization.findUnique({
    where: { id: user.organizationId },
    select: { name: true },
  });

  return (
    <AppShell
      user={{ name: user.name, email: user.email, role: user.role }}
      organizationName={organization?.name ?? "Capital Control"}
      onLogout={logout}
    >
      {children}
    </AppShell>
  );
}
