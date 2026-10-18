#!/usr/bin/env bash
# Despliega a Render EXACTAMENTE el commit que el CI acaba de probar y espera a que quede LIVE.
#
# Por qué existe (14-oct-2026): la acción anterior (johnbeynon/render-deploy-action) pedía «despliega» SIN commit, y
# Render subía lo último de main. El 5-oct (19:24 Mx) la corrida de 6eddd89c3 pasó sus pruebas y Render subió dcc6ff788,
# que había llegado a main 20 min antes y cuyas pruebas ni habían empezado. Con `commitId`, cada versión sube sólo
# después de SUS pruebas. Pruebas: tests/unit/architecture/deployProduccionCommitExacto.test.ts (Render y GitHub de mentira).
#
# Nunca hacia atrás: sólo despliega si el commit sigue en main y es MÁS NUEVO que el que está LIVE (comparación de
# GitHub), y antes espera a que no haya ningún deploy en curso. Así re-correr una corrida vieja nunca regresa producción,
# y si llegan A y B seguidos y B falla, A sí sale.
#
# Entradas (variables de entorno):
#   RENDER_API_KEY, RENDER_SERVICE_ID  credenciales de Render (nunca se imprimen ni van en la línea de comandos)
#   GITHUB_TOKEN, GITHUB_REPOSITORY    para comparar commits (en Actions: github.token y la variable por defecto)
#   COMMIT_SHA                         el commit probado (40 caracteres)
#   RENDER_API_BASE, GITHUB_API_URL, POLL_SECONDS, POLL_TRIES, CURL_MAX_TIME  sólo para pruebas.
# Sale con 0 si ese commit exacto quedó LIVE, o si no tocaba desplegarlo (ya está LIVE, o producción ya tiene uno más
# nuevo). Escribe `deployed=true|false` en $GITHUB_OUTPUT cuando existe.
set -euo pipefail

API="${RENDER_API_BASE:-https://api.render.com/v1}"
GH_API="${GITHUB_API_URL:-https://api.github.com}"
POLL_SECONDS="${POLL_SECONDS:-20}"
POLL_TRIES="${POLL_TRIES:-90}"
CURL_MAX_TIME="${CURL_MAX_TIME:-30}"
: "${RENDER_API_KEY:?falta RENDER_API_KEY}"
: "${RENDER_SERVICE_ID:?falta RENDER_SERVICE_ID}"
: "${GITHUB_TOKEN:?falta GITHUB_TOKEN}"
: "${GITHUB_REPOSITORY:?falta GITHUB_REPOSITORY}"
: "${COMMIT_SHA:?falta COMMIT_SHA}"

