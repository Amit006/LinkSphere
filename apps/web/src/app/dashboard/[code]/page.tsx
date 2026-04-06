'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, BarChart, Bar, Legend
} from 'recharts';

interface AnalyticsData {
  shortCode: string;
  totalClicks: number;
  uniqueClicks: number;
  clicksByDay: Record<string, number>;
  topCountries: Array<{ country: string; count: number }>;
  topReferers: Array<{ referer: string; count: number }>;
  deviceBreakdown: Record<string, number>;
}

const COLORS = ['#00e5ff', '#ff6b6b', '#00ffaa', '#ffd166', '#a78bfa'];

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 flex flex-col gap-2">
      <span className="text-xs font-mono text-gray-500 uppercase tracking-widest">{label}</span>
      <span className="text-4xl font-bold text-cyan-400 font-mono">{value}</span>
      {sub && <span className="text-xs text-gray-600">{sub}</span>}
    </div>
  );
}

export default function DashboardPage() {
  const params = useParams();
  const code = params.code as string;
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchAnalytics() {
      try {
        const res = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL}/api/analytics/${code}`
        );
        const json = await res.json();
        if (json.success) {
          setData(json.data);
        } else {
          setError(json.error?.message ?? 'Failed to load analytics');
        }
      } catch {
        setError('Network error');
      } finally {
        setLoading(false);
      }
    }
    fetchAnalytics();
  }, [code]);

  // Format clicks by day for chart
  const clicksByDayData = data
    ? Object.entries(data.clicksByDay)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, count]) => ({
          date: date.slice(5), // MM-DD
          clicks: count,
        }))
    : [];

  // Device breakdown for pie chart
  const deviceData = data
    ? Object.entries(data.deviceBreakdown).map(([device, count]) => ({
        name: device.charAt(0).toUpperCase() + device.slice(1),
        value: count,
      }))
    : [];

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="w-8 h-8 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-gray-500 font-mono text-sm">Loading analytics...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-center space-y-2">
          <p className="text-red-400 font-mono">{error}</p>
          <a href="/" className="text-cyan-400 text-sm hover:underline">← Back home</a>
        </div>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-6">
      <div className="max-w-6xl mx-auto space-y-8">

        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <a href="/" className="text-gray-500 text-sm hover:text-gray-300 font-mono">
              ← LinkSphere
            </a>
            <h1 className="text-3xl font-bold mt-1">
              Analytics for{' '}
              <span className="text-cyan-400 font-mono">
                lnk.amitnk19.workers.dev/{code}
              </span>
            </h1>
          </div>
          <a
            href={`https://lnk.amitnk19.workers.dev/${code}`}
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2 bg-cyan-500 text-gray-950 rounded-lg text-sm font-semibold hover:bg-cyan-400 transition-colors"
          >
            Visit Link →
          </a>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="Total Clicks" value={data!.totalClicks} />
          <StatCard label="Unique Visitors" value={data!.uniqueClicks} />
          <StatCard label="Countries" value={data!.topCountries.length} />
          <StatCard label="Short Code" value={code} sub="active" />
        </div>

        {/* Clicks over time */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <h2 className="text-sm font-mono text-gray-400 uppercase tracking-widest mb-6">
            Clicks Over Time (Last 30 Days)
          </h2>
          {clicksByDayData.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={clicksByDayData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis dataKey="date" stroke="#6b7280" tick={{ fontSize: 11, fontFamily: 'monospace' }} />
                <YAxis stroke="#6b7280" tick={{ fontSize: 11, fontFamily: 'monospace' }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: '8px', fontFamily: 'monospace' }}
                  labelStyle={{ color: '#9ca3af' }}
                  itemStyle={{ color: '#00e5ff' }}
                />
                <Line type="monotone" dataKey="clicks" stroke="#00e5ff" strokeWidth={2} dot={{ fill: '#00e5ff', r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-60 flex items-center justify-center text-gray-600 font-mono text-sm">
              No click data yet — share your link to start tracking!
            </div>
          )}
        </div>

        {/* Device + Countries row */}
        <div className="grid md:grid-cols-2 gap-6">

          {/* Device breakdown */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
            <h2 className="text-sm font-mono text-gray-400 uppercase tracking-widest mb-6">
              Device Breakdown
            </h2>
            {deviceData.length > 0 ? (
              <div className="flex items-center gap-6">
                <PieChart width={160} height={160}>
                  <Pie data={deviceData} cx={75} cy={75} innerRadius={45} outerRadius={75} dataKey="value" paddingAngle={3}>
                    {deviceData.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: '8px', fontFamily: 'monospace' }}
                    itemStyle={{ color: '#00e5ff' }}
                  />
                </PieChart>
                <div className="space-y-3 flex-1">
                  {deviceData.map((d, i) => (
                    <div key={d.name} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
                        <span className="text-sm text-gray-300">{d.name}</span>
                      </div>
                      <span className="text-sm font-mono text-gray-400">{d.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="h-40 flex items-center justify-center text-gray-600 font-mono text-sm">
                No device data yet
              </div>
            )}
          </div>

          {/* Top countries */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
            <h2 className="text-sm font-mono text-gray-400 uppercase tracking-widest mb-6">
              Top Countries
            </h2>
            {data!.topCountries.length > 0 ? (
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={data!.topCountries.slice(0, 5)} layout="vertical">
                  <XAxis type="number" stroke="#6b7280" tick={{ fontSize: 11, fontFamily: 'monospace' }} />
                  <YAxis type="category" dataKey="country" stroke="#6b7280" tick={{ fontSize: 11, fontFamily: 'monospace' }} width={32} />
                  <Tooltip
                    contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: '8px', fontFamily: 'monospace' }}
                    itemStyle={{ color: '#00ffaa' }}
                  />
                  <Bar dataKey="count" fill="#00ffaa" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-40 flex items-center justify-center text-gray-600 font-mono text-sm">
                No country data yet
              </div>
            )}
          </div>
        </div>

        {/* Top referers */}
        {data!.topReferers.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
            <h2 className="text-sm font-mono text-gray-400 uppercase tracking-widest mb-4">
              Top Referers
            </h2>
            <div className="space-y-2">
              {data!.topReferers.slice(0, 5).map((r) => (
                <div key={r.referer} className="flex items-center justify-between py-2 border-b border-gray-800 last:border-0">
                  <span className="text-sm font-mono text-gray-300 truncate">{r.referer}</span>
                  <span className="text-sm font-mono text-cyan-400 shrink-0 ml-4">{r.count} clicks</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <p className="text-center text-xs text-gray-700 font-mono pb-8">
          Data refreshes every 5 minutes · Built on AWS Lambda + PostgreSQL + Redis
        </p>
      </div>
    </main>
  );
}