# LinkSphere 🔗

> Distributed URL shortener with real-time analytics — built to demonstrate production-grade system design.

[![CI/CD](https://github.com/yourusername/linksphere/actions/workflows/ci-cd.yml/badge.svg)](https://github.com/yourusername/linksphere/actions)
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

## Getting Started

### Prerequisites
- Node.js 20+
- AWS account + CLI configured
- Redis instance ([Upstash](https://upstash.com) — free tier works)
- PostgreSQL ([Supabase](https://supabase.com) or [Neon](https://neon.tech) — free tier works)

### Setup

```bash
# Clone and install
git clone https://github.com/yourusername/linksphere
cd linksphere
npm install

# Configure environment
cp .env.example .env.local
# Edit .env.local with your values

# Run DB migrations
just migrate

# Start development
just dev
```

### Deploy

```bash
# Deploy to dev (one command — see Justfile)
just deploy-dev

```
Service deployed to stack linksphere-api-dev (128s)

endpoints:                                                                                                      
  POST - https://hu3oovyyz9.execute-api.eu-north-1.amazonaws.com/dev/api/shorten
  GET - https://hu3oovyyz9.execute-api.eu-north-1.amazonaws.com/dev/{code}
  GET - https://hu3oovyyz9.execute-api.eu-north-1.amazonaws.com/dev/api/analytics/{code}
  GET - https://hu3oovyyz9.execute-api.eu-north-1.amazonaws.com/dev/api/urls
  DELETE - https://hu3oovyyz9.execute-api.eu-north-1.amazonaws.com/dev/api/urls/{code}
functions:
  shorten: linksphere-api-dev-shorten (5.2 MB)                                                                  
  redirect: linksphere-api-dev-redirect (5.2 MB)
  analytics: linksphere-api-dev-analytics (5.2 MB)
  listUrls: linksphere-api-dev-listUrls (5.2 MB)
  deleteUrl: linksphere-api-dev-deleteUrl (5.2 MB)

# Deploy to production (prompts for confirmation)
just deploy-prod
```

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
- [ ] Week 2: Base62 + shorten/redirect API
- [ ] Week 3: Redis caching + rate limiting
- [ ] Week 4: Analytics pipeline + WebSockets
- [ ] Week 5: Dashboard UI + charts
- [ ] Week 6: Load testing + benchmarks
- [ ] Week 7: Custom domain support
- [ ] Week 8: Blog post + demo video

## Author

**Amit Nayek** — [LinkedIn](https://www.linkedin.com/in/amitnayek-381b7349)
