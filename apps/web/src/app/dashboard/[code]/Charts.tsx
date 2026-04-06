'use client';

import type { AnalyticsSummary } from '@linksphere/core';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend,
  BarChart, Bar,
} from 'recharts';

interface Props {
  data: AnalyticsSummary;
}

// ── Color palette ─────────────────────────────────────────────────────────────
const CYAN    = '#22d3ee';
const INDIGO  = '#818cf8';
const AMBER   = '#fbbf24';
const EMERALD = '#34d399';
const PIE_COLORS = [CYAN, INDIGO, AMBER, EMERALD];

const TOOLTIP_STYLE = {
  backgroundColor: '#111827',
  border: '1px solid #1f2937',
  borderRadius: '8px',
  color: '#e5e7eb',
  fontSize: '12px',
};

// ── Fill in all 30 days (no gaps on X axis) ───────────────────────────────────
function buildDailyData(clicksByDay: Record<string, number>) {
  const result: { date: string; clicks: number }[] = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0]!;
    result.push({ date: key.slice(5), clicks: clicksByDay[key] ?? 0 });
  }
  return result;
}

export default function DashboardCharts({ data }: Props) {
  const dailyData = buildDailyData(data.clicksByDay);

  const deviceData = (Object.entries(data.deviceBreakdown) as [string, number][])
    .filter(([, v]) => v > 0)
    .map(([name, value]) => ({ name: name.charAt(0).toUpperCase() + name.slice(1), value }));

  const countryData = data.topCountries.slice(0, 8);

  return (
    <div className="space-y-6">

      {/* ── Clicks Over Time ──────────────────────────────────────────────── */}
      <ChartCard title="Clicks Over Time" subtitle="last 30 days">
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={dailyData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis
              dataKey="date"
              tick={{ fill: '#6b7280', fontSize: 11, fontFamily: 'var(--font-mono)' }}
              tickLine={false}
              axisLine={false}
              interval={6}
            />
            <YAxis
              tick={{ fill: '#6b7280', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              cursor={{ stroke: '#374151' }}
              formatter={(v: number) => [v, 'Clicks']}
            />
            <Line
              type="monotone"
              dataKey="clicks"
              stroke={CYAN}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: CYAN }}
            />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* ── Device + Countries ────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">

        {/* Device Breakdown */}
        <ChartCard title="Device Breakdown" subtitle="by click share">
          {deviceData.length === 0 ? (
            <EmptyState />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={deviceData}
                  cx="50%"
                  cy="50%"
                  innerRadius={55}
                  outerRadius={85}
                  paddingAngle={3}
                  dataKey="value"
                >
                  {deviceData.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v: number) => [v, 'Clicks']}
                />
                <Legend
                  iconType="circle"
                  iconSize={8}
                  formatter={(v) => (
                    <span style={{ color: '#9ca3af', fontSize: 12 }}>{v}</span>
                  )}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* Top Countries */}
        <ChartCard title="Top Countries" subtitle="by click count">
          {countryData.length === 0 ? (
            <EmptyState />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart
                data={countryData}
                layout="vertical"
                margin={{ top: 0, right: 8, bottom: 0, left: 8 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fill: '#6b7280', fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <YAxis
                  type="category"
                  dataKey="country"
                  tick={{ fill: '#9ca3af', fontSize: 12, fontFamily: 'var(--font-mono)' }}
                  tickLine={false}
                  axisLine={false}
                  width={30}
                />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  cursor={{ fill: '#1f2937' }}
                  formatter={(v: number) => [v, 'Clicks']}
                />
                <Bar dataKey="count" fill={INDIGO} radius={[0, 4, 4, 0]} maxBarSize={18} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

      </div>

      {/* ── Top Referers ──────────────────────────────────────────────────── */}
      <ChartCard title="Top Referers" subtitle="where clicks came from">
        {data.topReferers.length === 0 ? (
          <EmptyState message="No referer data yet" />
        ) : (
          <ul className="divide-y divide-gray-800">
            {data.topReferers.map(({ referer, count }, i) => (
              <li key={i} className="flex items-center justify-between py-3">
                <span className="font-mono text-sm text-gray-300 truncate mr-4" title={referer}>
                  {referer}
                </span>
                <span className="shrink-0 font-mono text-sm text-cyan-400">
                  {count.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </ChartCard>

    </div>
  );
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-6">
      <div className="mb-4 flex items-baseline gap-2">
        <h2 className="text-sm font-semibold text-gray-100">{title}</h2>
        <span className="text-xs font-mono text-gray-600">{subtitle}</span>
      </div>
      {children}
    </div>
  );
}

function EmptyState({ message = 'No data yet' }: { message?: string }) {
  return (
    <div className="flex h-[220px] items-center justify-center">
      <p className="font-mono text-sm text-gray-600">{message}</p>
    </div>
  );
}
