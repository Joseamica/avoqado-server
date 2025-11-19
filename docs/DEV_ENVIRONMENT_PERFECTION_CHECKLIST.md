# Dev Environment Perfection Checklist

**Goal**: Tener un entorno de desarrollo PERFECTO antes de ir a producción. **Date**: November 15, 2025

---

## 🎯 Estado Actual

| Categoría              | Estado        | Prioridad |
| ---------------------- | ------------- | --------- |
| **Integración básica** | ✅ Completada | -         |
| **Frontend UX**        | ✅ Completada | -         |
| **Error Handling**     | ✅ Completada | -         |
| **Testing Local**      | ⚠️ Parcial    | 🔴 Alta   |
| **Dev Tools**          | ✅ Completada | -         |
| **Documentación**      | ✅ Completa   | -         |
| **Seed Data**          | ✅ Completada | -         |
| **Debugging Tools**    | ⚠️ Parcial    | 🟡 Media  |

---

## 🔴 ALTA PRIORIDAD (Hacer Primero)

### 1. ✅ Frontend Error Handling User-Friendly

**✅ COMPLETADO** (2025-01-16)

**Problema anterior**:

```javascript
// ❌ Muestra JSON crudo al usuario
showError('card-number', '{"httpStatusCode":409,"code":"TX_003",...}')
```

**Lo que debería mostrar**:

```
❌ "Este mes alcanzaste el límite de pruebas con esta tarjeta"
❌ "Tu tarjeta fue rechazada. Intenta con otra tarjeta"
❌ "El pago falló. Por favor verifica los datos de tu tarjeta"
```

**Implementación necesaria**:

```javascript
// public/checkout/payment.js - AGREGAR
function parseUserFriendlyError(error) {
  // Si es un error de Blumon en formato JSON
  if (error.message.startsWith('{')) {
    try {
      const blumonError = JSON.parse(error.message)

      // Mapear códigos de Blumon a mensajes amigables
      const errorMessages = {
        'TX_001': 'El monto excede el límite permitido por la tarjeta',
        'TX_003': 'Has alcanzado el límite mensual de transacciones con esta tarjeta de prueba',
        'INVALID_CARD': 'Número de tarjeta inválido',
        'INSUFFICIENT_FUNDS': 'Fondos insuficientes en la tarjeta',
        'CARD_DECLINED': 'Tu tarjeta fue rechazada',
        'EXPIRED_CARD': 'La tarjeta ha expirado',
        'INVALID_CVV': 'CVV incorrecto',
      }

      return errorMessages[blumonError.code] || blumonError.description || 'Error al procesar el pago'
    } catch (e) {
      return error.message
    }
  }

  return error.message
}

// USO
catch (error) {
  const friendlyMessage = parseUserFriendlyError(error)
  showError('card-number', friendlyMessage)
}
```

**Archivos a modificar**:

- `public/checkout/payment.js` - Agregar función de parseo
- `public/checkout/payment.html` - Mejorar estilos de error

**Tiempo estimado**: 1-2 horas

---

### 2. ❌ Mock de Blumon para Testing Local

**Problema**: Cada test consume límite mensual de tarjetas de prueba.

**Solución**: Mock server que simula respuestas de Blumon SIN llamar la API real.

**Implementación**:

