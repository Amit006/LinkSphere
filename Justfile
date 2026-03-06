# Justfile — single-command tool for multi-environment deployments
# Reference: "Automated CI/CD pipelines using Just (command runner)"
#
# Usage:
#   just deploy-dev       → Deploy all services to dev
#   just deploy-prod      → Deploy all services to prod (prompts for confirmation)
#   just dev              → Start all services locally
#   just test             → Run full test suite
#   just migrate-dev      → Run DB migrations against dev DB

set dotenv-load

# ─── Development ──────────────────────────────────────────────────────────

# Start all services for local development
dev:
  npm run dev

# Run full test suite
test:
  npm run test

# Type-check all packages
typecheck:
  npm run typecheck

# ─── Database ────────────────────────────────────────────────────────────

# Run Prisma migrations against local DB
migrate:
  cd apps/api && DATABASE_URL=$LOCAL_DATABASE_URL npx prisma migrate dev

# Run Prisma migrations against dev DB
migrate-dev:
  cd apps/api && DATABASE_URL=$DEV_DATABASE_URL npx prisma migrate deploy

# Run Prisma migrations against prod DB (requires confirmation)
migrate-prod:
  @echo "⚠️  About to run migrations against PRODUCTION database."
  @read -p "Type 'yes' to continue: " confirm && [ "$$confirm" = "yes" ]
  cd apps/api && DATABASE_URL=$PROD_DATABASE_URL npx prisma migrate deploy

# ─── Deployments ─────────────────────────────────────────────────────────

# Deploy everything to dev in one command
deploy-dev: build
  @echo "🚀 Deploying to dev..."
  cd apps/api && npx serverless deploy --stage dev
  npx vercel --token=$VERCEL_TOKEN --env=preview
  @echo "✅ Dev deployment complete"

# Deploy everything to prod (requires confirmation)
deploy-prod: build
  @echo "🚀 About to deploy to PRODUCTION."
  @read -p "Type 'yes' to continue: " confirm && [ "$$confirm" = "yes" ]
  just migrate-prod
  cd apps/api && npx serverless deploy --stage prod
  npx vercel --token=$VERCEL_TOKEN --prod
  @echo "✅ Production deployment complete"

# ─── Build ───────────────────────────────────────────────────────────────

build:
  npm run build

# Remove all build artifacts
clean:
  find . -name "dist" -not -path "*/node_modules/*" | xargs rm -rf
  find . -name ".next" | xargs rm -rf
  find . -name ".turbo" | xargs rm -rf

# ─── Utilities ───────────────────────────────────────────────────────────

# List all deployed Lambda functions
list-functions:
  aws lambda list-functions --query 'Functions[?starts_with(FunctionName, `linksphere`)].FunctionName'

# Tail Lambda logs in real-time
logs function="redirect" stage="dev":
  aws logs tail /aws/lambda/linksphere-api-{{stage}}-{{function}} --follow

# Flush all Redis cache keys (use with caution)
flush-cache:
  @echo "⚠️  About to flush Redis cache."
  @read -p "Type 'yes' to continue: " confirm && [ "$$confirm" = "yes" ]
  redis-cli -u $REDIS_URL FLUSHALL
