'use client';

import { useState } from 'react';
import { ShortenRequestSchema } from '@linksphere/core';
import type { ShortenResponse } from '@linksphere/core';

export default function HomePage() {
  const [url, setUrl] = useState('');
  const [alias, setAlias] = useState('');
  const [result, setResult] = useState<ShortenResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleShorten() {
    setError(null);
    setResult(null);

    const parsed = ShortenRequestSchema.safeParse({ url, alias: alias || undefined });
    if (!parsed.success) {
      setError(parsed.error.errors[0]?.message ?? 'Invalid input');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/shorten`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });
      const data = await res.json();

      if (!data.success) {
        setError(data.error.message);
      } else {
        setResult(data.data);
      }
    } catch {
      setError('Network error — please try again');
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    if (!result) return;
    await navigator.clipboard.writeText(result.shortUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6">
      <div className="w-full max-w-lg space-y-8">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight">
            Link<span className="text-cyan-400">Sphere</span>
          </h1>
          <p className="mt-2 text-gray-400 font-mono text-sm">
            Shorten URLs. Track clicks. Understand your audience.
          </p>
        </div>

        {/* Shorten form */}
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-6 space-y-4">
          <div>
            <label className="block text-xs font-mono text-gray-500 mb-2 uppercase tracking-widest">
              Long URL
            </label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleShorten()}
              placeholder="https://your-very-long-url.com/with/many/params?q=foo"
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-3 text-sm
                         placeholder:text-gray-600 focus:border-cyan-500 focus:outline-none
                         focus:ring-1 focus:ring-cyan-500 transition-colors"
            />
          </div>

          <div>
            <label className="block text-xs font-mono text-gray-500 mb-2 uppercase tracking-widest">
              Custom alias <span className="text-gray-600">(optional)</span>
            </label>
            <div className="flex items-center gap-2">
              <span className="text-gray-600 text-sm font-mono">lnk.sph/</span>
              <input
                type="text"
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                placeholder="my-link"
                className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-4 py-3 text-sm
                           placeholder:text-gray-600 focus:border-cyan-500 focus:outline-none
                           focus:ring-1 focus:ring-cyan-500 transition-colors"
              />
            </div>
          </div>

          {error && (
            <div className="rounded-lg bg-red-950 border border-red-800 px-4 py-3 text-sm text-red-300">
              {error}
            </div>
          )}

          <button
            onClick={handleShorten}
            disabled={loading || !url}
            className="w-full rounded-lg bg-cyan-500 px-4 py-3 text-sm font-semibold text-gray-950
                       hover:bg-cyan-400 disabled:opacity-50 disabled:cursor-not-allowed
                       transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2
                       focus:ring-offset-gray-900"
          >
            {loading ? 'Shortening…' : 'Shorten URL →'}
          </button>
        </div>

        {/* Result */}
        {result && (
          <div className="rounded-xl border border-cyan-800 bg-cyan-950/30 p-5 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono text-cyan-500 uppercase tracking-widest">Your short link</span>
              {result.expiresAt && (
                <span className="text-xs text-gray-500">
                  Expires {new Date(result.expiresAt).toLocaleDateString()}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <a
                href={result.shortUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 font-mono text-lg text-cyan-300 hover:text-cyan-200 transition-colors truncate"
              >
                {result.shortUrl}
              </a>
              <button
                onClick={handleCopy}
                className="shrink-0 rounded-lg border border-cyan-700 px-4 py-2 text-xs text-cyan-400
                           hover:bg-cyan-900/50 transition-colors"
              >
                {copied ? '✓ Copied' : 'Copy'}
              </button>
            </div>
            <div className="text-xs text-gray-600 truncate font-mono">{result.originalUrl}</div>
            <a
              href={`/dashboard/${result.shortCode}`}
              className="inline-block text-xs text-gray-400 hover:text-gray-300 transition-colors"
            >
              View analytics →
            </a>
          </div>
        )}

        {/* Footer */}
        <p className="text-center text-xs text-gray-700 font-mono">
          Built with Next.js · AWS Lambda · Redis · DynamoDB · PostgreSQL
        </p>
      </div>
    </main>
  );
}
