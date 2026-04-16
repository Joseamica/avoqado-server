#!/usr/bin/env bash
# verify-permission-sync.sh — SIM Custody Permissions Sync Check (plan §11)
#
# Greps permission strings hardcoded in Dashboard & TPV, compares against the
# canonical registry in avoqado-server/src/lib/permissions.ts. Fails CI if any
# permission string used in a consumer repo is unknown to the backend.
#
# Usage: from monorepo root:
#   bash avoqado-server/scripts/verify-permission-sync.sh
#
# Exits 0 on success, 1 if any mismatch is found.
# Compatible with bash 3.2 (macOS default) — no associative arrays.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND="$ROOT/avoqado-server/src/lib/permissions.ts"
DASHBOARD="$ROOT/avoqado-web-dashboard"
TPV="$ROOT/avoqado-tpv/app"

if [[ ! -f "$BACKEND" ]]; then
  echo "❌ Cannot locate backend permissions registry at $BACKEND" >&2
  exit 1
fi

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

CANONICAL_FILE="$TMP_DIR/canonical.txt"
REFS_FILE="$TMP_DIR/refs.txt"
REFS_WITH_SOURCE="$TMP_DIR/refs-with-source.txt"

# 1) Collect canonical permission set from the backend file.
grep -oE "'[a-z][a-z0-9-]+:[a-z0-9:_*-]+'" "$BACKEND" \
  | tr -d "'" \
  | grep -vE '^(http|https|application|image|text)$' \
  | sort -u \
  > "$CANONICAL_FILE"

CANONICAL_COUNT=$(wc -l < "$CANONICAL_FILE" | tr -d ' ')
echo "ℹ️  Backend defines $CANONICAL_COUNT canonical permission strings."

# 2) Collect permissions referenced in consumer repos.
: > "$REFS_WITH_SOURCE"

if [[ -d "$DASHBOARD/src" ]]; then
  grep -REho --include="*.tsx" --include="*.ts" "can\(['\"][a-z0-9:_-]+['\"]\)" "$DASHBOARD/src" 2>/dev/null \
    | grep -oE "[a-z][a-z0-9-]+:[a-z0-9:_-]+" \
    | sort -u \
    | awk '{print "dashboard\t" $0}' \
    >> "$REFS_WITH_SOURCE" || true
else
  echo "⚠️  Skipping dashboard — path not found ($DASHBOARD/src)"
fi

if [[ -d "$TPV/src" ]]; then
  grep -REho --include="*.kt" 'hasPermission\("[a-z0-9:_-]+"\)' "$TPV/src" 2>/dev/null \
    | grep -oE "[a-z][a-z0-9-]+:[a-z0-9:_-]+" \
    | sort -u \
    | awk '{print "tpv\t" $0}' \
    >> "$REFS_WITH_SOURCE" || true
else
  echo "⚠️  Skipping tpv — path not found ($TPV/src)"
fi

awk '{print $2}' "$REFS_WITH_SOURCE" | sort -u > "$REFS_FILE"
REFS_COUNT=$(wc -l < "$REFS_FILE" | tr -d ' ')
echo "ℹ️  Consumers reference $REFS_COUNT distinct permission strings."

# 3) Diff: refs that are neither exact matches nor covered by a wildcard entry.
MISSING=0
while IFS= read -r perm; do
  [[ -z "$perm" ]] && continue
  if grep -qxF "$perm" "$CANONICAL_FILE"; then
    continue
  fi
  resource="${perm%%:*}"
  if grep -qxF "$resource:*" "$CANONICAL_FILE"; then
    continue
  fi
  # Report the first source that references this permission.
  source_label=$(awk -F'\t' -v p="$perm" '$2 == p { print $1; exit }' "$REFS_WITH_SOURCE")
  echo "❌ $source_label uses unknown permission: $perm"
  MISSING=$((MISSING + 1))
done < "$REFS_FILE"

if (( MISSING > 0 )); then
  echo "❌ $MISSING permission(s) referenced in consumers but not declared in backend." >&2
  exit 1
fi

echo "✅ Permissions are in sync across backend, dashboard, and TPV."
