"use client";

import { AlertCircle, CheckCircle2, Loader2, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ModalField, modalInputClass } from "@/components/ui/modal";
import {
  saveOrganizationSettings,
  type SettingsResult,
} from "@/server/settings/actions";

const INITIAL: SettingsResult = { ok: false, error: null, message: null };

export interface DefaultsFormProps {
  settings: {
    businessName: string;
    timeZone: string;
    defaultInterestMethod: string;
    defaultPeriodicity: string;
    defaultAllocationStrategy: string;
    defaultPeriodAnchor: string;
    defaultRoundingMode: string;
    defaultOpenPeriodPolicy: string;
    defaultRenewalDueBasis: string;
    dueSoonLeadDays: number;
    overdueGraceDays: number;
    rateReviewThresholdPercent: string | null;
    rateReviewNote: string | null;
    receiptPrefix: string;
  };
  footprint: { loans: number; payments: number; movements: number };
  readOnly: boolean;
}

const TIME_ZONES = [
  "America/Bogota",
  "America/Lima",
  "America/Mexico_City",
  "America/Guayaquil",
  "America/Caracas",
  "America/Santiago",
  "America/Argentina/Buenos_Aires",
  "America/Panama",
];

export function DefaultsForm({
  settings,
  footprint,
  readOnly,
}: DefaultsFormProps) {
  const router = useRouter();
  const [result, action, pending] = useActionState(
    saveOrganizationSettings,
    INITIAL,
  );

  useEffect(() => {
    if (result.ok) router.refresh();
  }, [result.ok, router]);

  return (
    <form action={action}>
      <Card>
        <CardHeader
          title="Negocio y valores por defecto"
          description="Lo que el sistema propone al crear un préstamo nuevo"
        />

        <CardBody className="space-y-6">
          {footprint.loans > 0 && (
            <p className="rounded-[var(--radius-control)] border border-info/25 bg-info-soft/20 px-3 py-2.5 text-xs text-ink-muted">
              Estos valores son solo el punto de partida de los préstamos
              nuevos. Los {footprint.loans} préstamos ya registrados conservan
              las reglas con las que fueron creados: cambiar algo acá{" "}
              <strong className="text-ink">no recalcula ningún saldo</strong>.
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <ModalField label="Nombre del negocio" htmlFor="businessName">
              <input
                id="businessName"
                name="businessName"
                defaultValue={settings.businessName}
                className={modalInputClass}
                required
                disabled={readOnly}
              />
            </ModalField>

            <ModalField
              label="Zona horaria"
              htmlFor="timeZone"
              hint="Define qué es “hoy” para cobros y cierres de caja."
            >
              <select
                id="timeZone"
                name="timeZone"
                defaultValue={settings.timeZone}
                className={modalInputClass}
                disabled={readOnly}
              >
                {TIME_ZONES.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </ModalField>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <ModalField
              label="Método de interés"
              htmlFor="defaultInterestMethod"
              hint="Sobre capital original: la cuota no baja al abonar. Sobre saldo: baja."
            >
              <select
                id="defaultInterestMethod"
                name="defaultInterestMethod"
                defaultValue={settings.defaultInterestMethod}
                className={modalInputClass}
                disabled={readOnly}
              >
                <option value="SIMPLE_ON_ORIGINAL_PRINCIPAL">
                  Simple sobre capital original
                </option>
                <option value="SIMPLE_ON_OUTSTANDING_PRINCIPAL">
                  Simple sobre saldo de capital
                </option>
              </select>
            </ModalField>

            <ModalField label="Periodicidad" htmlFor="defaultPeriodicity">
              <select
                id="defaultPeriodicity"
                name="defaultPeriodicity"
                defaultValue={settings.defaultPeriodicity}
                className={modalInputClass}
                disabled={readOnly}
              >
                <option value="DAILY">Diaria</option>
                <option value="WEEKLY">Semanal</option>
                <option value="BIWEEKLY">Quincenal</option>
                <option value="MONTHLY">Mensual</option>
                <option value="CUSTOM">Personalizada</option>
              </select>
            </ModalField>

            <ModalField
              label="Aplicación del pago"
              htmlFor="defaultAllocationStrategy"
              hint="Orden en que un abono cubre intereses y capital."
            >
              <select
                id="defaultAllocationStrategy"
                name="defaultAllocationStrategy"
                defaultValue={settings.defaultAllocationStrategy}
                className={modalInputClass}
                disabled={readOnly}
              >
                <option value="INTEREST_FIRST">Primero intereses</option>
                <option value="PRINCIPAL_FIRST">Primero capital</option>
                <option value="MANUAL_ONLY">Siempre manual</option>
              </select>
            </ModalField>

            <ModalField
              label="Cálculo de vencimientos"
              htmlFor="defaultPeriodAnchor"
              hint="Calendario: el 31 de enero + 1 mes cae el 28/29 de febrero."
            >
              <select
                id="defaultPeriodAnchor"
                name="defaultPeriodAnchor"
                defaultValue={settings.defaultPeriodAnchor}
                className={modalInputClass}
                disabled={readOnly}
              >
                <option value="CALENDAR">Calendario</option>
                <option value="FIXED_DAYS">Días fijos</option>
              </select>
            </ModalField>

            <ModalField
              label="Redondeo"
              htmlFor="defaultRoundingMode"
              hint="Se aplica solo cuando un cálculo cae en fracción de peso."
            >
              <select
                id="defaultRoundingMode"
                name="defaultRoundingMode"
                defaultValue={settings.defaultRoundingMode}
                className={modalInputClass}
                disabled={readOnly}
              >
                <option value="HALF_UP">Medio hacia arriba</option>
                <option value="HALF_EVEN">Medio hacia par</option>
                <option value="DOWN">Hacia abajo</option>
                <option value="UP">Hacia arriba</option>
              </select>
            </ModalField>

            <ModalField
              label="Período en curso al liquidar"
              htmlFor="defaultOpenPeriodPolicy"
              hint="Qué se cobra del período que todavía no venció cuando el cliente cancela antes."
            >
              <select
                id="defaultOpenPeriodPolicy"
                name="defaultOpenPeriodPolicy"
                defaultValue={settings.defaultOpenPeriodPolicy}
                className={modalInputClass}
                disabled={readOnly}
              >
                <option value="FULL_PERIOD">Período completo</option>
                <option value="PRORATED">Proporcional a los días</option>
                <option value="NOT_CHARGED">No se cobra</option>
              </select>
            </ModalField>

            <ModalField
              label="Vencimiento al renovar"
              htmlFor="defaultRenewalDueBasis"
              hint="Fecha anterior: el préstamo mantiene su ritmo aunque el cliente pague tarde."
            >
              <select
                id="defaultRenewalDueBasis"
                name="defaultRenewalDueBasis"
                defaultValue={settings.defaultRenewalDueBasis}
                className={modalInputClass}
                disabled={readOnly}
              >
                <option value="PREVIOUS_DUE_DATE">
                  Desde la fecha de vencimiento anterior
                </option>
                <option value="EFFECTIVE_DATE">
                  Desde la fecha de la renovación
                </option>
              </select>
            </ModalField>

            <ModalField label="Prefijo de recibos" htmlFor="receiptPrefix">
              <input
                id="receiptPrefix"
                name="receiptPrefix"
                defaultValue={settings.receiptPrefix}
                maxLength={8}
                className={modalInputClass}
                required
                disabled={readOnly}
              />
            </ModalField>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <ModalField
              label="Aviso previo (días)"
              htmlFor="dueSoonLeadDays"
              hint="Cuántos días antes del vencimiento aparece en “Por vencer”."
            >
              <input
                id="dueSoonLeadDays"
                name="dueSoonLeadDays"
                type="number"
                min={0}
                max={60}
                defaultValue={settings.dueSoonLeadDays}
                className={modalInputClass}
                disabled={readOnly}
              />
            </ModalField>

            <ModalField
              label="Días de gracia"
              htmlFor="overdueGraceDays"
              hint="Días después del vencimiento antes de marcar el préstamo en mora."
            >
              <input
                id="overdueGraceDays"
                name="overdueGraceDays"
                type="number"
                min={0}
                max={60}
                defaultValue={settings.overdueGraceDays}
                className={modalInputClass}
                disabled={readOnly}
              />
            </ModalField>
          </div>

          {/* Point 60: advisory only. The system never alters a rate or a
              balance on its own, and never consults an external source. */}
          <div className="rounded-[var(--radius-control)] border border-line bg-canvas p-4">
            <p className="text-sm font-medium text-ink">
              Aviso administrativo de tasa
            </p>
            <p className="mt-1 mb-4 text-xs text-ink-muted">
              Si cargás un umbral, el sistema muestra una advertencia visual al
              registrar un préstamo con una tasa mayor. Es solo un recordatorio
              para que lo revises: no modifica contratos, no cambia saldos y no
              consulta nada por internet.
            </p>

            <div className="grid gap-4 sm:grid-cols-2">
              <ModalField
                label="Umbral mensual (%)"
                htmlFor="rateReviewThresholdPercent"
                hint="Dejalo vacío para no mostrar ningún aviso."
              >
                <input
                  id="rateReviewThresholdPercent"
                  name="rateReviewThresholdPercent"
                  inputMode="decimal"
                  placeholder="2.5"
                  defaultValue={settings.rateReviewThresholdPercent ?? ""}
                  className={modalInputClass}
                  disabled={readOnly}
                />
              </ModalField>

              <ModalField label="Texto del aviso" htmlFor="rateReviewNote">
                <input
                  id="rateReviewNote"
                  name="rateReviewNote"
                  placeholder="Revisar con el contador"
                  defaultValue={settings.rateReviewNote ?? ""}
                  className={modalInputClass}
                  disabled={readOnly}
                />
              </ModalField>
            </div>
          </div>

          {result.error && (
            <p className="flex items-start gap-2 text-sm text-danger">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              {result.error}
            </p>
          )}
          {result.ok && result.message && (
            <p className="flex items-start gap-2 text-sm text-positive">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
              {result.message}
            </p>
          )}

          {!readOnly && (
            <div className="flex justify-end">
              <Button type="submit" variant="primary" disabled={pending}>
                {pending ? <Loader2 className="animate-spin" /> : <Save />}
                Guardar configuración
              </Button>
            </div>
          )}
        </CardBody>
      </Card>
    </form>
  );
}
