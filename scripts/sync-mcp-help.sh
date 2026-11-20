#!/usr/bin/env bash
# Copia los artículos del centro de ayuda (avoqado-landing/src/content/help/dashboard) al
# server, para que la tool MCP `avoqado_help` los sirva desde la imagen de producción
# (el Docker sólo empaqueta dist/, y copy:assets lleva src/assets → dist/src/assets).
#
# Correr cuando cambien los artículos en el landing:   bash scripts/sync-mcp-help.sh
# El archivo _overview.md de src/assets/mcp-knowledge/help/ se escribe a mano y NO se toca aquí.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$HERE/../avoqado-landing/src/content/help/dashboard}"
DST="$HERE/src/assets/mcp-knowledge/help"
[ -d "$SRC" ] || { echo "No existe $SRC (pasa la ruta del landing como primer argumento)"; exit 1; }
if [ "${2:-}" != "--support-only" ]; then
mkdir -p "$DST"
# Borra sólo lo sincronizado (subcarpetas por categoría); conserva los archivos _*.md manuales.
find "$DST" -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +
count=0
while IFS= read -r -d '' f; do
  rel="${f#$SRC/}"
  mkdir -p "$DST/$(dirname "$rel")"
  cp "$f" "$DST/$rel"
  count=$((count+1))
done < <(find "$SRC" -type f -name '*.md' -print0)
echo "sync-mcp-help: $count artículos copiados a $DST"
fi

# Support has its own product roots; the legacy corpus and manual files stay independent.
SUPPORT_DST="$HERE/src/assets/mcp-support-help"
HELP_ROOT="$(dirname "$SRC")"
mkdir -p "$SUPPORT_DST"
for product in dashboard android windows tpv; do
  mkdir -p "$SUPPORT_DST/$product"
  find "$SUPPORT_DST/$product" -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +
  product_src="$HELP_ROOT/$product"
  [ -d "$product_src" ] || continue
  while IFS= read -r -d '' f; do
    rel="${f#$product_src/}"
    mkdir -p "$SUPPORT_DST/$product/$(dirname "$rel")"
    cp "$f" "$SUPPORT_DST/$product/$rel"
  done < <(find "$product_src" -type f -name '*.md' -print0)
done
echo "sync-mcp-help: corpus de soporte separado por producto"