```typescript
// src/services/sdk/blumon-ecommerce.service.mock.ts
export class BlumonEcommerceMockService implements IBlumonEcommerceService {
  async tokenizeCard(request: BlumonTokenizeRequest): Promise<BlumonTokenizeResponse> {
    // Simular delay de API real
    await sleep(500)

    // Simular diferentes escenarios basados en número de tarjeta
    const testScenarios = {
      '4111111111111111': { success: true, token: 'mock_tok_visa_success' },
      '4000000000000002': { success: false, error: 'CARD_DECLINED' },
      '4000000000009995': { success: false, error: 'INSUFFICIENT_FUNDS' },
      '5555555555554444': { success: true, token: 'mock_tok_mc_success' },
    }

    const scenario = testScenarios[request.pan] || testScenarios['4111111111111111']

    if (!scenario.success) {
      throw new BadRequestError(scenario.error)
    }

    return {
      token: scenario.token,
      maskedPan: `${request.pan.substring(0, 6)}******${request.pan.slice(-4)}`,
      cardBrand: this.detectCardBrand(request.pan),
    }
  }

  async authorizePayment(request: BlumonAuthorizeRequest): Promise<BlumonAuthorizeResponse> {
    await sleep(800)

    // Simular diferentes resultados
    if (request.amount > 10000) {
      throw new BadRequestError('{"code":"TX_001","description":"EL MONTO EXCEDE EL LÍMITE"}')
    }

    return {
      authorizationId: `mock_auth_${Date.now()}`,
      transactionId: `mock_tx_${Date.now()}`,
      status: 'APPROVED',
      authorizationCode: '123456',
    }
  }
}

// src/services/sdk/blumon-ecommerce.service.ts - MODIFICAR
export function getBlumonEcommerceService(sandboxMode: boolean = true): IBlumonEcommerceService {
  // En desarrollo con flag MOCK=true → usar mock
  if (process.env.USE_BLUMON_MOCK === 'true') {
    return new BlumonEcommerceMockService()
  }

  // Normal flow
  return new BlumonEcommerceService(sandboxMode)
}
```

**Configuración**:

```bash
# .env
USE_BLUMON_MOCK=true  # Habilitar mock en dev
```

**Ventajas**:

- ✅ Testing ilimitado sin consumir tarjetas de prueba
- ✅ Simular errores específicos (tarjeta rechazada, fondos insuficientes)
- ✅ Testing rápido (no esperar API real)
- ✅ Desarrollo offline

**Archivos a crear**:

- `src/services/sdk/blumon-ecommerce.service.mock.ts`
- `src/services/sdk/blumon-ecommerce.interface.ts`

**Tiempo estimado**: 3-4 horas

---

### 3. ❌ Webhook Simulator para Dev

**Problema**: No puedes testear webhooks localmente sin exponer localhost a internet.

**Solución**: Endpoint que simula webhooks de Blumon.

**Implementación**:

```typescript
// src/controllers/dev/webhook-simulator.controller.ts
export async function simulateBlumonWebhook(req: Request, res: Response) {
  const { sessionId, event, status } = req.body

  // Simular webhook de pago exitoso
  const webhookPayload = {
    event: event || 'payment.authorized',
    data: {
      sessionId,
      status: status || 'APPROVED',
      authorizationId: `sim_auth_${Date.now()}`,
      transactionId: `sim_tx_${Date.now()}`,
      amount: 10,
      currency: 'MXN',
      timestamp: new Date().toISOString(),
    },
  }

  // Procesar como si fuera webhook real
  await webhookHandler.processWebhook(webhookPayload)

  res.json({ success: true, message: 'Webhook simulated' })
}

// routes/dev.routes.ts
if (process.env.NODE_ENV === 'development') {
  router.post('/dev/simulate-webhook', simulateBlumonWebhook)
}
```

**Uso**:

```bash
# Simular pago exitoso
curl -X POST http://localhost:12344/api/v1/dev/simulate-webhook \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"cs_test_xxx","event":"payment.authorized","status":"APPROVED"}'

# Simular pago fallido
curl -X POST http://localhost:12344/api/v1/dev/simulate-webhook \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"cs_test_xxx","event":"payment.failed","status":"DECLINED"}'
```

**Tiempo estimado**: 2-3 horas

---

### 4. ❌ Session Status Dashboard (UI simple)

**Problema**: No hay forma visual de ver todas las sesiones activas/fallidas.

**Solución**: Dashboard HTML simple para ver estado de sesiones.

**Implementación**:

