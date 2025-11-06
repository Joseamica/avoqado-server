#!/bin/bash

# 🚀 Pre-Deploy Check Script
# Simula el pipeline de CI/CD localmente antes de hacer push

set -e  # Exit on any error

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

echo "🚀 ============================================="
echo "🚀 PRE-DEPLOY VERIFICATION (CI/CD Simulation)"
echo "🚀 ============================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 1. ESLint
echo "📏 Step 1/7: Running ESLint..."
if npm run lint; then
  echo -e "${GREEN}✅ ESLint passed!${NC}"
else
  echo -e "${RED}❌ ESLint failed!${NC}"
  exit 1
fi
echo ""

# 2. TypeScript compilation check
echo "🔍 Step 2/7: TypeScript compilation check..."
if npx tsc --noEmit; then
  echo -e "${GREEN}✅ TypeScript compilation check passed!${NC}"
else
  echo -e "${RED}❌ TypeScript compilation failed!${NC}"
  exit 1
fi
echo ""

# 3. Generate Prisma Client
echo "🗄️ Step 3/7: Generating Prisma Client..."
if npx prisma generate; then
  echo -e "${GREEN}✅ Prisma Client generated!${NC}"
else
  echo -e "${RED}❌ Prisma generation failed!${NC}"
  exit 1
fi
echo ""

# 4. Build application
echo "🏗️ Step 4/7: Building application..."
if npm run build; then
  echo -e "${GREEN}✅ Build successful!${NC}"
else
  echo -e "${RED}❌ Build failed!${NC}"
  exit 1
fi
echo ""

# 5. Run unit tests
echo "🧪 Step 5/7: Running unit tests..."
if npm run test:unit; then
  echo -e "${GREEN}✅ Unit tests passed!${NC}"
else
  echo -e "${RED}❌ Unit tests failed!${NC}"
  exit 1
fi
echo ""

# 6. Run integration tests (optional, requires DATABASE_URL or TEST_DATABASE_URL)
echo "🏪 Step 6/7: Running integration tests..."
# Use TEST_DATABASE_URL if DATABASE_URL is not set
if [ -z "$DATABASE_URL" ] && [ -n "$TEST_DATABASE_URL" ]; then
  export DATABASE_URL="$TEST_DATABASE_URL"
fi

if [ -z "$DATABASE_URL" ]; then
  echo -e "${YELLOW}⚠️ Integration tests skipped - DATABASE_URL not set${NC}"
  echo -e "${YELLOW}💡 Set DATABASE_URL or TEST_DATABASE_URL in .env to run integration tests${NC}"
else
  echo -e "Using database: ${DATABASE_URL%%@*}@***" # Hide credentials in output
  if npm run test:integration; then
    echo -e "${GREEN}✅ Integration tests passed!${NC}"
  else
    echo -e "${RED}❌ Integration tests failed!${NC}"
    exit 1
  fi
fi
echo ""

# 7. Check for uncommitted changes
echo "📝 Step 7/7: Checking git status..."
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