salida() { if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1" >> "$GITHUB_OUTPUT"; fi; }
resumen() { if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$1" >> "$GITHUB_STEP_SUMMARY"; fi; }
omitir() {
  echo "::notice title=Deploy omitido::$1"
  echo "⏭️ $1"
  resumen "⏭️ $1"
  exit 0
}
salida "deployed=false"

if ! [[ "$COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "❌ COMMIT_SHA no es un SHA completo de 40 caracteres: '$COMMIT_SHA'. No despliego."
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# Las llaves van en archivos de cabeceras, no en la línea de comandos (`ps` las mostraría).
(
  umask 077
  printf 'Authorization: Bearer %s\n' "$RENDER_API_KEY" > "$TMP/auth-render"
  printf 'Authorization: Bearer %s\n' "$GITHUB_TOKEN" > "$TMP/auth-github"
)

# pedir LLAVE MÉTODO URL [CUERPO] → imprime el código HTTP, o 000 si la transferencia falló (corte, tiempo agotado);
# el cuerpo queda en $TMP/body y nunca se usa el de una transferencia fallida.
pedir() {
  local args=(-sS --connect-timeout 10 --max-time "$CURL_MAX_TIME" -o "$TMP/body" -w '%{http_code}' -X "$2"
    -H @"$TMP/auth-$1" -H 'Accept: application/json')
  if [ -n "${4:-}" ]; then args+=(-H 'Content-Type: application/json' --data "$4"); fi
  : > "$TMP/body"
  local code
  if code="$(curl "${args[@]}" "$3" 2> "$TMP/curl.err")"; then
    echo "$code"
  else
    : > "$TMP/body"
    echo "000"
  fi
}
# Mensaje de error saneado: sólo el campo `message` de la respuesta y el error de curl, recortados.
porque() { echo "$(jq -r '.message // empty' "$TMP/body" 2>/dev/null | head -c 300) $(head -c 200 "$TMP/curl.err")"; }

# 1. Esperar a que no haya NINGÚN deploy en curso y leer qué quedó LIVE. Si una corrida anterior se cayó después de
#    pedir su deploy, Render lo sigue construyendo: comparar contra el LIVE de antes dejaría pasar un commit más viejo
#    que ése, y Render lo publicaría encima (hacia atrás). Estados terminales según la API de Render; cualquier otro,
#    incluso uno desconocido, cuenta como «en curso».
TERMINALES='["live","deactivated","build_failed","update_failed","canceled","pre_deploy_failed"]'
EN_CURSO=""
for i in $(seq 1 "$POLL_TRIES"); do
  CODE="$(pedir render GET "$API/services/$RENDER_SERVICE_ID/deploys?limit=50")"
  if [ "$CODE" != "200" ]; then
    echo "❌ No pude leer los deploys de Render (HTTP $CODE): $(porque). No despliego a ciegas."
    exit 1
  fi
  EN_CURSO="$(jq -r --argjson fin "$TERMINALES" \
    '[.[] | (.deploy // .) | select((.status // "") as $s | $fin | map(. == $s) | any | not)] | map("\(.id) (\(.status), \(.commit.id // "?" | .[0:10]))") | join(", ")' \
    "$TMP/body")"
  if [ -z "$EN_CURSO" ]; then break; fi
  echo "[espera $i] hay deploys en curso: $EN_CURSO"
  sleep "$POLL_SECONDS"
done
if [ -n "$EN_CURSO" ]; then
  echo "❌ Sigue habiendo deploys en curso ($EN_CURSO). No pido otro encima."
  exit 1
fi
jq -r '.[] | (.deploy // .) | .id' "$TMP/body" > "$TMP/ids-previos"
VIVO="$(jq -r '[.[] | (.deploy // .) | select(.status == "live")] | first | .commit.id // empty' "$TMP/body")"
if [ -z "$VIVO" ]; then
  echo "❌ No encontré qué commit está LIVE en producción. No despliego a ciegas."
  exit 1
fi
if [ "$VIVO" = "$COMMIT_SHA" ]; then
  omitir "${COMMIT_SHA:0:10} ya está LIVE en producción; no hay nada que desplegar."
fi

# 2. El commit tiene que seguir en main, revisado DESPUÉS de la espera (una corrida re-ejecutada de un commit que ya no
#    está en main no publica).
CODE="$(pedir github GET "$GH_API/repos/$GITHUB_REPOSITORY/compare/$COMMIT_SHA...main?per_page=1")"
EN_MAIN="$(jq -r '.status // empty' "$TMP/body" 2>/dev/null || true)"
if [ "$CODE" != "200" ] || { [ "$EN_MAIN" != "ahead" ] && [ "$EN_MAIN" != "identical" ]; }; then
  echo "❌ ${COMMIT_SHA:0:10} no está en main (HTTP $CODE, GitHub dice '$EN_MAIN'): $(porque). No despliego."
  exit 1
fi

# 3. Nunca hacia atrás: el commit probado tiene que ser MÁS NUEVO que el que está LIVE.
CODE="$(pedir github GET "$GH_API/repos/$GITHUB_REPOSITORY/compare/$VIVO...$COMMIT_SHA?per_page=1")"
if [ "$CODE" != "200" ]; then
  echo "❌ No pude comparar ${VIVO:0:10} (LIVE) con ${COMMIT_SHA:0:10} en GitHub (HTTP $CODE): $(porque). No despliego."
  exit 1
fi
RELACION="$(jq -r '.status // empty' "$TMP/body")"
case "$RELACION" in
  ahead) echo "${COMMIT_SHA:0:10} es más nuevo que lo que está LIVE (${VIVO:0:10})." ;;
  behind) omitir "producción ya tiene ${VIVO:0:10}, más nuevo que ${COMMIT_SHA:0:10}; nunca se despliega hacia atrás." ;;
  *)
    echo "❌ ${COMMIT_SHA:0:10} no desciende de lo que está LIVE (${VIVO:0:10}; GitHub dice '$RELACION'). No despliego."
    exit 1
    ;;
esac

# 4. Pedir ese commit exacto.
echo "🏭 Pidiéndole a Render el commit exacto ${COMMIT_SHA:0:10}…"
CODE="$(pedir render POST "$API/services/$RENDER_SERVICE_ID/deploys" "{\"commitId\":\"$COMMIT_SHA\"}")"
DEPLOY_ID=""
case "$CODE" in
  201)
    DEPLOY_ID="$(jq -r '(.id // .deploy.id) // empty' "$TMP/body" 2>/dev/null || true)"
    PEDIDO="$(jq -r '(.commit.id // .deploy.commit.id) // empty' "$TMP/body" 2>/dev/null || true)"
    if [ -n "$PEDIDO" ] && [ "$PEDIDO" != "$COMMIT_SHA" ]; then
      echo "❌ Render aceptó el deploy pero con OTRO commit ($PEDIDO)."
      exit 1
    fi
    if [ -z "$DEPLOY_ID" ]; then
      echo "❌ Render respondió 201 sin id de deploy: no puedo seguirlo."
      exit 1
    fi
    echo "Render creó el deploy $DEPLOY_ID."
    ;;
  202)
    echo "Render lo dejó en fila (HTTP 202, sin id); lo busco entre los deploys NUEVOS de este commit."
    ;;
  *)
    echo "❌ Render rechazó el deploy (HTTP $CODE): $(porque)"
    exit 1
    ;;