```html
<!-- public/dev/sessions-dashboard.html -->
<!DOCTYPE html>
<html>
  <head>
    <title>Checkout Sessions Dashboard - DEV</title>
    <style>
      body {
        font-family: system-ui;
        padding: 20px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th,
      td {
        border: 1px solid #ddd;
        padding: 8px;
        text-align: left;
      }
      th {
        background: #f4f4f4;
      }
      .PENDING {
        color: orange;
      }
      .PROCESSING {
        color: blue;
      }
      .COMPLETED {
        color: green;
      }
      .FAILED {
        color: red;
      }
      .EXPIRED {
        color: gray;
      }
    </style>
  </head>
  <body>
    <h1>🔍 Checkout Sessions Dashboard</h1>
    <button onclick="loadSessions()">🔄 Refresh</button>
    <button onclick="cleanupExpired()">🗑️ Cleanup Expired</button>

    <table id="sessions-table">
      <thead>
        <tr>
          <th>Session ID</th>
          <th>Amount</th>
          <th>Status</th>
          <th>Created</th>
          <th>Expires</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody id="sessions-body"></tbody>
    </table>

    <script>
      async function loadSessions() {
        const res = await fetch('/api/v1/dev/sessions')
        const sessions = await res.json()

        const tbody = document.getElementById('sessions-body')
        tbody.innerHTML = sessions
          .map(
            s => `
        <tr>
          <td><code>${s.sessionId}</code></td>
          <td>$${s.amount} ${s.currency}</td>
          <td class="${s.status}">${s.status}</td>
          <td>${new Date(s.createdAt).toLocaleString()}</td>
          <td>${new Date(s.expiresAt).toLocaleString()}</td>
          <td>
            <a href="/sdk/example.html?sessionId=${s.sessionId}&amount=${s.amount}&currency=${s.currency}">
              Test
            </a>
            ${s.status === 'FAILED' ? `<button onclick="resetSession('${s.sessionId}')">Reset</button>` : ''}
          </td>
        </tr>
      `,
          )
          .join('')
      }

      async function resetSession(sessionId) {
        await fetch(`/api/v1/dev/sessions/${sessionId}/reset`, { method: 'POST' })
        loadSessions()
      }

      async function cleanupExpired() {
        await fetch('/api/v1/dev/sessions/cleanup', { method: 'POST' })
        loadSessions()
      }

      // Auto-refresh cada 5 segundos
      setInterval(loadSessions, 5000)
      loadSessions()
    </script>
  </body>
</html>
```

```typescript
// src/controllers/dev/sessions.controller.ts
export async function getRecentSessions(req: Request, res: Response) {
  const sessions = await prisma.checkoutSession.findMany({
    where: {
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, // Last 24h
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  res.json(sessions)
}

export async function resetSessionStatus(req: Request, res: Response) {
  const { sessionId } = req.params

  await prisma.checkoutSession.update({
    where: { sessionId },
    data: { status: CheckoutStatus.PENDING },
  })

  res.json({ success: true })
}
```

**Acceso**: `http://localhost:12344/dev/sessions-dashboard.html`

**Tiempo estimado**: 2-3 horas

---

## 🟡 MEDIA PRIORIDAD

### 5. ✅ Mejorar Seed Data

**✅ COMPLETADO** (2025-11-16)

**Problemas anteriores**:

- ❌ Seed borraba credenciales OAuth de Blumon
- ❌ No creaba sesiones de checkout de ejemplo
- ❌ No creaba productos/categorías relacionados (opcional)

**Implementación realizada**:

1. **Preservación de OAuth credentials** (`prisma/seed.ts:380-412`):

   - ✅ Detecta Blumon merchants con OAuth tokens (accessToken + refreshToken)
   - ✅ Los mantiene intactos durante el seed
   - ✅ Solo recrea merchants sin credenciales (setup incompleto)
   - ✅ PaymentProviders también preservados si son referenciados

2. **Sample CheckoutSessions** (`prisma/seed.ts:1558-1689`):
   - ✅ Crea 5 sesiones de ejemplo con diferentes estados:
     - PENDING - Sesión activa esperando pago (expira en 24h)
     - COMPLETED - Pago exitoso (ayer)
     - FAILED - Pago fallido con mensaje de error
     - EXPIRED - Sesión expirada (hace 2 días)
     - PROCESSING - Pago en progreso (hace 30 minutos)
   - ✅ Datos realistas: nombres, emails, teléfonos, metadata
   - ✅ Timestamps variables para testing

**Verificación**:

