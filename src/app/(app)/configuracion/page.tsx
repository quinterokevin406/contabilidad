import type { Metadata } from "next";
import { Lock } from "lucide-react";

import { Card } from "@/components/ui/card";
import { getOrganizationSettings, requireUser } from "@/server/auth/dal";
import {
  configurationFootprint,
  listAlertRules,
  listCategories,
  listGoals,
  listMethods,
} from "@/server/settings/queries";

import { CategoriesCard, MethodsCard } from "./catalogs";
import { DefaultsForm } from "./defaults-form";
import { AlertsCard, GoalsCard } from "./targets";

export const metadata: Metadata = { title: "Configuración" };

export default async function SettingsPage() {
  const user = await requireUser();
  const settings = await getOrganizationSettings();
  const readOnly = user.role !== "ADMIN";

  const [categories, methods, goals, rules, footprint] = await Promise.all([
    listCategories(user.organizationId),
    listMethods(user.organizationId),
    listGoals(user.organizationId),
    listAlertRules(user.organizationId),
    configurationFootprint(user.organizationId),
  ]);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Configuración</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Cómo trabaja el negocio de acá en adelante
        </p>
      </header>

      {readOnly && (
        <Card className="flex items-start gap-3 border-warning/25 bg-warning-soft/20 px-5 py-4">
          <Lock className="mt-0.5 size-4 shrink-0 text-warning" />
          <p className="text-xs text-ink-muted">
            Podés ver la configuración, pero solo un administrador puede
            modificarla.
          </p>
        </Card>
      )}

      <DefaultsForm
        settings={{
          businessName: settings.businessName,
          timeZone: settings.timeZone,
          defaultInterestMethod: settings.defaultInterestMethod,
          defaultPeriodicity: settings.defaultPeriodicity,
          defaultAllocationStrategy: settings.defaultAllocationStrategy,
          defaultPeriodAnchor: settings.defaultPeriodAnchor,
          defaultRoundingMode: settings.defaultRoundingMode,
          defaultOpenPeriodPolicy: settings.defaultOpenPeriodPolicy,
          defaultRenewalDueBasis: settings.defaultRenewalDueBasis,
          dueSoonLeadDays: settings.dueSoonLeadDays,
          overdueGraceDays: settings.overdueGraceDays,
          rateReviewThresholdPercent:
            settings.rateReviewThresholdPercent?.toString() ?? null,
          rateReviewNote: settings.rateReviewNote,
          receiptPrefix: settings.receiptPrefix,
        }}
        footprint={footprint}
        readOnly={readOnly}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <CategoriesCard
          categories={categories}
          financialClass="OPERATING_EXPENSE"
          title="Categorías de gasto"
          description="Solo gastos operativos: capital e intereses nunca pasan por acá"
          readOnly={readOnly}
        />
        <CategoriesCard
          categories={categories}
          financialClass="OPERATING_INCOME"
          title="Categorías de ingreso"
          description="Ingresos que no vienen de un préstamo"
          readOnly={readOnly}
        />
      </div>

      <MethodsCard methods={methods} readOnly={readOnly} />

      <div className="grid gap-6 lg:grid-cols-2">
        <GoalsCard goals={goals} readOnly={readOnly} />
        <AlertsCard rules={rules} readOnly={readOnly} />
      </div>

      <Card className="px-5 py-4">
        <p className="text-xs text-ink-muted">
          El sistema tiene{" "}
          <strong className="text-ink">{footprint.loans} préstamos</strong>,{" "}
          <strong className="text-ink">{footprint.payments} pagos</strong> y{" "}
          <strong className="text-ink">
            {footprint.movements} movimientos de caja
          </strong>{" "}
          registrados. Nada de eso cambia al editar esta pantalla.
        </p>
      </Card>
    </div>
  );
}