esac

# 5. Seguir ESE deploy por su id hasta LIVE. El éxito sólo se declara leyendo el deploy por su id.
for i in $(seq 1 "$POLL_TRIES"); do
  STATUS="buscando"
  COMMIT=""
  if [ -z "$DEPLOY_ID" ]; then
    CODE="$(pedir render GET "$API/services/$RENDER_SERVICE_ID/deploys?limit=50")"
    if [ "$CODE" = "200" ]; then
      jq -r --arg sha "$COMMIT_SHA" '.[] | (.deploy // .) | select(.commit.id == $sha) | .id' "$TMP/body" \
        | grep -vxF -f "$TMP/ids-previos" > "$TMP/nuevos" || true
      N="$(grep -c . "$TMP/nuevos" || true)"
      if [ "$N" -gt 1 ]; then
        echo "❌ Hay $N deploys nuevos de ${COMMIT_SHA:0:10}; no sé cuál es el mío."
        exit 1
      fi
      if [ "$N" -eq 1 ]; then
        DEPLOY_ID="$(head -1 "$TMP/nuevos")"
        STATUS="encontrado:$DEPLOY_ID"
      fi
    else
      STATUS="http_$CODE"
    fi
  else
    CODE="$(pedir render GET "$API/services/$RENDER_SERVICE_ID/deploys/$DEPLOY_ID")"
    if [ "$CODE" = "200" ]; then
      STATUS="$(jq -r '(.status // .deploy.status) // "unknown"' "$TMP/body")"
      COMMIT="$(jq -r '(.commit.id // .deploy.commit.id) // ""' "$TMP/body")"
    else
      STATUS="http_$CODE"
    fi
  fi

  echo "[$i] status=$STATUS commit=${COMMIT:0:10}"
  case "$STATUS" in
    live)
      if [ "$COMMIT" = "$COMMIT_SHA" ]; then
        echo "✅ LIVE con el commit probado ${COMMIT_SHA:0:10}."
        salida "deployed=true"
        resumen "✅ Producción quedó LIVE con el commit probado \`${COMMIT_SHA:0:10}\`."
        exit 0
      fi
      echo "❌ El deploy quedó LIVE con OTRO commit ($COMMIT), no con el probado ${COMMIT_SHA:0:10}."
      exit 1
      ;;
    build_failed | update_failed | canceled | deactivated | pre_deploy_failed)
      echo "❌ El deploy terminó en: $STATUS"
      exit 1
      ;;
  esac
  sleep "$POLL_SECONDS"
done

echo "❌ Pasaron $POLL_TRIES consultas sin que el commit ${COMMIT_SHA:0:10} quedara LIVE."
exit 1