```bash
# Verificar que OAuth credentials se preservan
npm run seed
# Output: "✅ Preserved Blumon merchant 'Tienda Web (Blumon)' (has OAuth credentials)"

# Ver sesiones creadas
psql $DATABASE_URL -c "SELECT sessionId, status, amount FROM CheckoutSession LIMIT 5;"
```

**Problemas anteriores (ahora resueltos)**:

**Mejoras necesarias**:

```typescript
// prisma/seed.ts - AGREGAR
async function seedCheckoutSessions() {
  console.log('🛒 Creating sample checkout sessions...')

  const blumonMerchant = await prisma.ecommerceMerchant.findFirst({
    where: { provider: { code: 'BLUMON' } },
  })

  if (!blumonMerchant) {
    console.log('⚠️ No Blumon merchant found, skipping checkout sessions')
    return
  }

  const sessions = [
    {
      sessionId: 'cs_test_small_amount',
      amount: 0.5,
      currency: 'MXN',
      description: 'Small amount test - $0.50',
      status: 'PENDING',
    },
    {
      sessionId: 'cs_test_normal_amount',
      amount: 10,
      currency: 'MXN',
      description: 'Normal amount test - $10',
      status: 'PENDING',
    },
    {
      sessionId: 'cs_test_failed_example',
      amount: 100,
      currency: 'MXN',
      description: 'Failed payment example',
      status: 'FAILED',
    },
  ]

  for (const session of sessions) {
    await prisma.checkoutSession.upsert({
      where: { sessionId: session.sessionId },
      create: {
        ...session,
        ecommerceMerchantId: blumonMerchant.id,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
      update: session,
    })
  }

  console.log(`✅ Created ${sessions.length} checkout sessions`)
}

// IMPORTANTE: NO borrar credenciales OAuth
async function seedBlumonMerchant() {
  // Verificar si ya tiene credenciales
  const existing = await prisma.ecommerceMerchant.findFirst({
    where: { provider: { code: 'BLUMON' } },
  })

  if (existing?.providerCredentials) {
    console.log('✅ Blumon merchant already has OAuth credentials - SKIPPING')
    return existing
  }

  // Solo crear si no existe
  // ...
}
```

**Archivos a modificar**:

- `prisma/seed.ts` - Agregar sesiones de ejemplo y preservar OAuth

**Tiempo estimado**: 1-2 horas

---

### 6. ✅ .env.example Completo

**✅ COMPLETADO** (2025-11-16)

**Implementación realizada**:

```bash
# .env.example - ACTUALIZAR

# Database
DATABASE_URL="postgresql://..."
DIRECT_URL="postgresql://..."

# Server
PORT=12344
NODE_ENV=development

# Blumon Integration
USE_BLUMON_MOCK=true  # true = usar mock, false = API real
BLUMON_MASTER_USERNAME=jose@avoqado.io
BLUMON_MASTER_PASSWORD=your_password_here

# Session
SESSION_SECRET=your_session_secret_here

# Redis (opcional en dev)
REDIS_URL=redis://localhost:6379

# Email (para testing)
SMTP_HOST=smtp.mailtrap.io
SMTP_PORT=2525
SMTP_USER=your_mailtrap_user
SMTP_PASS=your_mailtrap_pass

# Monitoring (opcional en dev)
SENTRY_DSN=

# Feature Flags
ENABLE_WEBHOOKS=false  # true cuando implementes webhooks
ENABLE_EMAIL_NOTIFICATIONS=false  # true cuando implementes emails
```

**Archivos a modificar**:

- `.env.example`

**Tiempo estimado**: 30 minutos

---

### 7. ✅ README de Setup Completo

**✅ COMPLETADO** (2025-11-16)

**Archivo creado**: `SETUP.md` - Comprehensive setup guide

**Implementación realizada**:

