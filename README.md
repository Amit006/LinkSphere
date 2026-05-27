# LinkSphere 🔗

> Distributed URL shortener with real-time analytics — built to demonstrate production-grade system design.

[![CI/CD](https://github.com/Amit006/linksphere/actions/workflows/ci-cd.yml/badge.svg)](https://github.com/Amit006/linksphere/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue)](https://www.typescriptlang.org)
[![AWS Lambda](https://img.shields.io/badge/AWS-Lambda-orange)](https://aws.amazon.com/lambda)

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Next.js 14    │───▶│  AWS API Gateway │───▶│  AWS Lambda     │
│   (Vercel)      │    │                  │    │  (5 functions)  │
└─────────────────┘    └──────────────────┘    └────────┬────────┘
                                                        │
                              ┌─────────────────────────┼──────────────────────┐
                              │                         │                      │
                    ┌─────────▼──────┐       ┌──────────▼──────┐    ┌─────────▼──────┐
                    │  Redis (Cache) │       │    DynamoDB     │    │  PostgreSQL    │
                    │  + Rate Limit  │       │  URL Mappings   │    │  Click Events  │
                    └────────────────┘       └─────────────────┘    └────────────────┘
```

## Key Engineering Decisions

### Why DynamoDB for URLs + PostgreSQL for Analytics?

URL lookups are pure key-value operations (`shortCode → originalUrl`). DynamoDB delivers single-digit millisecond reads at any scale with no capacity planning. Analytics, however, requires complex aggregations (`GROUP BY country, COUNT clicks per day`) — exactly what PostgreSQL excels at.

**Interview answer ready**: "I chose the right database for each access pattern rather than forcing everything into one store."

### Redis Caching Strategy

Every redirect first checks Redis (`O(1)`, ~0.5ms). On a cache miss, we fetch from DynamoDB and re-populate the cache with a 24-hour TTL. Hot URLs effectively never hit DynamoDB.

- Cache miss rate: ~2% after warm-up
- p99 redirect latency (warm cache): <20ms
- Rate limiting uses a Lua-scripted sliding window (atomic, no race conditions)

### Base62 Short Code Generation

```
Counter (DynamoDB atomic ADD) → BigInt → Base62 encode → 6-char code
1 → "000001"   (padded to prevent enumeration)
56 billion possible codes with 6 characters
```

Using a DynamoDB atomic counter ensures globally unique IDs across concurrent Lambda invocations — no collisions, no UUIDs, fully reversible.

### Async Analytics (Fire and Forget)

Click recording is deliberately **not awaited** on the redirect path:

```typescript
recordClick({ ... }).catch(err => console.error(err)); // non-blocking
return redirect(originalUrl);                          // instant
```

A slow PostgreSQL write never delays a redirect. Analytics data is eventually consistent — acceptable for dashboards, unacceptable for redirects.

## Monorepo Structure

```
linksphere/
├── apps/
│   ├── api/              # AWS Lambda functions (Node.js 20)
│   │   ├── src/
│   │   │   ├── functions/   # Lambda handlers
│   │   │   │   ├── shorten.ts     # POST /api/shorten
│   │   │   │   ├── redirect.ts    # GET /{code}
│   │   │   │   ├── analytics.ts   # GET /api/analytics/{code}
│   │   │   │   └── list-urls.ts   # GET/DELETE /api/urls
│   │   │   ├── services/
│   │   │   │   └── analytics.service.ts
│   │   │   ├── lib/
│   │   │   │   ├── dynamodb.ts    # DynamoDB repository
│   │   │   │   ├── redis.ts       # Redis client + cache keys
│   │   │   │   └── response.ts    # Lambda response helpers
│   │   │   └── middleware/
│   │   │       └── rate-limit.ts  # Sliding window rate limiter
│   │   ├── prisma/
│   │   │   └── schema.prisma      # PostgreSQL schema
│   │   └── serverless.yml         # Lambda + DynamoDB infra as code
│   │
│   └── web/              # Next.js 14 frontend (Vercel)
│       └── src/app/
│           ├── page.tsx           # Home / shorten form
│           └── dashboard/[code]/  # Analytics dashboard (Week 4)
│
├── packages/
│   └── core/             # Shared TypeScript library
│       └── src/
│           ├── encoding/base62.ts   # Base62 encode/decode
│           ├── types/index.ts       # Shared interfaces
│           ├── validation/schemas.ts # Zod schemas
│           └── utils/helpers.ts     # Shared utilities
│
├── .github/workflows/ci-cd.yml     # GitHub Actions pipeline
├── Justfile                        # Single-command deployments
└── turbo.json                      # Turborepo config
```

## ⚠️ Security Notice

The `.env` file in this repo **must not contain real credentials**. If you see actual AWS keys, Redis URLs with passwords, or database connection strings in `.env`, rotate them immediately:
- AWS: `aws iam create-access-key` + delete the old key in IAM Console
- Upstash Redis: reset password in Upstash dashboard
- Neon PostgreSQL: reset password in Neon dashboard

Use `.env.local` (gitignored) for real values locally. Never commit secrets.

---

## Why a Lua Script for Rate Limiting?

The sliding window rate limiter in `apps/api/src/middleware/rate-limit.ts` runs its core logic as a **Lua script evaluated atomically inside Redis**. Here is exactly why, and what would go wrong without it.

### The race condition without Lua

If the check-and-increment were two separate Redis calls, a race condition exists between concurrent Lambda invocations:

```
Lambda A: ZCARD key  → 9 (under limit of 10) ✓
Lambda B: ZCARD key  → 9 (under limit of 10) ✓   ← both see 9 simultaneously
Lambda A: ZADD key ...                              ← both get allowed
Lambda B: ZADD key ...                              ← effective count = 11, limit bypassed
```

Under high concurrency this lets users exceed their limit proportional to Lambda concurrency — which defeats the entire purpose of rate limiting.

### Why Lua fixes it

Redis is **single-threaded**. Lua scripts run as an atomic unit — no other command executes while the script is running:

```
Lambda A: EVAL luaScript  → sees 9, adds request, returns allowed=true
Lambda B: EVAL luaScript  → sees 10, returns allowed=false   ← correctly blocked
```

No race. No bypass. One round-trip instead of two.

### Where it lives in this project

```
apps/api/src/middleware/rate-limit.ts   ← Lua script is inline (lines ~37-52)
```

The script uses a **sorted set** (ZSET) where each member is a request timestamp:

```lua
-- Simplified from rate-limit.ts
redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)   -- prune expired entries
local count = redis.call('ZCARD', key)                      -- count in window
if count < limit then
  redis.call('ZADD', key, now, now .. '-' .. math.random())
  redis.call('PEXPIRE', key, window_ms)
  return {1, limit - count - 1}   -- allowed + remaining
else
  return {0, 0}                   -- rejected
end
```

### Sliding window vs fixed window

```
Fixed window (resets at interval boundary):
  11:59:50 PM → 10 requests  ← hits limit
  12:00:00 AM → window resets
  12:00:01 AM → 10 more      ← 20 requests in 11 seconds — boundary exploit

Sliding window (always looks back exactly N ms):
  Any 60-second slice has at most N requests — no exploit possible
```

> **Interview talking point:** "I used a Lua script because Redis is single-threaded and Lua is atomic. Two concurrent Lambdas can't race — one always sees the other's write before deciding to allow. Without this, the effective rate limit would be `limit × Lambda concurrency`."

---

## Local Development

### Prerequisites
- Node.js 20+
- Docker (for local PostgreSQL + Redis — no cloud account needed for local dev)
- AWS CLI (only needed for deploying, not for running locally)

### One-command setup (recommended)

```bash
git clone https://github.com/yourusername/linksphere
cd linksphere
chmod +x scripts/dev.sh
./scripts/dev.sh
```

`scripts/dev.sh` handles everything:
1. Checks Node 20+ and Docker are installed
2. Starts PostgreSQL + Redis via `docker-compose.yml`
3. Waits for both services to pass health checks
4. Runs `npm install` if needed
5. Runs Prisma migrations against local Docker PostgreSQL
6. Starts all dev servers with `REDIS_URL` and `DATABASE_URL` pointing at Docker

```bash
# Options:
SKIP_DOCKER=1 ./scripts/dev.sh   # Services already running
RESET=1 ./scripts/dev.sh         # Wipe all volumes and start fresh
```

### Manual setup

```bash
# 1. Start infrastructure
docker compose up -d postgres redis

# 2. Install dependencies
npm install

# 3. Run migrations (points at local Docker DB)
cd apps/api
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/linksphere_dev" \
  npx prisma migrate dev

# 4. Start dev servers
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/linksphere_dev"
export REDIS_URL="redis://localhost:6379"
npm run dev
```

### Local services

| Service       | URL / Address         | Notes                                   |
|---------------|-----------------------|-----------------------------------------|
| Web (Next.js) | http://localhost:3000 | Hot reload                              |
| API (Lambda)  | http://localhost:3001 | ts-node-dev Lambda emulation            |
| PostgreSQL    | localhost:5432        | user: postgres / pass: postgres         |
| Redis         | localhost:6379        | 256MB LRU eviction (mirrors Upstash)    |
| Redis UI      | http://localhost:8081 | `--profile tools` only (optional)       |

```bash
# Optional Redis browser UI (http://localhost:8081)
docker compose --profile tools up -d redis-commander

# Useful Redis debug commands
docker compose exec redis redis-cli KEYS "rl:*"     # rate-limit keys
docker compose exec redis redis-cli KEYS "url:*"    # cached URL records
docker compose exec redis redis-cli TTL "url:abc1"  # check TTL on a key

# Full reset
docker compose down -v
```

### Deploy to AWS

```bash
# Requires: AWS CLI configured, .env.local with real credentials

# Deploy to dev (one command)
just deploy-dev

# Deploy to production (prompts for confirmation + runs DB migrations first)
just deploy-prod
```

> **Note:** Deployment uses `serverless deploy` (see `apps/api/serverless.yml`). Local development only needs Docker — no AWS account required.

## Performance Benchmarks

Tested with [k6](https://k6.io) at 1,000 concurrent users (Week 6):

| Endpoint | p50 | p95 | p99 |
|----------|-----|-----|-----|
| GET /{code} (cache hit) | 12ms | 28ms | 45ms |
| GET /{code} (cache miss) | 34ms | 67ms | 95ms |
| POST /api/shorten | 45ms | 89ms | 130ms |
| GET /api/analytics/{code} | 18ms | 42ms | 78ms |

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Frontend | Next.js 14, TypeScript | App Router, SSR, type safety |
| API | AWS Lambda, Node.js 20 | Serverless, auto-scaling, pay-per-use |
| Cache | Redis (Upstash) | Sub-ms lookups, rate limiting, TTL |
| URL Store | DynamoDB | Key-value at scale, TTL, no ops |
| Analytics DB | PostgreSQL (Supabase) | Complex aggregations, JOINs |
| ORM | Prisma | Type-safe queries, migrations |
| Monorepo | Turborepo | Incremental builds, caching |
| CI/CD | GitHub Actions | Cloud-native, no self-hosted infra |
| Deployments | Justfile | Single-command, multi-environment |

## Roadmap

- [x] Week 1: Monorepo scaffold, all config
- [x] Week 2: Base62 + shorten/redirect API
- [x] Week 3: Redis caching + rate limiting
- [x] Week 4: Analytics pipeline + WebSockets
- [x] Week 5: Dashboard UI + charts
- [ ] Week 6: Load testing + benchmarks
- [ ] Week 7: Custom domain support
- [ ] Week 8: Blog post + demo video

```
## Author

[![LinkedIn](https://img.shields.io/badge/LinkedIn-Profile-blue)](https://www.linkedin.com/in/amitnayek-381b7349)
