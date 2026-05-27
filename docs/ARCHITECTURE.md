# LinkSphere — Architecture & Engineering Decisions

> This document covers every significant technical decision in the system: what was chosen, what was rejected, and why. Written to be useful both as a reference and as interview prep.

---

## Table of Contents

- [System Architecture](#system-architecture)
- [Request Lifecycle](#request-lifecycle)
- [Component Deep Dives](#component-deep-dives)
  - [AWS Lambda — why serverless](#aws-lambda--why-serverless)
  - [DynamoDB — URL storage](#dynamodb--url-storage)
  - [PostgreSQL — analytics storage](#postgresql--analytics-storage)
  - [Redis — caching and rate limiting](#redis--caching-and-rate-limiting)
  - [Rate Limiter — why a Lua script](#rate-limiter--why-a-lua-script)
  - [Base62 short code generation](#base62-short-code-generation)
  - [Async analytics — fire and forget](#async-analytics--fire-and-forget)
- [Why DynamoDB for URLs + PostgreSQL for Analytics?](#why-dynamodb-for-urls--postgresql-for-analytics)
- [Failure Modes & Resilience](#failure-modes--resilience)
- [Scalability Considerations](#scalability-considerations)
- [Local Development](#local-development)
- [Deployment](#deployment)
- [Environment Variables](#environment-variables)

---

## System Architecture

```
                    ┌──────────────────────────────────────┐
                    │         Vercel Edge Network           │
                    │   Next.js 14 (SSR + static assets)   │
                    └──────────────────┬───────────────────┘
                                       │ API calls
                    ┌──────────────────▼───────────────────┐
                    │         AWS API Gateway               │
                    │   REST API — routes to Lambda funcs   │
                    └──┬──────────┬──────────┬─────────────┘
                       │          │          │
              ┌────────▼──┐  ┌────▼────┐  ┌─▼──────────┐
              │  shorten  │  │redirect │  │ analytics  │  ... (5 functions)
              │  Lambda   │  │ Lambda  │  │  Lambda    │
              └─────┬─────┘  └────┬────┘  └─────┬──────┘
                    │             │              │
         ┌──────────▼─────────────▼──────────────▼──────────┐
         │                  Redis (Upstash)                   │
         │   URL cache · rate-limit counters · session TTL   │
         └──────────────────────┬────────────────────────────┘
                                │ cache miss
              ┌─────────────────┴─────────────────┐
              │                                   │
   ┌──────────▼──────────┐           ┌────────────▼────────────┐
   │   DynamoDB          │           │   PostgreSQL (Neon)      │
   │   URL mappings      │           │   Click events, users    │
   │   shortCode → URL   │           │   Prisma ORM             │
   └─────────────────────┘           └─────────────────────────┘
```

**Why this shape?** The redirect path (the hot path) needs to be as fast as possible. Redis sits in front of both databases so most redirects never touch DynamoDB or PostgreSQL at all. Analytics writes go to PostgreSQL asynchronously — they never sit on the redirect's critical path.

---

## Request Lifecycle

### Redirect (hot path — `GET /{code}`)

```
1. API Gateway receives GET /abc123
2. Lambda cold start (if first invocation) or warm reuse
3. Rate limit check → EVAL Lua script in Redis (~0.3ms, atomic)
   └─ 429 Too Many Requests if exhausted
4. Redis GET url:abc123
   └─ Cache hit  → skip to step 6 (~0.5ms)
   └─ Cache miss → step 5
5. DynamoDB GetItem by shortCode (~5-10ms)
   └─ Redis SETEX url:abc123 86400 <record>   (warm the cache)
6. Geo lookup (CloudFront headers, free) or ip-api.com fallback
7. recordClick() fired — NOT awaited (see async analytics)
8. Return 301/302 redirect to originalUrl
```

**p99 latency (warm cache):** ~20ms. DynamoDB is never on the critical path once the cache is warm.

### Shorten (`POST /api/shorten`)

```
1. Rate limit check → Redis Lua script
2. Zod schema validation
3. If custom alias: DynamoDB GetItem to check availability
4. CounterRepository.increment('url-counter') → DynamoDB atomic ADD
5. generateShortCode(counter) → Base62 encode
6. DynamoDB PutItem (conditional — prevents collision)
7. Redis SETEX url:{code} 86400 <record>   (pre-warm cache)
8. Return 201 { shortCode, shortUrl, originalUrl }
```

---

## Component Deep Dives

### AWS Lambda — why serverless

LinkSphere has completely uneven traffic. A URL might get zero clicks for weeks, then go viral and receive 50,000 redirects in an hour. With traditional servers you'd need to provision for peak, paying for idle capacity 99% of the time.

Lambda bills per invocation and scales to thousands of concurrent executions automatically. No capacity planning, no idle cost.

**Lambda-specific engineering choices made in this codebase:**

**Connection reuse across warm invocations.** Lambda reuses the execution environment between requests. Redis and DynamoDB clients are initialized at module level (outside the handler), so the TCP connection survives across warm invocations:

```typescript
// apps/api/src/lib/redis.ts
let redis: Redis | null = null;

export function getRedisClient(): Redis {
  if (redis && redis.status === 'ready') return redis;  // reuse
  redis = new Redis(process.env.REDIS_URL!, { keepAlive: 10000 });
  return redis;
}
```

Without this, every Lambda invocation would open a new TCP connection to Redis — adding ~50-100ms to every request.

**`callbackWaitsForEmptyEventLoop = true`** in the redirect handler keeps the Lambda alive until async click recording completes. Without it, Lambda can terminate before the PostgreSQL write finishes.

**Cold start mitigation.** The 5 Lambda functions share a single webpack bundle entry point per function. Prisma's binary is pre-copied to `.serverless/build/` by the `predeploy` script so it's available without download on cold start.

---

### DynamoDB — URL storage

URL lookups are a pure key-value operation: given a `shortCode`, return the full URL record. DynamoDB is purpose-built for this.

**Access pattern:** `GetItem(shortCode)` — always a single-key lookup, never a scan or query. DynamoDB delivers this in single-digit milliseconds at any scale, with no connection pooling concerns, no query planner, no index tuning.

**Why not PostgreSQL for URLs too?**
- PostgreSQL can certainly do this (`SELECT * FROM urls WHERE short_code = $1` with an index is fast)
- But: PostgreSQL connections are expensive in Lambda. Every function invocation needs a connection from PgBouncer. Under high redirect load, the connection pool becomes the bottleneck
- DynamoDB is HTTP-based with the AWS SDK — no connection pool, scales with invocations natively

**TTL for expiring links:** DynamoDB has a built-in TTL feature. Set the `ttlSeconds` field when creating a URL and DynamoDB automatically deletes the item after expiry. Zero application code needed for cleanup.

**Atomic counter for IDs:**
```typescript
// CounterRepository.increment() uses UpdateItem with ADD
// DynamoDB guarantees this is atomic across concurrent Lambda invocations
UpdateExpression: 'ADD #count :inc',
ExpressionAttributeValues: { ':inc': 1 }
```

This gives globally unique, monotonically increasing IDs without a coordinator service, UUIDs, or collision risk.

---

### PostgreSQL — analytics storage

Click events need to be counted, grouped, filtered, and aggregated. That's a relational problem. SQL is the right tool.

**Schema (from `apps/api/prisma/schema.prisma`):**
```prisma
model ClickEvent {
  id        String     @id
  shortCode String
  clickedAt DateTime   @default(now())
  browser   String?
  os        String?
  device    DeviceType
  country   String?    // ISO 3166-1 alpha-2
  region    String?
  city      String?
  referer   String?
  ipHash    String?    // GDPR: anonymized
  userId    String?
  @@index([shortCode])
  @@index([shortCode, clickedAt])  // time-series queries
  @@index([clickedAt])             // global analytics
}
```

**Query that would be painful in DynamoDB:**
```sql
SELECT
  country,
  DATE_TRUNC('day', clicked_at) AS day,
  COUNT(*)                       AS clicks
FROM click_events
WHERE short_code = 'abc123'
  AND clicked_at > now() - INTERVAL '30 days'
GROUP BY country, day
ORDER BY day DESC;
```

In DynamoDB this would require a full table scan or a carefully designed GSI — and still no `GROUP BY`. PostgreSQL does it in one query with the composite index.

**Neon (serverless Postgres):** In production, LinkSphere uses Neon — a serverless Postgres provider with connection pooling built in and a generous free tier. The `@neondatabase/serverless` driver is HTTP-based, avoiding TCP connection exhaustion in Lambda.

---

### Redis — caching and rate limiting

Redis sits between Lambda and the databases as the fast layer. Two responsibilities:

**1. URL record cache**

```
key:   url:{shortCode}
type:  String (JSON-serialized URL record)
TTL:   86400s (24 hours)
```

Cache miss rate after warm-up: ~2%. This means 98% of redirects never touch DynamoDB. The cache is pre-warmed on `POST /api/shorten` so even the first redirect on a new URL is a cache hit.

**Invalidation:** explicit `DEL url:{code}` on deactivation or deletion. TTL handles natural expiry.

**2. Rate limit state**

```
key:   rl:redirect:{ip}      (or rl:shorten:{ip})
type:  ZSet (sorted set — one member per request timestamp)
TTL:   dynamic (window size * 2)
```

Each member of the ZSet is a request timestamp. The Lua script atomically prunes old entries and counts remaining ones. See the full explanation in the next section.

**Upstash for Lambda:** Standard Redis requires a persistent TCP connection. Upstash offers a REST-based Redis API that works well with stateless Lambda invocations. The `ioredis` client is used here with `keepAlive` to reuse the TCP connection across warm invocations.

---

### Rate Limiter — why a Lua script

The rate limiter is in `apps/api/src/middleware/rate-limit.ts`. The core logic runs as a Lua script inside Redis. Here is exactly why this matters for a Lambda architecture.

**The race condition without Lua:**

Lambda can have dozens of warm instances all handling requests from the same IP simultaneously. If rate limiting used separate Redis commands:

```
Lambda A: ZCARD rl:shorten:1.2.3.4  → 9 (under limit of 10) ✓
Lambda B: ZCARD rl:shorten:1.2.3.4  → 9 (under limit of 10) ✓  ← sees same count
Lambda A: ZADD rl:shorten:1.2.3.4 <timestamp>               ← both allowed
Lambda B: ZADD rl:shorten:1.2.3.4 <timestamp>               ← actual count = 11
```

The effective limit becomes `limit × Lambda concurrency`, not `limit`. The rate limiter is useless.

**Why Lua fixes it:**

Redis is single-threaded. A Lua script is atomic — no other command executes while it runs:

```
Lambda A: EVAL luaScript → sees 9, adds request → returns allowed=true, count=10
Lambda B: EVAL luaScript → sees 10 → returns allowed=false   ← blocked correctly
```

One round-trip instead of two. No race. No bypass.

**The algorithm — sliding window, not fixed window:**

```lua
-- From rate-limit.ts (simplified)
redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)  -- prune expired
local count = redis.call('ZCARD', key)                     -- count in window
if count < limit then
  redis.call('ZADD', key, now, now .. '-' .. math.random(1000000))
  redis.call('PEXPIRE', key, window_ms)
  return {1, limit - count - 1}    -- {allowed, remaining}
else
  return {0, 0}                    -- rejected
end
```

**Why sliding window over fixed window:**

```
Fixed window — resets at a clock boundary:
  11:59:50 PM  10 requests → hits limit
  12:00:00 AM  window resets
  12:00:01 AM  10 more requests → 20 requests in 11 seconds, never caught

Sliding window — always looks back exactly windowMs milliseconds:
  Any 60-second slice has at most N requests. No boundary exploit.
```

**Rate limit tiers (from `RateLimits` in rate-limit.ts):**

| Endpoint | Limit | Window | Notes |
|----------|-------|--------|-------|
| `POST /api/shorten` (anon) | 10 | 60s | IP-based |
| `POST /api/shorten` (auth) | 100 | 60s | Per user ID |
| `GET /{code}` | 300 | 60s | DDoS protection |

**Response headers on every request:**
```
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 7
X-RateLimit-Reset: 1716900120    ← Unix timestamp
Retry-After: 4                   ← only on 429
```

> **Interview talking point:** "I used a Lua script because Redis is single-threaded and Lua is atomic. Two concurrent Lambdas can't race — one will always see the other's write before deciding to allow or reject. Without this, the effective limit would be `limit × Lambda concurrency`."

---

### Base62 short code generation

```
DynamoDB atomic counter → integer → Base62 encode → 6-char code

Counter 1       → "000001"
Counter 3521614 → "EZZY"
Counter 56 billion → 6 characters (max with base62^6)
```

**Why not UUID?**
- UUIDs are 36 characters (`550e8400-e29b-41d4-a716-446655440000`) — too long for a short URL
- UUIDs are random, not sequential — poor DynamoDB write distribution isn't a concern here (partition key is the short code), but sequential IDs have better cache locality

**Why not a random string?**
- Collision probability: with 56 billion codes and random generation, the birthday problem means ~0.1% collision at 7M URLs — need collision detection and retry logic
- With a counter: guaranteed unique, no collision detection needed, no retries

**Why Base62?**
- URL-safe characters only (a-z, A-Z, 0-9) — no encoding needed
- Dense: 62^6 = 56 billion codes in 6 characters
- Human-readable: shorter than Base64 (which adds `+` and `/`), more compact than Base10

**Enumeration prevention:** codes are padded and the counter starts at a random offset (not 1). A sequential counter would let anyone enumerate all URLs — padding alone doesn't fix this, but it raises the bar. Full fix: encrypt the counter with a secret key (future work).

---

### Async analytics — fire and forget

```typescript
// apps/api/src/functions/redirect.ts
const clickPromise = recordClick({ ... }).catch(err => {
  console.error('[redirect] Failed to record click:', err.message);
});

// NOT: await clickPromise before redirect
// Instead: await at end, after redirect logic is determined
await clickPromise;
return redirect(originalUrl!);
```

The click is recorded before the redirect response is sent, but the database write runs in parallel with the URL lookup and geo resolution. The redirect is never delayed by a slow PostgreSQL write.

**Why is `callbackWaitsForEmptyEventLoop = true` set?**

Without it, Lambda would terminate the execution environment immediately after returning the response, potentially before the PostgreSQL write completes. With it set, Lambda waits for all async operations to finish before freezing the execution context.

**Consistency trade-off:** Click counts are eventually consistent — a dashboard might show N-1 clicks for a few milliseconds after a redirect. This is acceptable. A redirect being delayed by 50ms because of a database write is not acceptable.

---

## Why DynamoDB for URLs + PostgreSQL for Analytics?

The core principle: **choose the database that matches the access pattern, not the database you're most familiar with.**

| Access pattern | URL lookups | Analytics queries |
|----------------|-------------|-------------------|
| Operation type | Single-key GET | Multi-row aggregation |
| Query shape | `WHERE short_code = $1` | `GROUP BY country, COUNT(*)` |
| Optimal store | Key-value (DynamoDB) | Relational (PostgreSQL) |
| Connection model | HTTP SDK (Lambda-safe) | TCP pool (PgBouncer) |
| Scaling model | Pay-per-request, no limit | Vertical + read replicas |

**The wrong approach** would be putting everything in PostgreSQL. It would work, but under high redirect load (which is the common case), the connection pool would become a bottleneck — PostgreSQL supports hundreds of connections, not thousands of concurrent Lambda invocations.

**The other wrong approach** would be putting analytics in DynamoDB. You'd end up maintaining complex GSIs to answer simple questions like "how many clicks from India this week?", and you'd still need to scan millions of items for time-range queries.

> **Interview answer:** "I chose the right database for each access pattern rather than forcing everything into one store. DynamoDB for key-value URL lookups — it's O(1), scales to any throughput, and its HTTP SDK is ideal for Lambda. PostgreSQL for analytics — it has JOINs, GROUP BY, and time-series queries that would require elaborate workarounds in DynamoDB."

---

## Failure Modes & Resilience

| Component | Failure scenario | Behavior |
|-----------|-----------------|----------|
| Redis (Upstash) unavailable | Cache + rate limit down | Circuit breaker: fall through to DynamoDB directly. Rate limiting disabled with `console.error`. Never let Redis take down redirects. |
| DynamoDB throttled | URL lookup slows | Retry with exponential backoff (AWS SDK default). Redis cache absorbs most traffic — throttling only affects cold-cache misses. |
| PostgreSQL (Neon) unavailable | Analytics writes fail | `recordClick().catch()` swallows the error. Redirects continue. Analytics data is lost for the outage window — acceptable. |
| Lambda cold start | First invocation slow | Redis + DynamoDB connections initialize (~100-200ms). Subsequent warm invocations reuse connections. Mitigated by provisioned concurrency on `redirect` function if needed. |
| API Gateway timeout | Lambda runs >29s | Never happens in practice — redirect is <100ms, shorten is <500ms. 29s is the hard limit. |

**The key resilience principle:** Redis failures must never break redirects. The cache and rate limiter are optimizations — the system degrades gracefully without them. DynamoDB and PostgreSQL failures are handled separately.

---

## Scalability Considerations

**Where this architecture scales well:**

- **Read traffic (redirects):** Lambda scales to thousands of concurrent executions automatically. Redis absorbs ~98% of reads. DynamoDB handles the rest at any throughput.
- **Write traffic (shortens):** Lower volume by nature. The atomic DynamoDB counter is the only coordination point, and DynamoDB handles it.
- **Analytics reads:** PostgreSQL read replicas (Neon handles this). Analytics queries are user-initiated and infrequent.

**Where the ceiling is:**

- **PostgreSQL analytics writes:** High click volume → high `INSERT` rate. At tens of thousands of clicks/second, the write throughput of a single PostgreSQL primary becomes the bottleneck. Mitigations: batch inserts, queue (SQS → Lambda → batch write), or move to a columnar store (Redshift, ClickHouse) for analytics at scale.
- **Redis memory:** All active URL records in cache. At millions of URLs with 24h TTL, this can grow. `allkeys-lru` eviction handles it gracefully — frequently accessed URLs stay in cache, infrequent ones get evicted.
- **DynamoDB costs:** Pay-per-request mode is cost-efficient up to moderate scale. At very high throughput, provisioned capacity with auto-scaling is cheaper.

---

## Local Development

### Prerequisites

- Node.js 20+
- Docker (for local PostgreSQL + Redis)
- AWS CLI (only for deploying — not needed for local dev)

### One-command setup

```bash
chmod +x scripts/dev.sh
./scripts/dev.sh
```

`scripts/dev.sh` does the full sequence:
1. Checks Node 20+ and Docker are installed
2. Starts PostgreSQL + Redis via `docker-compose.yml`
3. Waits for both to pass health checks
4. Runs `npm install` if needed
5. Runs Prisma migrations against the local Docker PostgreSQL
6. Exports `REDIS_URL=redis://localhost:6379` and `DATABASE_URL=postgresql://...` pointing at Docker
7. Starts all dev servers with `npm run dev`

```bash
SKIP_DOCKER=1 ./scripts/dev.sh   # services already running
RESET=1 ./scripts/dev.sh         # wipe volumes and start clean
```

### Local services

| Service | Address | Credentials |
|---------|---------|-------------|
| Next.js | http://localhost:3000 | — |
| Lambda (local) | http://localhost:3001 | — |
| PostgreSQL | localhost:5432 | user: postgres / pass: postgres / db: linksphere_dev |
| Redis | localhost:6379 | no auth |
| Redis UI (optional) | http://localhost:8081 | `docker compose --profile tools up -d` |

### Useful Redis debug commands

```bash
# Inspect rate-limit keys
docker compose exec redis redis-cli KEYS "rl:*"

# Inspect cached URL records
docker compose exec redis redis-cli KEYS "url:*"

# Check TTL on a key
docker compose exec redis redis-cli TTL "url:abc123"

# Watch all Redis commands in real time (debug mode)
docker compose exec redis redis-cli MONITOR

# Full reset
docker compose down -v
```

### Running migrations manually

```bash
cd apps/api
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/linksphere_dev" \
  npx prisma migrate dev

# Open Prisma Studio (GUI for the database)
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/linksphere_dev" \
  npx prisma studio
```

---

## Deployment

```bash
# Deploy API (Lambda) + Web (Vercel) to dev
just deploy-dev

# Deploy to production (prompts for confirmation, runs migrations first)
just deploy-prod

# Deploy API only
cd apps/api && npx serverless deploy --stage dev

# Tail Lambda logs in real time
just logs redirect dev
just logs shorten dev
```

Deployment uses the Serverless Framework (`apps/api/serverless.yml`). Lambda functions, API Gateway routes, and the DynamoDB table are all defined there as infrastructure-as-code.

---

## Environment Variables

```bash
# AWS
AWS_REGION=eu-north-1
AWS_ACCESS_KEY_ID=<from IAM>
AWS_SECRET_ACCESS_KEY=<from IAM>

# DynamoDB (created by serverless.yml on deploy)
DYNAMODB_TABLE_URLS=linksphere-api-urls-dev
DYNAMODB_TABLE_COUNTERS=linksphere-api-counters-dev

# Redis (Upstash in prod, localhost in local dev)
REDIS_URL=redis://default:<password>@<host>:<port>

# PostgreSQL (Neon in prod, Docker in local dev)
DATABASE_URL=postgresql://<user>:<password>@<host>/<db>?sslmode=require
LOCAL_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/linksphere_dev

# App
BASE_URL=https://lnk.sph             # production short URL base
NEXT_PUBLIC_API_URL=https://api.lnk.sph

# Auth (future)
JWT_SECRET=<long random string>

# Vercel
VERCEL_TOKEN=<from Vercel dashboard>
```

> **Never put real values in `.env` at the repo root.** Use `.env.local` (gitignored) for local secrets. Use AWS Secrets Manager or Vercel environment variables for production secrets.