```markdown
# 🚀 Avoqado Server - Dev Setup

## Prerrequisitos

- Node.js 18+
- PostgreSQL 14+
- Redis (opcional)
- Git

## Instalación

1. **Clone el repo**: \`\`\`bash git clone ... cd avoqado-server \`\`\`

2. **Instala dependencias**: \`\`\`bash npm install \`\`\`

3. **Configura variables de entorno**: \`\`\`bash cp .env.example .env

   # Edita .env con tus valores

   \`\`\`

4. **Crea la base de datos**: \`\`\`bash createdb avoqado_dev \`\`\`

5. **Ejecuta migraciones**: \`\`\`bash npx prisma migrate dev \`\`\`

6. **Carga datos de prueba**: \`\`\`bash npx prisma db seed \`\`\`

7. **Autentica con Blumon** (si vas a usar API real): \`\`\`bash npx ts-node -r tsconfig-paths/register
   scripts/blumon-authenticate-master.ts \`\`\`

8. **Inicia el servidor**: \`\`\`bash npm run dev \`\`\`

9. **Abre el dashboard de sesiones**: \`\`\` http://localhost:12344/dev/sessions-dashboard.html \`\`\`

## Testing Pagos

### Con Mock (recomendado para dev):

1. En `.env`: `USE_BLUMON_MOCK=true`
2. Crear sesión: `npm run create-session`
3. Probar pago: Abrir URL generada

### Con API Real de Blumon:

1. En `.env`: `USE_BLUMON_MOCK=false`
2. Autenticar: `npm run blumon-auth`
3. Crear sesión: `npm run create-session`
4. ⚠️ Cuidado con límites mensuales!

## Scripts Útiles

\`\`\`bash npm run dev # Servidor con hot reload npm run create-session # Crear sesión de checkout npm run blumon-auth # Re-autenticar con
Blumon npm test # Ejecutar tests npm run lint:fix # Fix lint issues npm run format # Format code \`\`\`

## Troubleshooting

### "Merchant OAuth credentials missing"

→ Ejecuta: `npm run blumon-auth`

### "TX_003: Monthly limit exceeded"

→ Usa mock: `USE_BLUMON_MOCK=true` en `.env`

### "Cannot tokenize: session status is FAILED"

→ Crea nueva sesión o usa dashboard para resetear
```

**Archivos a crear**:

- `README_DEV_SETUP.md`

**Tiempo estimado**: 1 hora

---

### 8. ✅ NPM Scripts Convenientes (Stripe-style CLI)

**✅ COMPLETADO** (2025-11-16)

**Implementación realizada** - Stripe-style developer experience:

1. **13 Blumon CLI commands** (`package.json`):

   - `blumon:help` - Show all available commands (full CLI guide)
   - `blumon:auth` - Authenticate master credentials
   - `blumon:session` - Create test checkout session
   - `blumon:sessions` - List active sessions
   - `blumon:webhook` - Simulate webhook event
   - `blumon:merchant` - Check merchant status
   - `blumon:mock` - Test with mock service
   - `blumon:flow` - Test complete flow

2. **Development utilities**:

   - `dev:dashboard` - Open session dashboard in browser
   - `dev:clean-sessions` - Delete old sessions (with --days flag)
   - `dev:logs` - Tail latest log file in real-time

3. **SDK testing**:
   - `sdk:test` - Test all SDK endpoints
   - `sdk:errors` - Test error parser

**Scripts creados**:

- `scripts/blumon-help.ts` - Beautiful CLI help (like `stripe help`)
- `scripts/cleanup-old-sessions.ts` - Session cleanup with dry-run mode

**Ejemplo de uso**:

```json
// package.json - AGREGAR
{
  "scripts": {
    // ... existing scripts ...

    // Blumon helpers
    "blumon:auth": "ts-node -r tsconfig-paths/register scripts/blumon-authenticate-master.ts",
    "blumon:create-session": "ts-node -r tsconfig-paths/register scripts/create-direct-session.ts",
    "blumon:list-merchants": "ts-node -r tsconfig-paths/register scripts/list-active-merchants.ts",

    // Dev tools
    "dev:dashboard": "open http://localhost:12344/dev/sessions-dashboard.html",
    "dev:clean-sessions": "ts-node -r tsconfig-paths/register scripts/cleanup-test-sessions.ts",

    // Database
    "db:reset": "npx prisma migrate reset --force && npx prisma db seed",
    "db:seed": "npx prisma db seed",

    // All-in-one setup
    "setup": "npm install && npx prisma migrate dev && npm run db:seed && npm run blumon:auth"
  }
}
```

