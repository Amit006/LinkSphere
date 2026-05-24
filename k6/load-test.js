/**
 * LinkSphere — k6 Load Test
 *
 * Tests all three critical endpoints under realistic traffic patterns.
 * Run with: k6 run k6/load-test.js
 *
 * Targets (matching README benchmarks):
 *   GET /{code} p99 < 100ms (cache hit expected for hot URLs)
 *   POST /api/shorten p99 < 150ms
 *   GET /api/analytics/{code} p99 < 100ms
 *
 * Usage:
 *   k6 run k6/load-test.js                        # default: ramp to 100 VUs
 *   k6 run --env BASE_URL=https://your-domain.com k6/load-test.js
 *   k6 run --out json=results.json k6/load-test.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// ─── Config ────────────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || 'https://hu3oovyyz9.execute-api.eu-north-1.amazonaws.com/dev';

// A pre-shortened code to use for redirect benchmarks.
// Replace this with a real code after running the shorten test once.
const TEST_SHORT_CODE = __ENV.SHORT_CODE || 'abc123';

// ─── Custom Metrics ────────────────────────────────────────────────────────

const redirectErrors   = new Counter('redirect_errors');
const shortenErrors    = new Counter('shorten_errors');
const analyticsErrors  = new Counter('analytics_errors');

const redirectRate     = new Rate('redirect_success_rate');
const shortenRate      = new Rate('shorten_success_rate');

const redirectDuration = new Trend('redirect_duration', true);
const shortenDuration  = new Trend('shorten_duration', true);
const analyticsDuration = new Trend('analytics_duration', true);

// ─── Load Stages ───────────────────────────────────────────────────────────

export const options = {
  stages: [
    { duration: '30s', target: 50   },  // ramp up to 50 VUs
    { duration: '1m',  target: 200  },  // ramp to 200 VUs
    { duration: '2m',  target: 1000 },  // hold at 1000 VUs (peak load)
    { duration: '1m',  target: 200  },  // scale down
    { duration: '30s', target: 0    },  // ramp to zero
  ],

  thresholds: {
    // Redirect SLA: p99 < 100ms (Redis cache should serve most)
    redirect_duration: ['p(99)<100', 'p(95)<70', 'p(50)<20'],

    // Shorten SLA: p99 < 150ms
    shorten_duration: ['p(99)<150', 'p(95)<100'],

    // Analytics SLA: p99 < 100ms (Redis cache, 5min TTL)
    analytics_duration: ['p(99)<100'],

    // Error rates
    redirect_success_rate: ['rate>0.99'],   // < 1% errors
    shorten_success_rate:  ['rate>0.95'],   // < 5% errors (rate limiting kicks in)

    // Overall HTTP
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<200'],
  },
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function randomUrl() {
  const domains = ['example.com', 'github.com', 'google.com', 'news.ycombinator.com', 'dev.to'];
  const paths   = ['/article', '/repo', '/post', '/page', '/docs'];
  const domain  = domains[Math.floor(Math.random() * domains.length)];
  const path    = paths[Math.floor(Math.random() * paths.length)];
  const id      = Math.floor(Math.random() * 100000);
  return `https://${domain}${path}/${id}`;
}

// ─── Scenarios ─────────────────────────────────────────────────────────────

/**
 * Scenario A: Redirect (80% of traffic)
 * The hottest path — must be served from Redis cache.
 */
function testRedirect() {
  const start = Date.now();
  const res = http.get(`${BASE_URL}/${TEST_SHORT_CODE}`, {
    redirects: 0,  // Don't follow — we just want the Lambda response time
    tags: { name: 'redirect' },
  });
  redirectDuration.add(Date.now() - start);

  const success = check(res, {
    'redirect: status is 301 or 302': (r) => r.status === 301 || r.status === 302,
    'redirect: has Location header':   (r) => !!r.headers['Location'],
    'redirect: response time < 100ms': (r) => r.timings.duration < 100,
  });

  redirectRate.add(success);
  if (!success) redirectErrors.add(1);
}

