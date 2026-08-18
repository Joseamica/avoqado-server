# Uber Eats — Camino de Entrada (token + webhook) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que un webhook de Uber Eats llegue a `/api/v1/webhooks/delivery/uber`, se verifique su firma HMAC, se deduplique y quede persistido como `DeliveryOrderEvent` — probado end-to-end firmándonos los eventos nosotros (sin depender de Uber).

**Architecture:** Camino propio de Uber (Deliverect CONGELADO — no tocar `providers/deliverect/**` ni el core que consume). Módulos puros y testeables; el HTTP de más bajo nivel pasa por el candado `uber.storeAllowlist` ya construido (6/6 verde).

**Tech Stack:** Express + TypeScript, Prisma, Jest (proyecto `unit`), crypto nativo de Node.

**Spec:** `docs/superpowers/specs/2026-08-17-delivery-uber-eats.md` (pasos 2 y 3; etiquetas [código]/[doc]/[api]/[supuesto])

## Global Constraints

- 🔴 NUNCA tocar `providers/deliverect/**` ni cambiar comportamiento del core compartido (decisión founder 2026-08-17)
- 🔴 Cero escrituras a la API de Uber: este plan es SOLO entrada + token (lectura). El candado bloquea todo (env vacía)
- Dinero: jamás `number` — `Prisma.Decimal` o string decimal (critical-warnings.md)
- Módulos puros sin `@/config/env` en imports de test (mata workers de Jest — regla del repo)
- Correr por archivo: `npx jest --selectProjects unit --testPathPattern "<nombre>"`
- Zod con mensajes en español
- Sin commits salvo permiso explícito del founder (testing-and-git.md)
- Base URLs sandbox: `sandbox-login.uber.com` + `test-api.uber.com` — NUNCA mezclar con producción [api]

---

### Task 1: Primitiva de caché single-flight del token (paso 2 PARCIAL a propósito)

⚠️ Esta task construye SOLO el caché. El adaptador HTTP real (`POST /oauth/v2/token` con
`client_id`/`client_secret`, el par inseparable sandbox-login↔test-api vs auth↔api, y su env
tipada en `src/config/env.ts` — hoy NO existe ninguna var `UBER_*` ahí) es task del Plan 2:
sin tienda de prueba no hay contra qué validarlo. El caché asume UNAS credenciales por
proceso (no usar con múltiples client_id) y es por PROCESO: válido mientras producción sea
una sola instancia (`render.yaml`, regla `una-sola-instancia.md`); antes de habilitar PM2
cluster (`ecosystem.config.js` tiene `instances:'max'` dormido) hay que promoverlo a caché
compartido.

**Files:**
- Create: `src/services/delivery-channels/providers/uber-eats/uber.token.ts`
- Test: `tests/unit/services/delivery-channels/uberToken.test.ts`

**Interfaces:**
- Consumes: nada de tareas previas (módulo raíz del cliente)
- Produces: `getUberAppToken(deps: UberTokenDeps): Promise<string>` y `_resetUberTokenCacheForTests()`. `UberTokenDeps = { fetchToken: () => Promise<{ access_token: string; expires_in: number }>, now?: () => number }`. Task 2 NO lo consume (webhook no llama a Uber); lo consumirá el Plan 2 (fetchOrder).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/services/delivery-channels/uberToken.test.ts
import { getUberAppToken, _resetUberTokenCacheForTests } from '@/services/delivery-channels/providers/uber-eats/uber.token'

