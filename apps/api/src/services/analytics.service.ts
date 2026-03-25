import { PrismaClient } from '../generated/prisma';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import UAParser from 'ua-parser-js';
import { neon } from '@neondatabase/serverless';

// ─── Neon HTTP client for writes (fast, no TCP cold start) ───────────────────
// Uses HTTPS fetch instead of TCP — works instantly from any Lambda region
const sql = neon(process.env['DATABASE_URL']!);
console.log('[neon] DB URL prefix:', process.env['DATABASE_URL']?.substring(0, 40));
// ─── Prisma client for reads (complex aggregation queries) ───────────────────
let prisma: PrismaClient | null = null;

// Lazy load Prisma — only needed for analytics reads, not for click writes
function getPrisma() {
  const { PrismaClient } = require('../generated/prisma');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const pg = require('pg');
  
  const pool = new pg.Pool({
    connectionString: process.env['DATABASE_URL'],
    ssl: { rejectUnauthorized: false },
    max: 1,
  });
  const adapter = new PrismaPg(pool as any);
  return new PrismaClient({ adapter } as any);
}
// ─── Types ────────────────────────────────────────────────────────────────────

type DeviceType = 'DESKTOP' | 'MOBILE' | 'TABLET' | 'UNKNOWN';

interface ClickEventInput {
  id: string;
  shortCode: string;
  clickedAt: string;
  userAgent: string | null;
  ip: string | null;
  referer: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseUserAgent(ua: string | null): {
  browser: string | null;
  os: string | null;
  device: DeviceType;
} {
  if (!ua) return { browser: null, os: null, device: 'UNKNOWN' };

  const parser = new UAParser(ua);
  const result = parser.getResult();

  let device: DeviceType = 'DESKTOP';
  if (result.device.type === 'mobile') device = 'MOBILE';
  else if (result.device.type === 'tablet') device = 'TABLET';

  return {
    browser: result.browser.name ?? null,
    os: result.os.name ?? null,
    device,
  };
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen) : str;
}

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * Record a click event using Neon HTTP driver.
 * No TCP connection — works instantly from Lambda cold start.
 * Interview talking point: "I use Neon's serverless HTTP driver for writes
 * to avoid TCP connection overhead on Lambda cold starts."
 */
export async function recordClick(input: ClickEventInput): Promise<void> {
  console.log('[recordClick] START', Date.now());
  const { browser, os, device } = parseUserAgent(input.userAgent);

  await sql.query(
    `INSERT INTO click_events 
      (id, "shortCode", "clickedAt", browser, os, device, country, region, city, referer, "ipHash")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.id,
      input.shortCode,
      new Date(input.clickedAt).toISOString(),
      browser,
      os,
      device,
      input.country,
      input.region,
      input.city,
      input.referer ? truncate(input.referer, 500) : null,
      input.ip,
    ]
  );
  console.log('[recordClick] SUCCESS', Date.now());
}
/**
 * Get analytics summary for a short code.
 * Uses Prisma for complex aggregation queries.
 */
export async function getAnalyticsSummary(shortCode: string) {
  const db = getPrisma();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [totalClicks, recentClicks, topCountries, deviceBreakdown, topReferers] =
    await Promise.all([
      db.clickEvent.count({ where: { shortCode } }),

      db.clickEvent.findMany({
        where: { shortCode, clickedAt: { gte: thirtyDaysAgo } },
        select: { clickedAt: true, device: true, country: true, referer: true, ipHash: true },
        orderBy: { clickedAt: 'asc' },
      }),

      db.$queryRaw<Array<{ country: string; count: bigint }>>`
        SELECT country, COUNT(*) as count
        FROM click_events
        WHERE "shortCode" = ${shortCode} AND country IS NOT NULL
        GROUP BY country
        ORDER BY count DESC
        LIMIT 10
      `,

      db.$queryRaw<Array<{ device: string; count: bigint }>>`
        SELECT device, COUNT(*) as count
        FROM click_events
        WHERE "shortCode" = ${shortCode}
        GROUP BY device
      `,

      db.$queryRaw<Array<{ referer: string; count: bigint }>>`
        SELECT referer, COUNT(*) as count
        FROM click_events
        WHERE "shortCode" = ${shortCode} AND referer IS NOT NULL
        GROUP BY referer
        ORDER BY count DESC
        LIMIT 10
      `,
    ]);

  const clicksByDay: Record<string, number> = {};
  const uniqueIps = new Set<string>();

  for (const click of recentClicks) {
    const day = click.clickedAt.toISOString().split('T')[0]!;
    clicksByDay[day] = (clicksByDay[day] ?? 0) + 1;
    if (click.ipHash) uniqueIps.add(click.ipHash);
  }

  return {
    shortCode,
    totalClicks,
    uniqueClicks: uniqueIps.size,
    clicksByDay,
    topCountries: topCountries.map((r) => ({ country: r.country, count: Number(r.count) })),
    topReferers: topReferers.map((r) => ({ referer: r.referer, count: Number(r.count) })),
    deviceBreakdown: Object.fromEntries(
      deviceBreakdown.map((r) => [r.device.toLowerCase(), Number(r.count)])
    ),
  };
}