**Uso**:

```bash
npm run blumon:auth              # Re-autenticar Blumon
npm run blumon:create-session    # Crear sesión de prueba
npm run dev:dashboard            # Abrir dashboard de sesiones
npm run db:reset                 # Resetear DB completamente
npm run setup                    # Setup completo desde cero
```

**Tiempo estimado**: 30 minutos

---

### 9. ✅ Script de Cleanup de Sesiones de Prueba

**✅ COMPLETADO** (2025-11-16)

**Implementación realizada**: `scripts/cleanup-old-sessions.ts`

Features:

- ✅ Delete sessions older than N days (default: 7)
- ✅ Dry-run mode (`--dry-run`)
- ✅ Interactive confirmation (3-second countdown)
- ✅ Grouping by status (PENDING, COMPLETED, FAILED, etc.)
- ✅ Sample preview before deletion
- ✅ Statistics after cleanup

**Uso**:

```typescript
// scripts/cleanup-test-sessions.ts
import prisma from '../src/utils/prismaClient'

async function cleanupTestSessions() {
  console.log('🧹 Cleaning up test checkout sessions...')

  // Borrar sesiones más viejas de 24 horas
  const result = await prisma.checkoutSession.deleteMany({
    where: {
      OR: [
        { sessionId: { startsWith: 'cs_test_' } },
        { createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
        { status: 'EXPIRED' },
      ],
    },
  })

  console.log(`✅ Deleted ${result.count} old sessions`)

  // Mostrar sesiones restantes
  const remaining = await prisma.checkoutSession.count()
  console.log(`📊 Remaining sessions: ${remaining}`)

  await prisma.$disconnect()
}

cleanupTestSessions()
```

**Uso**:

```bash
npm run dev:clean-sessions
```

**Tiempo estimado**: 30 minutos

---

### 10. ⚠️ Logging Mejorado para Debugging

**Agregar logs más detallados en puntos clave**:

```typescript
// src/controllers/sdk/tokenize.sdk.controller.ts - MEJORAR LOGS
logger.info('💳 [TOKENIZE] Card tokenization request', {
  sessionId,
  amount: session.amount,
  currency: session.currency,
  merchantId: session.ecommerceMerchant.id,
  merchantName: session.ecommerceMerchant.channelName,
  sandboxMode: session.ecommerceMerchant.sandboxMode,
  hasOAuthToken: !!credentials.accessToken,
  tokenExpiresAt: credentials.expiresAt,
  cardData: {
    pan: pan.replace(/\s/g, '').replace(/\d(?=\d{4})/g, '*'), // Mask all but last 4
    cvv: '***',
    expMonth,
    expYear,
    cardholderName,
  },
  ip: req.ip,
  userAgent: req.get('user-agent'),
})

// Después de tokenización exitosa
logger.info('✅ [TOKENIZE] Card tokenized successfully', {
  sessionId,
  tokenLength: tokenResult.token.length,
  maskedPan: tokenResult.maskedPan,
  cardBrand: tokenResult.cardBrand,
  durationMs: Date.now() - startTime,
})

// En caso de error
logger.error('❌ [TOKENIZE] Tokenization failed', {
  sessionId,
  error: error.message,
  errorCode: error.code,
  statusCode: error.response?.status,
  blumonResponse: JSON.stringify(error.response?.data || {}),
  merchantId: session.ecommerceMerchant.id,
  durationMs: Date.now() - startTime,
})
```

**Archivos a modificar**:

- `src/controllers/sdk/tokenize.sdk.controller.ts`
- `src/services/sdk/blumon-ecommerce.service.ts`

**Tiempo estimado**: 1 hora

---

## 🟢 BAJA PRIORIDAD (Nice to Have)

### 11. Thunder Client / Postman Collection

**Crear colección de requests para testing rápido**:

