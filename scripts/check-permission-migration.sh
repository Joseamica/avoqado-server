#!/usr/bin/env bash
# scripts/check-permission-migration.sh
# Permission Centralization Checker
# Verifies that permissions are fully centralized in the backend

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(dirname "$SCRIPT_DIR")"
DASHBOARD_DIR="$SERVER_DIR/../avoqado-web-dashboard"

echo "=============================================="
echo "  Permission Centralization Checker"
echo "=============================================="
echo ""

# Helper to count files
count_files() {
  local result="$1"
  if [[ -z "$result" ]]; then
    echo "0"
  else
    echo "$result" | wc -l | tr -d ' '
  fi
}

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

ISSUES=0

echo "=============================================="
echo "  BACKEND (Single Source of Truth)"
echo "=============================================="
echo ""

# Check 1: PERMISSION_TO_FEATURE_MAP in backend
echo -e "${BLUE}[CHECK] PERMISSION_TO_FEATURE_MAP in backend:${NC}"
if grep -q "PERMISSION_TO_FEATURE_MAP" "$SERVER_DIR/src/services/access/access.service.ts" 2>/dev/null; then
  echo -e "  ${GREEN}[OK]${NC} Found in access.service.ts"
else
  echo -e "  ${RED}[!!]${NC} NOT FOUND - backend should have the mapping"
  ((ISSUES++))
fi

# Check 2: access.service.ts filters permissions
echo -e "${BLUE}[CHECK] Backend filters permissions for white-label:${NC}"
if grep -q "finalPermissions = resolvedPermissions.filter" "$SERVER_DIR/src/services/access/access.service.ts" 2>/dev/null; then
  echo -e "  ${GREEN}[OK]${NC} Permission filtering logic found"
else
  echo -e "  ${RED}[!!]${NC} Permission filtering NOT FOUND"
  ((ISSUES++))
fi

# Check 3: verifyAccess middleware exists
echo -e "${BLUE}[CHECK] verifyAccess middleware:${NC}"
if [[ -f "$SERVER_DIR/src/middlewares/verifyAccess.middleware.ts" ]]; then
  echo -e "  ${GREEN}[OK]${NC} verifyAccess.middleware.ts exists"
else
  echo -e "  ${RED}[!!]${NC} verifyAccess.middleware.ts NOT FOUND"
  ((ISSUES++))
fi

# Check 4: /me/access endpoint
echo -e "${BLUE}[CHECK] /me/access endpoint:${NC}"
if [[ -f "$SERVER_DIR/src/routes/me.routes.ts" ]]; then
  echo -e "  ${GREEN}[OK]${NC} me.routes.ts exists"
else
  echo -e "  ${RED}[!!]${NC} me.routes.ts NOT FOUND"
  ((ISSUES++))
fi

# Check 5: Deprecated middlewares removed
echo -e "${BLUE}[CHECK] Deprecated middlewares removed:${NC}"
if [[ -f "$SERVER_DIR/src/middlewares/whiteLabelAccessInterceptor.middleware.ts" ]]; then
  echo -e "  ${RED}[!!]${NC} whiteLabelAccessInterceptor.middleware.ts still exists"
  ((ISSUES++))
else
  echo -e "  ${GREEN}[OK]${NC} whiteLabelAccessInterceptor removed"
fi
if [[ -f "$SERVER_DIR/src/middlewares/checkWhiteLabelAccess.middleware.ts" ]]; then
  echo -e "  ${RED}[!!]${NC} checkWhiteLabelAccess.middleware.ts still exists"
  ((ISSUES++))
else
  echo -e "  ${GREEN}[OK]${NC} checkWhiteLabelAccess removed"
fi

echo ""
echo "=============================================="
echo "  FRONTEND (UI Only - No Mapping Logic)"
echo "=============================================="
echo ""

