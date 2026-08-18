# Environment Setup Guide

## Environment Configuration Files Created

### 📁 Files Created:

- `.env.staging` - Staging environment variables
- `.env.production` - Production environment variables

## 🗃️ Database Configuration

### Production Database (Fly Postgres)

- **App**: `avoqado-server-db`
- **Database**: `avoqado_server`
- **Internal URL**: `postgres://postgres:PASSWORD@avoqado-server-db.internal:5432/avoqado_server`

### Render Production Database

- **Service**: `avoqado-server-db` on Render
- **Connection**: Via internal connection string in environment variables

## 🚀 Render Service Setup

### For Staging Service (avoqado-server-staging):

1. Go to your staging service dashboard
2. Environment → Environment Variables
3. Copy all variables from `.env.staging`
4. **Important**: Use `sync: false` for all secret values in `render.yaml`

### For Production Service (avoqado-server):

1. Go to your production service dashboard
2. Environment → Environment Variables
3. Copy all variables from `.env.production`
4. **Important**: Use `sync: false` for all secret values in `render.yaml`

## 🚀 Fly.io Service Setup

### For Production Service (avoqado-server):

1. Set secrets via `flyctl secrets set KEY=value -a avoqado-server`
2. Database URL is internal: `postgres://postgres:PASSWORD@avoqado-server-db.internal:5432/avoqado_server`

### Run Migrations on Fly:

```bash
flyctl ssh console -a avoqado-server -C "npx prisma migrate deploy"
```

## 🔐 Security Notes

### ⚠️ CRITICAL: Generate New Secrets for Production

The current secrets are development keys. For production, generate new values for:

- `ACCESS_TOKEN_SECRET`
- `REFRESH_TOKEN_SECRET`
- `COOKIE_SECRET`
- `SESSION_SECRET`

### 🔒 Secret Generation Commands:

```bash
# Generate random 64-character secrets
openssl rand -base64 64
# Or use Node.js
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

## 🪙 Webhook de cripto (B4Bit) — banderas de autenticación

El webhook `POST /api/v1/webhooks/b4bit` **exige firma HMAC válida** (`src/controllers/tpv/b4bit-webhook.tpv.controller.ts`). Ninguna de
estas variables es obligatoria: los defaults son los seguros. Se documentan porque **B4Bit NO reintenta** — cada webhook rechazado es una
confirmación de cobro perdida para siempre.

| Variable                        | Default si NO está      | Qué hace                                                                                                                                                                                                                            |
| ------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `B4BIT_STRICT_WEBHOOK_AUTH`     | **ON** (estricto)       | Válvula de despliegue. Sólo el literal `false` la apaga. Apagada: el webhook se procesa **como antes** pero cada caso que habría rechazado escribe `🚨 [B4Bit webhook] HABRÍA RECHAZADO` con el motivo y el status que habría dado. |
| `B4BIT_ALLOW_UNSIGNED_WEBHOOKS` | **OFF**                 | Sólo con el valor `true` **y fuera de producción**: acepta el webhook de un venue sin secreto. En `NODE_ENV=production` se ignora por completo.                                                                                     |
| `B4BIT_WEBHOOK_SECRET`          | (sin fallback si falta) | **Legado**: un único secreto global, previo al secreto por venue (`VenueCryptoConfig.b4bitSecretKey`). ⚠️ Si está definido, **tapa** la alerta `🚨 SIN SECRET`: un venue sin llave propia falla con 401 en vez de 503.              |

**Antes de desplegar el modo estricto** conviene verificar tres cosas en producción:

1. `SELECT ... FROM "VenueCryptoConfig"` — ningún venue `ACTIVE` sin `b4bitSecretKey`, y que la llave case `^[0-9a-fA-F]{64}$` (hex de 64;
   `Buffer.from(x,'hex')` trunca en silencio y dejaría a ese venue sin cobros).
2. Si existe volumen cripto real (`Payment.method = 'CRYPTOCURRENCY'`).
3. Si `B4BIT_WEBHOOK_SECRET` está definido en el entorno (ver la advertencia de arriba).

Plan B si B4Bit no manda los headers como documenta: desplegar con `B4BIT_STRICT_WEBHOOK_AUTH=false` y leer los `🚨 HABRÍA RECHAZADO` antes
de prender el estricto.

## 🌐 Frontend URLs

### Staging: `https://develop.avoqado-web-dashboard.pages.dev`

- CORS configured for staging API
- Safe for testing and development

### Production: `https://dashboard.avoqado.io`

- CORS configured for production API
- Live customer environment

## 📊 Database Migration Strategy

### Staging Deployments:

1. Code pushed to `develop` branch
2. Run migrations manually or via CI/CD
3. Safe testing environment with isolated data

### Production Deployments:

1. Code pushed to `main` branch
2. Run migrations: `flyctl ssh console -a avoqado-server -C "npx prisma migrate deploy"`
3. Live environment with customer data

## 🔧 GitHub Secrets Required

Ensure these secrets are set in your GitHub repository:

```bash
# Render secrets:
gh secret set RENDER_API_KEY --body "your-render-api-key"
gh secret set RENDER_PRODUCTION_SERVICE_ID --body "srv-xxxxx"
gh secret set RENDER_STAGING_SERVICE_ID --body "srv-xxxxx"
```

## ✅ Next Steps

1. **Create staging service** using Blueprint with `develop` branch
2. **Get staging service ID** and add as GitHub secret
3. **Configure environment variables** in both Render/Fly services
4. **Test deployment pipeline** by pushing to `develop` branch
5. **Generate new production secrets** before going live

## 🎯 Environment Summary

| Environment | Branch    | Database     | Frontend URL                                    | API URL                                     |
| ----------- | --------- | ------------ | ----------------------------------------------- | ------------------------------------------- |
| Staging     | `develop` | Render PG    | https://develop.avoqado-web-dashboard.pages.dev | https://avoqado-server-staging.onrender.com |
| Production  | `main`    | Fly Postgres | https://dashboard.avoqado.io                    | https://avoqado-server.fly.dev              |
