#!/usr/bin/env bash
# scripts/dev.sh — LinkSphere local development bootstrap
#
# What this does:
#   1. Checks prerequisites (Docker, Node, npm)
#   2. Creates .env.local from .env.example if it doesn't exist
#   3. Starts Docker services (PostgreSQL + Redis)
#   4. Waits for services to be healthy
#   5. Installs npm dependencies (if needed)
#   6. Runs Prisma migrations against local DB
#   7. Starts all dev servers (Next.js + Lambda local)
#
# Usage:
#   chmod +x scripts/dev.sh
#   ./scripts/dev.sh
#
#   Skip docker start (if already running):
#   SKIP_DOCKER=1 ./scripts/dev.sh
#
#   Reset everything (wipe Docker volumes):
#   RESET=1 ./scripts/dev.sh

set -euo pipefail

# ── Colours ────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { echo -e "${BLUE}[linksphere]${RESET} $*"; }
success() { echo -e "${GREEN}[linksphere]${RESET} ✅ $*"; }
warn()    { echo -e "${YELLOW}[linksphere]${RESET} ⚠️  $*"; }
error()   { echo -e "${RED}[linksphere]${RESET} ❌ $*" >&2; exit 1; }

# ── Banner ─────────────────────────────────────────────────────────────────
echo -e "${BOLD}"
echo "  ██╗     ██╗███╗   ██╗██╗  ██╗███████╗██████╗ ██╗  ██╗███████╗██████╗  ███████╗"
echo "  ██║     ██║████╗  ██║██║ ██╔╝██╔════╝██╔══██╗██║  ██║██╔════╝██╔══██╗ ██╔════╝"
echo "  ██║     ██║██╔██╗ ██║█████╔╝ ███████╗██████╔╝███████║█████╗  ██████╔╝ █████╗  "
echo "  ██║     ██║██║╚██╗██║██╔═██╗ ╚════██║██╔═══╝ ██╔══██║██╔══╝  ██╔══██╗ ██╔══╝  "
echo "  ███████╗██║██║ ╚████║██║  ██╗███████║██║     ██║  ██║███████╗██║  ██║ ███████╗"
echo "  ╚══════╝╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝ ╚══════╝"
echo -e "  Local Development Bootstrap${RESET}"
echo ""

# ── Step 1: Prerequisites ──────────────────────────────────────────────────
info "Checking prerequisites..."

command -v docker  >/dev/null 2>&1 || error "Docker not found. Install from https://docker.com"
command -v node    >/dev/null 2>&1 || error "Node.js not found. Install from https://nodejs.org (v20+)"
command -v npm     >/dev/null 2>&1 || error "npm not found. Comes with Node.js."

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  error "Node.js 20+ required. Found v$(node -v). Use nvm: nvm install 20"
fi

success "Prerequisites OK (Node $(node -v), Docker $(docker --version | cut -d' ' -f3 | tr -d ','))"

# ── Step 2: Environment file ───────────────────────────────────────────────
if [ ! -f ".env.local" ]; then
  if [ -f ".env.example" ]; then
    info "Creating .env.local from .env.example..."
    cp .env.example .env.local
    warn "Edit .env.local with your values before continuing."
    warn "Specifically: REDIS_URL, DATABASE_URL, AWS_* credentials"
  else
    warn ".env.local not found and no .env.example to copy from."
    warn "Make sure your environment variables are set."
  fi
else
  success ".env.local exists"
fi

# ── Step 3: Docker services ────────────────────────────────────────────────
if [ "${SKIP_DOCKER:-0}" = "1" ]; then
  warn "SKIP_DOCKER=1 — skipping Docker startup"
else
  if [ "${RESET:-0}" = "1" ]; then
    warn "RESET=1 — tearing down Docker volumes (all local data will be lost)..."
    docker compose down -v --remove-orphans 2>/dev/null || true
  fi

  info "Starting Docker services (postgres + redis)..."
  docker compose up -d postgres redis

  # ── Wait for PostgreSQL ────────────────────────────────────────────────
  info "Waiting for PostgreSQL to be ready..."
  RETRIES=30
  until docker compose exec -T postgres pg_isready -U postgres -d linksphere_dev >/dev/null 2>&1; do
    RETRIES=$((RETRIES - 1))
    if [ "$RETRIES" -le 0 ]; then
      error "PostgreSQL did not become ready in time. Run: docker compose logs postgres"
    fi
    sleep 1
    echo -n "."
  done
  echo ""
  success "PostgreSQL is ready"

  # ── Wait for Redis ─────────────────────────────────────────────────────
  info "Waiting for Redis to be ready..."
  RETRIES=15
  until docker compose exec -T redis redis-cli ping >/dev/null 2>&1; do
    RETRIES=$((RETRIES - 1))
    if [ "$RETRIES" -le 0 ]; then
      error "Redis did not become ready in time. Run: docker compose logs redis"
    fi
    sleep 1
    echo -n "."
  done
  echo ""
  success "Redis is ready"
fi

# ── Step 4: Install dependencies ──────────────────────────────────────────
if [ ! -d "node_modules" ]; then
  info "Installing npm dependencies (first run, this takes a moment)..."
  npm install
  success "Dependencies installed"
else
  success "node_modules exists — skipping npm install"
fi

# ── Step 5: Prisma migrations ──────────────────────────────────────────────
info "Running Prisma migrations against local PostgreSQL..."
(
  cd apps/api
  LOCAL_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/linksphere_dev" \
    DATABASE_URL="postgresql://postgres:postgres@localhost:5432/linksphere_dev" \
    npx prisma migrate dev --name "local-dev" 2>/dev/null || \
  LOCAL_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/linksphere_dev" \
    DATABASE_URL="postgresql://postgres:postgres@localhost:5432/linksphere_dev" \
    npx prisma migrate deploy
)
success "Database schema is up to date"

# ── Step 6: Summary ────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}All services ready. Starting dev servers...${RESET}"
echo ""
echo -e "  ${BLUE}PostgreSQL${RESET}  → localhost:5432  (user: postgres / pass: postgres)"
echo -e "  ${BLUE}Redis${RESET}       → localhost:6379"
echo -e "  ${BLUE}Redis UI${RESET}    → http://localhost:8081  (run with --profile tools)"
echo -e "  ${BLUE}API (local)${RESET} → http://localhost:3001  (Lambda emulation)"
echo -e "  ${BLUE}Web${RESET}         → http://localhost:3000"
echo ""
echo -e "  Stop everything:  ${YELLOW}Ctrl+C${RESET}  then  ${YELLOW}docker compose down${RESET}"
echo ""

# ── Step 7: Start dev servers ──────────────────────────────────────────────
# Set local DB/Redis URLs so dev servers use Docker, not cloud services
export REDIS_URL="redis://localhost:6379"
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/linksphere_dev"
export LOCAL_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/linksphere_dev"

npm run dev
