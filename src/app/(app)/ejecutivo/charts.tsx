"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatMoney, formatMoneyCompact, formatPercent } from "@/core/money/format";

/**
 * Growth charts (points 69, 77, 78, 80).
 *
 * ## One axis, always
 *
 * There are three charts here rather than one because equity (tens of millions)
 * and monthly profit (single millions) do not share a scale. A dual-axis chart
 * would let either line be drawn anywhere relative to the other, which is how a
 * chart lies without any number being wrong. Measures of different magnitude get
 * their own chart.
 *
 * ## The palette
 *
 * Three categorical hues in fixed order, validated against this surface
 * (#121418) rather than chosen by eye: OKLCH lightness inside the dark-mode band
 * [0.48, 0.67], chroma above the gray floor, adjacent CVD separation above the
 * ΔE 8 target under protanopia and deuteranopia, and every slot above 3:1
 * contrast. Identity never rests on colour alone — every chart carries a legend
 * and the tooltip names each series.
 */

const SERIES = {
  primary: "#00ab74",
  secondary: "#4a86d8",
  tertiary: "#b08d20",
} as const;

const INK = "#9aa2ae";
const INK_SUBTLE = "#6a7280";
const LINE = "#232730";
const SURFACE = "#181b21";

const AXIS = {
  stroke: LINE,
  tick: { fill: INK_SUBTLE, fontSize: 11 },
  tickLine: false,
  axisLine: false,
} as const;

interface TooltipPayload {
  name?: string;
  value?: number | string;
  color?: string;
  dataKey?: string | number;
}

function MoneyTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-[var(--radius-control)] border border-line-strong bg-surface-raised px-3 py-2 shadow-[var(--shadow-pop)]">
      <p className="mb-1.5 text-xs font-medium text-ink">{label}</p>
      <ul className="space-y-1">
        {payload.map((entry) => (
          <li
            key={String(entry.dataKey)}
            className="flex items-center gap-2 text-xs"
          >
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: entry.color }}
            />
            {/* Text stays in ink tokens; the dot carries the identity. */}
            <span className="text-ink-muted">{entry.name}</span>
            <span className="cc-tabular ml-auto text-ink">
              {formatMoney(String(entry.value ?? 0))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PercentTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  const entry = payload[0];

  return (
    <div className="rounded-[var(--radius-control)] border border-line-strong bg-surface-raised px-3 py-2 shadow-[var(--shadow-pop)]">
      <p className="text-xs font-medium text-ink">{label}</p>
      <p className="cc-tabular mt-1 text-xs text-ink-muted">
        Cartera vencida:{" "}
        <span className="text-ink">
          {formatPercent(entry?.value == null ? null : String(entry.value))}
        </span>
      </p>
    </div>
  );
}

function legendFormatter(value: string) {
  return <span className="text-xs text-ink-muted">{value}</span>;
}

export interface MoneySeriesPoint {
  label: string;
  [key: string]: string | number;
}

/** Equity, capital placed and cash across months (points 69 and 80). */
export function EvolutionChart({ data }: { data: MoneySeriesPoint[] }) {
  return (
    <div className="h-72 w-full px-2 pt-2 pb-1">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
          <defs>
            <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SERIES.primary} stopOpacity={0.22} />
              <stop offset="100%" stopColor={SERIES.primary} stopOpacity={0} />
            </linearGradient>
          </defs>

          {/* Recessive grid: horizontal only, so it reads as a reference and
              not as part of the data. */}
          <CartesianGrid stroke={LINE} vertical={false} />
          <XAxis dataKey="label" {...AXIS} />
          <YAxis
            {...AXIS}
            width={62}
            tickFormatter={(value: number) => formatMoneyCompact(String(value))}
          />
          <Tooltip
            content={<MoneyTooltip />}
            cursor={{ stroke: INK_SUBTLE, strokeWidth: 1 }}
          />
          <Legend formatter={legendFormatter} iconType="circle" iconSize={8} />

          <Area
            type="monotone"
            dataKey="patrimonio"
            name="Patrimonio"
            stroke={SERIES.primary}
            strokeWidth={2}
            fill="url(#equityFill)"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: SURFACE }}
          />
          <Area
            type="monotone"
            dataKey="capital"
            name="Capital colocado"
            stroke={SERIES.secondary}
            strokeWidth={2}
            fill="transparent"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: SURFACE }}
          />
          <Area
            type="monotone"
            dataKey="caja"
            name="Caja disponible"
            stroke={SERIES.tertiary}
            strokeWidth={2}
            fill="transparent"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: SURFACE }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Income, expenses and profit per month (point 77). */
export function ResultChart({ data }: { data: MoneySeriesPoint[] }) {
  return (
    <div className="h-64 w-full px-2 pt-2 pb-1">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
          <CartesianGrid stroke={LINE} vertical={false} />
          <XAxis dataKey="label" {...AXIS} />
          <YAxis
            {...AXIS}
            width={62}
            tickFormatter={(value: number) => formatMoneyCompact(String(value))}
          />
          <Tooltip
            content={<MoneyTooltip />}
            cursor={{ stroke: INK_SUBTLE, strokeWidth: 1 }}
          />
          <Legend formatter={legendFormatter} iconType="circle" iconSize={8} />

          <Line
            type="monotone"
            dataKey="ingresos"
            name="Ingresos operativos"
            stroke={SERIES.primary}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: SURFACE }}
          />
          <Line
            type="monotone"
            dataKey="gastos"
            name="Gastos operativos"
            stroke={SERIES.tertiary}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: SURFACE }}
          />
          <Line
            type="monotone"
            dataKey="utilidad"
            name="Utilidad neta"
            stroke={SERIES.secondary}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: SURFACE }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface PercentPoint {
  label: string;
  morosidad: number | null;
}

/**
 * Delinquency ratio over time (point 78).
 *
 * A single series, so no legend box — the card title names it. Percentages get
 * their own chart rather than sharing an axis with money.
 */
export function DelinquencyChart({ data }: { data: PercentPoint[] }) {
  return (
    <div className="h-56 w-full px-2 pt-2 pb-1">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
          <defs>
            <linearGradient id="delinquencyFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ff5a5f" stopOpacity={0.2} />
              <stop offset="100%" stopColor="#ff5a5f" stopOpacity={0} />
            </linearGradient>
          </defs>

          <CartesianGrid stroke={LINE} vertical={false} />
          <XAxis dataKey="label" {...AXIS} />
          <YAxis
            {...AXIS}
            width={44}
            tickFormatter={(value: number) => `${Math.round(value)}%`}
          />
          <Tooltip
            content={<PercentTooltip />}
            cursor={{ stroke: INK_SUBTLE, strokeWidth: 1 }}
          />
          <Area
            type="monotone"
            dataKey="morosidad"
            name="Morosidad"
            stroke="#ff5a5f"
            strokeWidth={2}
            fill="url(#delinquencyFill)"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: SURFACE }}
            // A month with no portfolio has no ratio; the line breaks rather
            // than dropping to a zero that never happened.
            connectNulls={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export { SERIES as CHART_SERIES, INK as CHART_INK };
