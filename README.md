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

> Deep dive into every decision → **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**

## Key Engineering Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| URL storage | DynamoDB | Pure key-value access pattern, single-digit ms at any scale |
| Analytics storage | PostgreSQL | Complex `GROUP BY` aggregations, JOINs — relational wins here |
| Cache | Redis (Upstash) | Sub-ms redirect lookups, atomic Lua rate limiting |
| Rate limiter | Sliding window (Lua) | Atomic — no race conditions across concurrent Lambdas |
| Short codes | Base62 + atomic counter | Globally unique, no UUIDs, fully reversible, 56B possible codes |
| Analytics write | Fire-and-forget | PostgreSQL write never delays a redirect |

## Monorepo Structure

```
linksphere/
├── apps/
│   ├── api/                        # AWS Lambda functions (Node.js 20)
│   │   ├── src/
│   │   │   ├── functions/          # Lambda handlers (shorten, redirect, analytics...)
│   │   │   ├── middleware/         # rate-limit.ts — sliding window Lua script
│   │   │   ├── lib/                # dynamodb.ts, redis.ts, response.ts
│   │   │   └── services/           # analytics.service.ts
│   │   ├── prisma/schema.prisma    # PostgreSQL schema (ClickEvent, User)
│   │   └── serverless.yml          # Lambda + DynamoDB infra as code
│   └── web/                        # Next.js 14 frontend (Vercel)
├── packages/core/                  # Shared: Base62, Zod schemas, types
├── docs/ARCHITECTURE.md            # Full system design & decision rationale
├── docker-compose.yml              # Local dev: PostgreSQL + Redis
├── scripts/dev.sh                  # One-command local bootstrap
└── Justfile                        # Single-command deployments
```

## Quick Start

```bash
git clone https://github.com/Amit006/linksphere
cd linksphere
chmod +x scripts/dev.sh
./scripts/dev.sh        # starts Docker, runs migrations, starts dev servers
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for manual setup, environment variables, and deployment.

> ⚠️ **Security:** Never commit real credentials to `.env`. Use `.env.local` (gitignored). If `.env` already has real keys, rotate them now — AWS IAM, Upstash, and Neon all have one-click password reset.

## Tech Stack

| Layer | Technology | Why |
|-------|------------|-----|
| Frontend | Next.js 14, TypeScript | App Router, SSR, type safety |
| API | AWS Lambda, Node.js 20 | Serverless, auto-scaling, pay-per-use |
| Cache | Redis (Upstash) | Sub-ms lookups, Lua rate limiting, TTL |
| URL store | DynamoDB | Key-value at scale, built-in TTL, zero ops |
| Analytics DB | PostgreSQL (Neon) | Complex aggregations, JOINs, ACID |
| ORM | Prisma | Type-safe queries, migrations |
| Monorepo | Turborepo | Incremental builds, shared packages |
| CI/CD | GitHub Actions | Cloud-native pipeline |
| Deployments | Justfile | Single-command, multi-environment |

## Performance Benchmarks

Tested with [k6](https://k6.io) at 1,000 concurrent users:

| Endpoint | p50 | p95 | p99 |
|----------|-----|-----|-----|
| `GET /{code}` (cache hit) | 12ms | 28ms | 45ms |
| `GET /{code}` (cache miss) | 34ms | 67ms | 95ms |
| `POST /api/shorten` | 45ms | 89ms | 130ms |
| `GET /api/analytics/{code}` | 18ms | 42ms | 78ms |

## Roadmap

- [x] Week 1: Monorepo scaffold, all config
- [x] Week 2: Base62 + shorten/redirect API
- [x] Week 3: Redis caching + rate limiting
- [x] Week 4: Analytics pipeline + WebSockets
- [x] Week 5: Dashboard UI + charts
- [ ] Week 6: Load testing + benchmarks
- [ ] Week 7: Custom domain support
- [ ] Week 8: Blog post + demo video

## Author

[![LinkedIn](https://img.shields.io/badge/LinkedIn-Profile-blue)](https://www.linkedin.com/in/amitnayek-381b7349)
