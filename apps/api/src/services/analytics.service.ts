import { PrismaClient } from '@prisma/client';
import UAParser from 'ua-parser-js';
import type { DeviceType } from '@prisma/client';

/**
 * Prisma client singleton — reused across warm Lambda invocations.
 */
let prisma: PrismaClient | null = null;

function getPrisma(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient({
      log: process.env['NODE_ENV'] === 'development' ? ['query', 'error'] : ['error'],
    });
  }
  return prisma;
}

// ─── Types ────────────────────────────────────────────────────────────────

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

// ─── Service functions ─────────────────────────────────────────────────────

/**
 * Parse User-Agent string into structured device info.
 */
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
  else if (!result.device.type) device = 'DESKTOP';

  return {
    browser: result.browser.name ?? null,
    os: result.os.name ?? null,
    device,
  };
}

/**
 * Record a click event in PostgreSQL.
 * Called asynchronously from the redirect handler — never blocks the redirect.
 */
export async function recordClick(input: ClickEventInput): Promise<void> {
  const db = getPrisma();
  const { browser, os, device } = parseUserAgent(input.userAgent);

  await db.clickEvent.create({
    data: {
      id: input.id,
      shortCode: input.shortCode,
      clickedAt: new Date(input.clickedAt),
      browser,
      os,
      device,
      country: input.country,
      region: input.region,
      city: input.city,
      referer: input.referer ? truncate(input.referer, 500) : null,
      ipHash: input.ip,
    },
  });
}

/**
 * Get analytics summary for a short code.
 * Aggregates click data from PostgreSQL.
 */
export async function getAnalyticsSummary(shortCode: string) {
  const db = getPrisma();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [totalClicks, recentClicks, topCountries, deviceBreakdown, topReferers] =
    await Promise.all([
      // Total all-time clicks
      db.clickEvent.count({ where: { shortCode } }),

      // Clicks per day for last 30 days
      db.clickEvent.findMany({
        where: { shortCode, clickedAt: { gte: thirtyDaysAgo } },
        select: { clickedAt: true, device: true, country: true, referer: true, ipHash: true },
        orderBy: { clickedAt: 'asc' },
      }),

      // Top countries
      db.$queryRaw<Array<{ country: string; count: bigint }>>`
        SELECT country, COUNT(*) as count
        FROM click_events
        WHERE short_code = ${shortCode} AND country IS NOT NULL
        GROUP BY country
        ORDER BY count DESC
        LIMIT 10
      `,

      // Device breakdown
      db.$queryRaw<Array<{ device: string; count: bigint }>>`
        SELECT device, COUNT(*) as count
        FROM click_events
        WHERE short_code = ${shortCode}
        GROUP BY device
      `,

      // Top referers
      db.$queryRaw<Array<{ referer: string; count: bigint }>>`
        SELECT referer, COUNT(*) as count
        FROM click_events
        WHERE short_code = ${shortCode} AND referer IS NOT NULL
        GROUP BY referer
        ORDER BY count DESC
        LIMIT 10
      `,
    ]);

  // Group clicks by day
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

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen) : str;
}