```json
// thunder-tests/checkout-session-flow.json
{
  "client": "Thunder Client",
  "collectionName": "Blumon SDK - Checkout Flow",
  "dateExported": "2025-11-15",
  "requests": [
    {
      "name": "1. Create Checkout Session",
      "method": "POST",
      "url": "http://localhost:12344/api/v1/sdk/sessions",
      "body": {
        "amount": 10,
        "currency": "MXN",
        "description": "Test payment"
      }
    },
    {
      "name": "2. Tokenize Card",
      "method": "POST",
      "url": "http://localhost:12344/api/v1/sdk/tokenize",
      "body": {
        "sessionId": "{{sessionId}}",
        "pan": "4111111111111111",
        "cvv": "123",
        "expMonth": "12",
        "expYear": "2025",
        "cardholderName": "Test User"
      }
    },
    {
      "name": "3. Charge Payment",
      "method": "POST",
      "url": "http://localhost:12344/api/v1/sdk/charge",
      "body": {
        "sessionId": "{{sessionId}}",
        "cvv": "123"
      }
    }
  ]
}
```

**Tiempo estimado**: 1 hora

---

### 12. Git Hooks para Prevenir Commits con Bugs

**Pre-commit hook para validar antes de commit**:

```bash
#!/bin/sh
# .git/hooks/pre-commit

echo "🔍 Running pre-commit checks..."

# 1. Lint
npm run lint
if [ $? -ne 0 ]; then
  echo "❌ Lint failed. Run 'npm run lint:fix' and try again."
  exit 1
fi

# 2. Type check
npm run type-check
if [ $? -ne 0 ]; then
  echo "❌ Type check failed."
  exit 1
fi

# 3. Unit tests (rápidos)
npm run test:unit
if [ $? -ne 0 ]; then
  echo "❌ Unit tests failed."
  exit 1
fi

echo "✅ Pre-commit checks passed!"
exit 0
```

**Tiempo estimado**: 30 minutos

---

## 📊 Resumen de Tiempo Estimado

### 🔴 Alta Prioridad: 11-16 horas

1. Error handling user-friendly (1-2h)
2. Mock de Blumon (3-4h)
3. Webhook simulator (2-3h)
4. Session dashboard (2-3h)

### 🟡 Media Prioridad: 6-8 horas

5. Mejorar seed data (1-2h)
6. .env.example completo (0.5h)
7. README setup (1h)
8. NPM scripts (0.5h)
9. Cleanup script (0.5h)
10. Logging mejorado (1h)

### 🟢 Baja Prioridad: 1.5 horas

11. Thunder Client collection (1h)
12. Git hooks (0.5h)

**Total: 18.5 - 25.5 horas (~1 semana)**

---

## 🎯 Plan de Implementación Sugerido

### Día 1 (4-5 horas):

- ✅ Mock de Blumon
- ✅ Error handling user-friendly

### Día 2 (3-4 horas):

- ✅ Session dashboard
- ✅ Webhook simulator

### Día 3 (2-3 horas):

- ✅ Mejorar seed data
- ✅ NPM scripts
- ✅ Cleanup script

### Día 4 (2-3 horas):

- ✅ README setup
- ✅ .env.example
- ✅ Logging mejorado

### Día 5 (1-2 horas):

- ✅ Thunder Client collection
- ✅ Git hooks
- ✅ Testing final

---

## ✅ Checklist Final

Antes de considerar DEV como "perfecto":

- [ ] Puedo testear pagos ilimitadamente sin consumir límites (Mock)
- [ ] Los errores son claros para el usuario (no JSON crudo)
- [ ] Puedo ver todas las sesiones activas visualmente (Dashboard)
- [ ] Puedo simular webhooks localmente (Simulator)
- [ ] El seed no borra mis credenciales OAuth
- [ ] Hay sesiones de ejemplo pre-creadas
- [ ] El .env.example está completo
- [ ] El README explica cómo hacer setup desde cero
- [ ] Los NPM scripts son convenientes
- [ ] Puedo limpiar sesiones viejas fácilmente
- [ ] Los logs son detallados y útiles para debugging
- [ ] Tengo colección de Thunder Client para testing rápido
- [ ] Git hooks previenen commits con bugs

**¿Empiezo con el item #1 (Error Handling User-Friendly)?** 🚀