/**
 * Scenario B: Shorten a new URL (15% of traffic)
 * Writes to DynamoDB + Redis. Will hit rate limits under load.
 */
function testShorten() {
  const payload = JSON.stringify({ url: randomUrl() });
  const params  = {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'shorten' },
  };

  const start = Date.now();
  const res   = http.post(`${BASE_URL}/api/shorten`, payload, params);
  shortenDuration.add(Date.now() - start);

  const success = check(res, {
    'shorten: status 200 or 429':      (r) => r.status === 200 || r.status === 429,
    'shorten: response time < 150ms':  (r) => r.timings.duration < 150,
    'shorten: valid JSON body':        (r) => {
      try { JSON.parse(r.body); return true; } catch { return false; }
    },
  });

  // 429 (rate limited) is not an error — it's expected behaviour under load
  const isError = res.status !== 200 && res.status !== 429;
  shortenRate.add(!isError);
  if (isError) shortenErrors.add(1);
}

/**
 * Scenario C: Analytics query (5% of traffic)
 * Served from Redis cache (5min TTL) for repeated queries.
 */
function testAnalytics() {
  const start = Date.now();
  const res   = http.get(`${BASE_URL}/api/analytics/${TEST_SHORT_CODE}`, {
    tags: { name: 'analytics' },
  });
  analyticsDuration.add(Date.now() - start);

  check(res, {
    'analytics: status 200':           (r) => r.status === 200,
    'analytics: has totalClicks':      (r) => {
      try { return JSON.parse(r.body).data?.totalClicks !== undefined; } catch { return false; }
    },
    'analytics: response time < 100ms': (r) => r.timings.duration < 100,
  });

  if (res.status !== 200) analyticsErrors.add(1);
}

// ─── Main VU loop ──────────────────────────────────────────────────────────

export default function () {
  const roll = Math.random();

  if (roll < 0.80) {
    testRedirect();
  } else if (roll < 0.95) {
    testShorten();
  } else {
    testAnalytics();
  }

  // Realistic think time between requests
  sleep(Math.random() * 0.5 + 0.1);  // 100–600ms
}

// ─── Summary ───────────────────────────────────────────────────────────────

export function handleSummary(data) {
  const redirectP50  = data.metrics.redirect_duration?.values?.['p(50)']?.toFixed(1)  ?? 'N/A';
  const redirectP95  = data.metrics.redirect_duration?.values?.['p(95)']?.toFixed(1)  ?? 'N/A';
  const redirectP99  = data.metrics.redirect_duration?.values?.['p(99)']?.toFixed(1)  ?? 'N/A';
  const shortenP99   = data.metrics.shorten_duration?.values?.['p(99)']?.toFixed(1)   ?? 'N/A';
  const analyticsP99 = data.metrics.analytics_duration?.values?.['p(99)']?.toFixed(1) ?? 'N/A';
  const totalReqs    = data.metrics.http_reqs?.values?.count ?? 0;
  const failRate     = ((data.metrics.http_req_failed?.values?.rate ?? 0) * 100).toFixed(2);

  const summary = `
╔══════════════════════════════════════════════════════════╗
║           LinkSphere Load Test Results                   ║
╠══════════════════════════════════════════════════════════╣
║  Redirect (GET /{code})                                  ║
║    p50: ${redirectP50.padEnd(8)}ms  p95: ${redirectP95.padEnd(8)}ms  p99: ${redirectP99.padEnd(8)}ms   ║
╠══════════════════════════════════════════════════════════╣
║  Shorten (POST /api/shorten)    p99: ${shortenP99.padEnd(8)}ms          ║
║  Analytics (GET /api/analytics) p99: ${analyticsP99.padEnd(8)}ms          ║
╠══════════════════════════════════════════════════════════╣
║  Total requests:  ${String(totalReqs).padEnd(8)}                           ║
║  Error rate:      ${failRate.padEnd(8)}%                         ║
╚══════════════════════════════════════════════════════════╝
`;

  console.log(summary);

  // Write results to file for README evidence
  return {
    'k6/results/latest.json': JSON.stringify(data, null, 2),
    stdout: summary,
  };
}