if [[ -d "$DASHBOARD_DIR" ]]; then
  # Check 6: PERMISSION_TO_FEATURE_MAP should NOT exist in frontend
  echo -e "${BLUE}[CHECK] PERMISSION_TO_FEATURE_MAP in frontend (should be NONE):${NC}"
  FRONTEND_MAP=$(grep -rl "PERMISSION_TO_FEATURE_MAP" "$DASHBOARD_DIR/src" --include="*.ts" --include="*.tsx" 2>/dev/null || true)
  if [[ -z "$FRONTEND_MAP" ]]; then
    echo -e "  ${GREEN}[OK]${NC} No frontend files have the mapping"
  else
    echo -e "  ${RED}[!!]${NC} Found in frontend (should be backend only):"
    echo "$FRONTEND_MAP" | while read -r f; do echo "       - ${f#$DASHBOARD_DIR/}"; done
    ((ISSUES++))
  fi

  # Check 7: useAccess hook exists
  echo -e "${BLUE}[CHECK] useAccess hook:${NC}"
  if [[ -f "$DASHBOARD_DIR/src/hooks/use-access.ts" ]]; then
    echo -e "  ${GREEN}[OK]${NC} use-access.ts exists"
  else
    echo -e "  ${RED}[!!]${NC} use-access.ts NOT FOUND"
    ((ISSUES++))
  fi

  # Check 8: Deprecated hooks removed
  echo -e "${BLUE}[CHECK] Deprecated hooks removed:${NC}"
  if [[ -f "$DASHBOARD_DIR/src/hooks/usePermissions.ts" ]]; then
    echo -e "  ${RED}[!!]${NC} usePermissions.ts still exists"
    ((ISSUES++))
  else
    echo -e "  ${GREEN}[OK]${NC} usePermissions.ts removed"
  fi
  if [[ -f "$DASHBOARD_DIR/src/hooks/use-white-label-access.ts" ]]; then
    echo -e "  ${RED}[!!]${NC} use-white-label-access.ts still exists"
    ((ISSUES++))
  else
    echo -e "  ${GREEN}[OK]${NC} use-white-label-access.ts removed"
  fi

  # Check 9: Components using useAccess
  echo -e "${BLUE}[CHECK] Components using useAccess:${NC}"
  USE_ACCESS_COUNT=$(grep -rl "useAccess" "$DASHBOARD_DIR/src" --include="*.tsx" --include="*.ts" 2>/dev/null | grep -v "use-access.ts" | wc -l | tr -d ' ')
  echo -e "  ${GREEN}[OK]${NC} $USE_ACCESS_COUNT files using useAccess"

  # Check 10: No deprecated hook imports
  echo -e "${BLUE}[CHECK] No deprecated hook imports:${NC}"
  DEPRECATED=$(grep -rl "from.*usePermissions\|from.*use-white-label-access" "$DASHBOARD_DIR/src" --include="*.tsx" --include="*.ts" 2>/dev/null | grep -v "use-access.ts" || true)
  if [[ -z "$DEPRECATED" ]]; then
    echo -e "  ${GREEN}[OK]${NC} No imports of deprecated hooks"
  else
    echo -e "  ${RED}[!!]${NC} Found deprecated imports:"
    echo "$DEPRECATED" | while read -r f; do echo "       - ${f#$DASHBOARD_DIR/}"; done
    ((ISSUES++))
  fi

  # Check 11: PermissionProtectedRoute is simple
  echo -e "${BLUE}[CHECK] PermissionProtectedRoute simplified:${NC}"
  if grep -q "hasWhiteLabelAccess" "$DASHBOARD_DIR/src/routes/PermissionProtectedRoute.tsx" 2>/dev/null; then
    echo -e "  ${RED}[!!]${NC} Still has hasWhiteLabelAccess function (remove it)"
    ((ISSUES++))
  else
    echo -e "  ${GREEN}[OK]${NC} No white-label logic in route protection"
  fi
fi

echo ""
echo "=============================================="
echo "  ARCHITECTURE SUMMARY"
echo "=============================================="
echo ""
echo "  Backend (Single Source of Truth):"
echo "    ├── /api/v1/me/access → Returns resolved permissions"
echo "    ├── PERMISSION_TO_FEATURE_MAP → Maps permissions to features"
echo "    ├── access.service.ts → Filters permissions for white-label"
echo "    └── verifyAccess middleware → Enforces on API routes"
echo ""
echo "  Frontend (UI Only):"
echo "    ├── useAccess() → Fetches from /me/access"
echo "    ├── can('permission') → Just checks, no mapping"
echo "    └── PermissionGate → UI visibility only"
echo ""

echo "=============================================="
if [[ $ISSUES -eq 0 ]]; then
  echo -e "  ${GREEN}✓ CENTRALIZATION COMPLETE${NC}"
  echo ""
  echo "  All permissions centralized in backend."
  echo "  Frontend just calls can() - no feature mapping needed."
else
  echo -e "  ${RED}✗ ISSUES FOUND: $ISSUES${NC}"
  echo ""
  echo "  Fix the issues above to complete centralization."
fi
echo "=============================================="