// Spec paso 2 [api]: expires_in=2592000 SEGUNDOS (30 días). [doc]: 100 tokens/hora,
// el 101º invalida el más viejo ⇒ cache single-flight obligatorio, renovación anticipada.
describe('uber.token', () => {
  beforeEach(() => _resetUberTokenCacheForTests())

  it('pide UNA vez y reusa el token mientras no expira', async () => {
    let calls = 0
    const deps = {
      fetchToken: async () => { calls++; return { access_token: `tok-${calls}`, expires_in: 2592000 } },
      now: () => 1_000_000,
    }
    expect(await getUberAppToken(deps)).toBe('tok-1')
    expect(await getUberAppToken(deps)).toBe('tok-1')
    expect(calls).toBe(1)
  })

  it('single-flight: N llamadas concurrentes ⇒ UNA sola petición', async () => {
    let calls = 0
    const deps = {
      fetchToken: async () => { calls++; await new Promise(r => setTimeout(r, 10)); return { access_token: 'tok', expires_in: 2592000 } },
    }
    const [a, b, c] = await Promise.all([getUberAppToken(deps), getUberAppToken(deps), getUberAppToken(deps)])
    expect(calls).toBe(1)
    expect(a).toBe('tok'); expect(b).toBe('tok'); expect(c).toBe('tok')
  })

  it('renueva ANTICIPADO: a 24h del vencimiento pide uno nuevo', async () => {
    let calls = 0
    let t = 1_000_000_000 // ms
    const deps = {
      fetchToken: async () => { calls++; return { access_token: `tok-${calls}`, expires_in: 2592000 } },
      now: () => t,
    }
    await getUberAppToken(deps)
    t += (2592000 - 23 * 3600) * 1000 // faltan 23h < margen de 24h
    expect(await getUberAppToken(deps)).toBe('tok-2')
    expect(calls).toBe(2)
  })

  it('respuesta inválida del proveedor ⇒ rechaza y NO la cachea', async () => {
    let calls = 0
    const deps = { fetchToken: async () => { calls++; return { access_token: '', expires_in: 2592000 } } }
    await expect(getUberAppToken(deps)).rejects.toThrow('inválida')
    await expect(getUberAppToken(deps)).rejects.toThrow('inválida')
    expect(calls).toBe(2)
  })

  it('si la petición falla, la siguiente REINTENTA (no cachea el error)', async () => {
    let calls = 0
    const deps = {
      fetchToken: async () => { calls++; if (calls === 1) throw new Error('red'); return { access_token: 'tok-ok', expires_in: 2592000 } },
    }
    await expect(getUberAppToken(deps)).rejects.toThrow('red')
    expect(await getUberAppToken(deps)).toBe('tok-ok')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --selectProjects unit --testPathPattern "uberToken"`
Expected: FAIL — "Cannot find module .../uber.token"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/services/delivery-channels/providers/uber-eats/uber.token.ts
/**
 * Token de aplicación de Uber (client_credentials) — spec paso 2.
 * [api] expires_in = 2592000 s (30 días). [doc] 100 tokens/hora y el 101º
 * invalida el más viejo ⇒ NUNCA pedir en paralelo ni por request: cache en
 * memoria con single-flight y renovación anticipada de 24 h.
 * Módulo puro: el caller inyecta fetchToken (que es quien lee env/URLs).
 */
export interface UberTokenDeps {
  fetchToken: () => Promise<{ access_token: string; expires_in: number }>
  now?: () => number
}

const RENEW_MARGIN_MS = 24 * 3600 * 1000

let cached: { token: string; expiresAtMs: number } | null = null
let inflight: Promise<string> | null = null
let generation = 0 // sube en cada reset: una petición vieja no puede cachear tras un reset

export function _resetUberTokenCacheForTests(): void {
  cached = null
  inflight = null
  generation++
}

export async function getUberAppToken(deps: UberTokenDeps): Promise<string> {
  const now = deps.now ?? Date.now
  if (cached && cached.expiresAtMs - now() > RENEW_MARGIN_MS) return cached.token
  if (inflight) return inflight
  const gen = generation
  const request = (async () => {
    const r = await deps.fetchToken()
    // Nunca cachear basura del proveedor: token vacío o expires_in inválido ⇒ error visible
    if (!r || typeof r.access_token !== 'string' || r.access_token.length === 0 || !Number.isFinite(r.expires_in) || r.expires_in <= 0) {
      throw new Error('Respuesta de token de Uber inválida (access_token/expires_in)')
    }
    if (gen === generation) cached = { token: r.access_token, expiresAtMs: now() + r.expires_in * 1000 }
    return r.access_token
  })()
  inflight = request
  try {
    return await request
  } finally {
    // Solo limpiar SI seguimos siendo el dueño: un finally incondicional borraría
    // el inflight de una petición nueva tras un reset (bug señalado por auditoría)
    if (inflight === request) inflight = null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --selectProjects unit --testPathPattern "uberToken"`
Expected: PASS — 5 passed

- [ ] **Step 5: Verificar que COMPILA** (jest/ts-jest es transpile-only y un verde no lo prueba — regla del repo)

Run: `npm run build`
Expected: exit 0

- [ ] **Step 6: NO commit** (regla del repo: pedir permiso al founder; reportar "Task 1 verde")

---

### Task 2: Verificación de firma del webhook (módulo puro)

**Files:**
- Create: `src/services/delivery-channels/providers/uber-eats/uber.signature.ts`
- Test: `tests/unit/services/delivery-channels/uberSignature.test.ts`

**Interfaces:**
- Consumes: nada
- Produces: `verifyUberSignature(rawBody: Buffer, headerValue: string | undefined, signingKey: string): boolean`. La consume Task 3 (controller).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/services/delivery-channels/uberSignature.test.ts
import crypto from 'crypto'
import { verifyUberSignature } from '@/services/delivery-channels/providers/uber-eats/uber.signature'

// [supuesto declarado en la spec]: header X-Uber-Signature = HMAC-SHA256 hex
// minúsculas del body crudo. La LLAVE está en disputa (dashboard: Signing Key;
// doc: client secret) ⇒ el módulo recibe la llave por parámetro y NO decide.
describe('uber.signature', () => {
  const KEY = 'k-de-prueba'
  const body = Buffer.from(JSON.stringify({ event_id: 'e1' }))
  const firma = (b: Buffer, k: string) => crypto.createHmac('sha256', k).update(b).digest('hex')

  it('acepta la firma correcta (hex minúsculas)', () => {
    expect(verifyUberSignature(body, firma(body, KEY), KEY)).toBe(true)
  })
  it('rechaza firma de otra llave, header ausente, vacío o longitud inválida', () => {
    expect(verifyUberSignature(body, firma(body, 'otra'), KEY)).toBe(false)
    expect(verifyUberSignature(body, undefined, KEY)).toBe(false)
    expect(verifyUberSignature(body, '', KEY)).toBe(false)
    expect(verifyUberSignature(body, 'abc123', KEY)).toBe(false) // ≠ 64 hex
    expect(verifyUberSignature(body, 'z'.repeat(64), KEY)).toBe(false) // 64 chars pero no-hex
    expect(verifyUberSignature(body, firma(body, KEY), '')).toBe(false) // llave vacía
    expect(verifyUberSignature('no-buffer' as unknown as Buffer, firma(body, KEY), KEY)).toBe(false)
  })
  it('acepta hex en MAYÚSCULAS normalizando (no falla por casing)', () => {
    expect(verifyUberSignature(body, firma(body, KEY).toUpperCase(), KEY)).toBe(true)
  })
  it('un byte distinto en el body ⇒ rechaza', () => {
    const otro = Buffer.from(JSON.stringify({ event_id: 'e2' }))
    expect(verifyUberSignature(otro, firma(body, KEY), KEY)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --selectProjects unit --testPathPattern "uberSignature"`
Expected: FAIL — módulo inexistente

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/services/delivery-channels/providers/uber-eats/uber.signature.ts
/**
 * X-Uber-Signature — HMAC-SHA256 hex del body CRUDO (spec paso 3).
 * timingSafeEqual tras validar longitud (mismo patrón que deliverect.hmac.ts,
 * que NO se toca). La llave llega por parámetro: su origen (Signing Key vs
 * client secret) es un supuesto abierto que resuelve el primer webhook real.
 */
import crypto from 'crypto'

export function verifyUberSignature(rawBody: Buffer, headerValue: string | undefined, signingKey: string): boolean {
  if (!headerValue || !signingKey || !Buffer.isBuffer(rawBody)) return false
  const esperado = crypto.createHmac('sha256', signingKey).update(rawBody).digest('hex')
  const recibido = headerValue.trim().toLowerCase()
  if (recibido.length !== esperado.length || !/^[0-9a-f]{64}$/.test(recibido)) return false
  return crypto.timingSafeEqual(Buffer.from(recibido, 'hex'), Buffer.from(esperado, 'hex'))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --selectProjects unit --testPathPattern "uberSignature"`
Expected: PASS — 4 passed

- [ ] **Step 5: Verificar que COMPILA**

Run: `npm run build`
Expected: exit 0

- [ ] **Step 6: NO commit** — reportar "Task 2 verde"

---

### Task 3 (SIGUIENTE SESIÓN — requiere migración): ruta webhook + evento durable

Pendiente de detallar con el mismo formato ANTES de ejecutarse (auditoría Codex 2026-08-17:
tal como estaba esbozada no era ejecutable). Requisitos que el detalle DEBE incluir:

- Migración aditiva a `DeliveryOrderEvent`: `externalOrderId`, `dedupKey @unique`, **y también
  `claimToken` + `lockedUntil`** (contrato recuperable de la spec §7 — el esbozo los omitía)
- `UBER_WEBHOOK_SIGNING_KEY` en la env TIPADA (`src/config/env.ts` + `.env.example`): está en el
  `.env` local pero NO en el schema Zod — sin esto el server ni arranca con la var
- `npm run schema:map` + `docs/SCHEMA_MAP.md` en el MISMO cambio (critical-warnings.md)
- Controller: `res.status(200).end()` — NUNCA `sendStatus(200)`, que manda body "OK" y Uber
  espera body VACÍO
- 🔴 La prueba durable vive en el proyecto **integration** con PostgreSQL real
  (TEST_DATABASE_URL): `unit` y `api-tests` mockean Prisma globalmente (`setup.ts:361`), así
  que ahí el unique de dedup NO se prueba de verdad. ngrok queda como smoke manual, no como
  prueba automatizada
- Tests mínimos: tienda desconocida ⇒ fila con tenant/link nulos + 200 vacío · dos POST
  concurrentes con el mismo `event_id` ⇒ UNA fila
- 🔴 NO reutilizar `deliveryWebhookEvent.service.ts` (su contrato exige `channelLinkId`
  conocido y deduplica con semántica Deliverect — Deliverect congelado)
- `prisma migrate dev` con el founder presente

## Self-Review

- Cobertura: paso 2 **PARCIAL** (Task 1 = solo caché; adaptador HTTP real → Plan 2) · paso 3 firma (Task 2) ✓ · paso 3 persistencia (Task 3: requisitos fijados, detalle antes de ejecutar)
- Sin placeholders en Tasks 1-2; Task 3 declarada explícitamente como pendiente de detalle (no es TBD oculto: es corte de alcance)
- Tipos consistentes: `UberTokenDeps` producido/consumido coherente; `verifyUberSignature` firma única
