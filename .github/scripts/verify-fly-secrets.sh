#!/bin/bash
# Script para verificar que todos los secrets necesarios existen en Fly.io
# antes de hacer deploy

set -e  # Exit on any error

echo "🔍 Verificando secrets en Fly.io..."

# Lista de secrets requeridos
REQUIRED_SECRETS=(
  "DATABASE_URL"
  "RABBITMQ_URL"
  "ACCESS_TOKEN_SECRET"
  "SESSION_SECRET"
  "COOKIE_SECRET"
  "JWT_SECRET"
  "STRIPE_SECRET_KEY"
)

# Obtener lista de secrets
SECRETS_LIST=$(fly secrets list -a avoqado-server 2>&1)

# Verificar cada secret
MISSING_SECRETS=()
for secret in "${REQUIRED_SECRETS[@]}"; do
  if echo "$SECRETS_LIST" | grep -q "^$secret"; then
    echo "✅ $secret encontrado"
  else
    echo "❌ $secret NO encontrado"
    MISSING_SECRETS+=("$secret")
  fi
done

# Si hay secrets faltantes, fallar el deploy
if [ ${#MISSING_SECRETS[@]} -gt 0 ]; then
  echo ""
  echo "❌ ERROR: Los siguientes secrets están faltando:"
  for secret in "${MISSING_SECRETS[@]}"; do
    echo "   - $secret"
  done
  echo ""
  echo "Por favor configura los secrets faltantes con:"
  echo "   fly secrets set SECRET_NAME=value -a avoqado-server"
  exit 1
fi

echo ""
echo "✅ Todos los secrets verificados correctamente"
exit 0
