#!/bin/bash

# 🚀 Pre-Deploy Check Script
# Simula el pipeline de CI/CD localmente antes de hacer push

set -e  # Exit on any error

DATABASE_URL_WAS_PRESENT="${DATABASE_URL+x}"
DATABASE_URL_WAS_SET="${DATABASE_URL-}"
TEST_DATABASE_URL_WAS_PRESENT="${TEST_DATABASE_URL+x}"
TEST_DATABASE_URL_WAS_SET="${TEST_DATABASE_URL-}"

# Load environment variables from .env file if it exists
if [ -f .env ]; then
  echo "📦 Loading environment variables from .env..."
  # Load .env safely without executing any commands (prevents issues with special chars)
  while IFS='=' read -r key value; do
    # Skip comments and empty lines
    [[ $key =~ ^#.*$ || -z $key ]] && continue
    # Remove leading/trailing whitespace and quotes
    value=$(echo "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")
    # Export the variable
    export "$key=$value"
  done < .env
  echo "✅ Environment variables loaded"
  echo ""
fi

# Integration projects are destructive test boundaries. Only a non-empty
# TEST_DATABASE_URL exported by the caller before dotenv loading may enable
# them. dotenv remains available for non-database test secrets.
EXPLICIT_TEST_DATABASE_READY=0
if [ "$TEST_DATABASE_URL_WAS_PRESENT" = "x" ] && [ -n "$TEST_DATABASE_URL_WAS_SET" ]; then
  export TEST_DATABASE_URL="$TEST_DATABASE_URL_WAS_SET"
  export DATABASE_URL="$TEST_DATABASE_URL_WAS_SET"
  EXPLICIT_TEST_DATABASE_READY=1
else
  unset TEST_DATABASE_URL
  if [ "$DATABASE_URL_WAS_PRESENT" = "x" ]; then
    export DATABASE_URL="$DATABASE_URL_WAS_SET"
  fi
fi

echo "🚀 ============================================="
echo "🚀 PRE-DEPLOY VERIFICATION (CI/CD Simulation)"
echo "🚀 ============================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 1. ESLint (auto-fix first, then check)
echo "📏 Step 1/10: Running ESLint..."
echo "   Auto-fixing issues..."
npm run lint:fix 2>/dev/null || true
echo "   Checking for remaining issues..."
if npm run lint; then
  echo -e "${GREEN}✅ ESLint passed!${NC}"
else
  echo -e "${RED}❌ ESLint failed!${NC}"
  exit 1
fi
echo ""

# 2. TypeScript compilation check
echo "🔍 Step 2/10: TypeScript compilation check..."
if npm run typecheck; then
  echo -e "${GREEN}✅ TypeScript compilation check passed!${NC}"
else
  echo -e "${RED}❌ TypeScript compilation failed!${NC}"
  exit 1
fi
echo ""

# 3. Generate Prisma Client
echo "🗄️ Step 3/10: Generating Prisma Client..."
if npx prisma generate; then
  echo -e "${GREEN}✅ Prisma Client generated!${NC}"
else
  echo -e "${RED}❌ Prisma generation failed!${NC}"
  exit 1
fi
echo ""

# 4. Pre-migration safety check
echo "🔍 Step 4/10: Pre-migration safety check..."
if npx ts-node -r tsconfig-paths/register scripts/pre-migration-check.ts; then
  echo -e "${GREEN}✅ Pre-migration check passed!${NC}"
else
  echo -e "${RED}❌ Pre-migration check failed! Fix issues before deploying.${NC}"
  exit 1
fi
echo ""

# 5. Build application
echo "🏗️ Step 5/10: Building application..."
if npm run build; then
  echo -e "${GREEN}✅ Build successful!${NC}"
else
  echo -e "${RED}❌ Build failed!${NC}"
  exit 1
fi
echo ""

# 6. Run unit tests
echo "🧪 Step 6/10: Running unit tests..."
if npm run test:unit; then
  echo -e "${GREEN}✅ Unit tests passed!${NC}"
else
  echo -e "${RED}❌ Unit tests failed!${NC}"
  exit 1
fi
echo ""

# 6b. Run API middleware tests (mock-based — no real DB required; setup.ts
# forces a dummy DATABASE_URL). This suite guards route mounting + auth +
# checkPermission + Zod on every endpoint; it rotted for 7 months when it
# wasn't wired into any gate (2025-11 → 2026-07, 76 stale failures).
echo "🌐 Step 6b/10: Running API middleware tests..."
if npm run test:api; then
  echo -e "${GREEN}✅ API tests passed!${NC}"
else
  echo -e "${RED}❌ API tests failed!${NC}"
  exit 1
fi
echo ""

# 7. Run integration tests (optional, requires an explicitly exported TEST_DATABASE_URL)
echo "🏪 Step 7/10: Running integration tests..."
if [ "$EXPLICIT_TEST_DATABASE_READY" -ne 1 ]; then
  echo -e "${YELLOW}⚠️ Integration tests skipped - exported TEST_DATABASE_URL is required${NC}"
else
  export TEST_DATABASE_URL="$TEST_DATABASE_URL_WAS_SET"
  export DATABASE_URL="$TEST_DATABASE_URL_WAS_SET"
  echo "test DB configurada"
  if npm run test:integration; then
    echo -e "${GREEN}✅ Integration tests passed!${NC}"
  else
    echo -e "${RED}❌ Integration tests failed!${NC}"
    exit 1
  fi
fi
echo ""

# 8. Assistant quality gate
echo "🤖 Step 8/10: Running assistant quality gate..."
if npm run assistant:audit; then
  echo -e "${GREEN}✅ Assistant coverage audit passed!${NC}"
else
  echo -e "${RED}❌ Assistant coverage audit failed!${NC}"
  exit 1
fi

if npm run assistant:regression; then
  echo -e "${GREEN}✅ Assistant regression tests passed!${NC}"
else
  echo -e "${RED}❌ Assistant regression tests failed!${NC}"
  exit 1
fi

if [ "$EXPLICIT_TEST_DATABASE_READY" -ne 1 ]; then
  echo -e "${YELLOW}⚠️ Assistant consistency skipped - exported TEST_DATABASE_URL is required${NC}"
else
  export TEST_DATABASE_URL="$TEST_DATABASE_URL_WAS_SET"
  export DATABASE_URL="$TEST_DATABASE_URL_WAS_SET"
  if npm run assistant:consistency; then
    echo -e "${GREEN}✅ Assistant DB consistency tests passed!${NC}"
  else
    echo -e "${RED}❌ Assistant DB consistency tests failed!${NC}"
    exit 1
  fi
fi
echo ""

# 9. Cross-repo compatibility check
echo "🔗 Step 9/10: Cross-repo compatibility check..."
TPV_PATH="../avoqado-tpv"

if [ -d "$TPV_PATH" ]; then
  echo -e "${YELLOW}⚠️ RECORDATORIO: TPV Android tarda 3-5 días en actualizarse (firma PAX)${NC}"
  echo ""
  echo "   Verifica antes de deploy:"
  echo "   • ¿Estás quitando campos de respuestas API existentes? → NO HACERLO"
  echo "   • ¿Estás agregando campos REQUERIDOS en requests? → Hacerlos opcionales"
  echo "   • ¿El TPV necesita esta versión del backend? → Coordinar tiempos"
  echo ""

  # Show TPV version for context
  TPV_VERSION=$(grep "versionName" "$TPV_PATH/app/build.gradle.kts" 2>/dev/null | head -1 | sed 's/.*"\(.*\)".*/\1/')
  if [ -n "$TPV_VERSION" ]; then
    echo "   TPV actual en producción: v$TPV_VERSION (aprox.)"
  fi
  echo ""
else
  echo "   (avoqado-tpv no encontrado en $TPV_PATH - skipping)"
fi
echo -e "${GREEN}✅ Cross-repo check complete${NC}"
echo ""

# 10. Check for uncommitted changes
echo "📝 Step 10/10: Checking git status..."
if [[ -n $(git status -s) ]]; then
  echo -e "${YELLOW}⚠️ You have uncommitted changes:${NC}"
  git status -s
  echo ""
  echo -e "${YELLOW}💡 Consider committing these changes before deploying${NC}"
else
  echo -e "${GREEN}✅ No uncommitted changes${NC}"
fi
echo ""

# Final summary
echo "🎉 ============================================="
echo "🎉 ALL CHECKS PASSED! READY FOR DEPLOY 🚀"
echo "🎉 ============================================="
echo ""
echo "Next steps:"
echo "  1. Commit your changes: git add . && git commit -m 'your message'"
echo "  2. Push to develop: git push origin develop (triggers staging deploy)"
echo "  3. Push to main: git push origin main (triggers production deploy)"
echo ""
