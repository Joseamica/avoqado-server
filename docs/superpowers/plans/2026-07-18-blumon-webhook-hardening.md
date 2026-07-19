# Blumon Webhook Hardening — Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Endurecer el pipeline de webhooks Blumon TPV para que ningún cargo se atribuya al Payment equivocado, ningún evento se pierda sin persistir, y los reversos no generen falsas alarmas — los fixes P0/P1 del spec `avoqado-tpv/docs/superpowers/specs/2026-07-17-libreta-write-ahead-design.md` §5, independientes de la libreta.

**Architecture:** Todos los cambios viven en el pipeline TPV de Blumon (2 archivos existentes + 1 job nuevo): `src/services/tpv/blumon-webhook.service.ts` (932 líneas), `src/controllers/tpv/blumon-webhook.tpv.controller.ts`, `src/jobs/blumon-payment-audit.job.ts` (nuevo). Cero cambios a cómo se ESCRIBEN Payments; solo matching / ACK / clasificación / auditoría.

**Tech Stack:** TypeScript + Express + Prisma (Postgres) + Jest (`tests/unit/services/tpv/`). Jobs con `cron` (patrón `blumon-webhook-reconciliation.job.ts`, arrancados desde `src/server.ts`).

---

## Changelog v1 → v2 (por qué NO se debe ejecutar el v1)

El v1 quedó obsoleto tras la auditoría cruzada del 2026-07-18. Cambios:

1. **Matching por tiers con monto en las llaves débiles** (Task 2, reescrita). El v1 mantenía un solo `OR` gigante. **Verificado en prod:** las llaves débiles NO son únicas (evidencia abajo), y el monto se compara DESPUÉS de elegir candidato — no protege.
2. **Referencia parcial: JAMÁS auto-match** (antes podía ligar).
3. **Payload sin llave → `ERROR` + `NO_MATCH_FIELDS` + alerta** (el v1 lo dejaba `PENDING` eterno: sin llave nunca habrá match, el cron lo reintenta para siempre).
4. **Reversos: `PROCESSED` + `errorReason='REVERSAL_UNMATCHED'`** (el v1 los marcaba `PROCESSED` a secas → desaparecían de toda vista de "no conciliado").
5. **Validador acepta `operationNumber`** (hoy `:926` lo rechaza — es la llave MÁS fuerte).
6. **`eventId`: VENTA queda BYTE-IDÉNTICO**, sólo los reversos reciben prefijo propio.
7. **Deploy: Render, no Fly.io** (verificado `render.yaml:78-86`, branch `main`, `NODE_ENV=production`).
8. **`git add -A` → rutas explícitas** (el working tree tiene archivos sueltos ajenos al plan).
9. **XFF / IP-whitelist FUERA DE ALCANCE** (ver Global Constraints).

## Evidencia empírica que fundamenta la Task 2 (consultada en prod 2026-07-18)

| Hallazgo | Dato real |
|---|---|
| `referenceNumber` **es un timestamp a segundos**, no un id único | `260717220609` = `yyMMddHHmmss` (17-07-26 22:06:09), 12 dígitos |
| El `contains` del **último-10** (`:650`) **ya colisiona en prod** | 8+ pares distintos, cada uno con **2 montos diferentes** |
| Los **auth codes colisionan** (6 dígitos del emisor, se reciclan) | `000683`, `001982`, `006551`… cada uno 2× con **2 montos diferentes** |
| El monto **no protege** de una mala elección | Se compara en `:776-777`, **después** de elegir; y **ambas ramas escriben** sobre ese Payment (`:792` MATCHED, `:829` DISCREPANCY) |

⇒ El monto debe ser parte de la **llave de selección** en los tiers débiles, no un check posterior.

## Global Constraints

- **El webhook JAMÁS crea un Payment** (match-only; spec §3). Ninguna tarea introduce `payment.create`.
- Radio de impacto verificado 2026-07-18: `blumon-webhook.service.ts` solo lo importan el controller TPV, el job de reconciliación y `payment.tpv.service.ts`. No tocar Stripe/MercadoPago/dashboard/checkout.
- **No introducir imports nuevos en `blumon-webhook.service.ts`.** Sus imports son `prisma`, `@prisma/client`, `logger`, `@/lib/venueStatus.constants`. Importar `payment.tpv.service.ts` crearía un **ciclo** (ese archivo importa a éste). El `merchantAccountId` se obtiene de `resolveScopeVenueIdsFromBlumonSerial`, que ya consulta `merchantAccount.findFirst` en `:121-122`.
- `Payment.processorId` NO se toca (lo leen b4bit/paymentLink/qrPayments/venueCheckout) — el op-number se matchea leyendo `processorData` JSON (condición **aditiva**, la de `processorId` se conserva).
- `WebhookProcessingResult.action` solo crece de forma aditiva (nunca renombrar valores existentes — el controller y el job hacen switch sobre ellos).
- `ProviderEventLog` tiene `@@unique([provider, eventId])` (schema.prisma:4418) — los reintentos de Blumon tras un 503 son idempotentes.
- `EventStatus` sólo admite `PENDING | PROCESSED | ERROR` (schema.prisma:6452). **Ninguna tarea agrega valores al enum** (evita migración); la granularidad extra vive en `errorReason` (String libre) y en `type` (String, ya poblado desde `payload.operationType`).
- Tests: Jest, mocks de `@/utils/prismaClient` (patrón exacto de `tests/unit/services/tpv/blumon-webhook.service.test.ts:1-18`). Correr con `npx jest tests/unit/services/tpv/ --maxWorkers=2`.
- Compilación: `npx tsc --noEmit` debe pasar tras cada tarea.
- **PCI:** ningún log nuevo imprime PAN completo. `lastFour` sí (permitido); nunca el número completo.
- **Commits:** el founder exige permiso explícito. Al INICIAR la ejecución, pedir una sola vez: "¿autorizas los commits locales de este plan?". **Usar SIEMPRE rutas explícitas — NUNCA `git add -A`** (hay archivos sueltos sin relación, p.ej. `scripts/seed-la-ribera-demo.ts`). Sin `Co-Authored-By`. Push sólo con permiso aparte.
- **Deploy: Render** (`render.yaml:78-86` → branch `main`, `NODE_ENV=production`). SOLO tras GO explícito del founder — fuera de este plan.

### 🚫 FUERA DE ALCANCE — X-Forwarded-For / IP whitelist (tarea de ops aparte)

**No tocar `src/middlewares/blumon-ip-whitelist.middleware.ts` en este plan.** Verificado 2026-07-18: el middleware **bloquea con 403** (no es warn-only), **está cableado** (`webhook.routes.ts:147`), corre **activo en prod** (`NODE_ENV=production`), y su allowlist **sólo contiene la IP de sandbox** (`3.132.184.158`; prod = "TBD"). Los webhooks de prod pasan hoy porque `getClientIP` lee `X-Forwarded-For[0]`.

Render enruta todo por Cloudflare + su balanceador, y Express con `trust proxy=1` (`middleware.ts:13`) evalúa desde la derecha ⇒ **`req.ip` devolvería el edge, no Blumon** ⇒ riesgo real de **403 a todos los webhooks**. Eso NO tumbaría cobros (la autorización ocurre en el SDK de la terminal) pero **sí la recepción y la conciliación**, generando huérfanos en masa — justo lo que este plan busca evitar.

Secuencia correcta, como tarea separada: (1) loguear temporalmente `req.ip`, `req.ips`, `req.socket.remoteAddress`, el `X-Forwarded-For` completo, `CF-Connecting-IP` y `CF-Ray` de **un webhook real**; (2) confirmar IPs/CIDR con Blumon (Edgardo); (3) recién entonces ajustar la confianza de proxies y el allowlist. **HMAC es el fix real de autenticidad** y va aparte.

---

### Task 1: Excluir REFUNDs del matching de ventas

Un webhook de VENTA hoy puede casar contra un Payment tipo REFUND (comparten `referenceNumber` con el original). El patrón del fix ya existe en el repo (`payment.tpv.service.ts:1413,2191`).

**Files:**
- Modify: `src/services/tpv/blumon-webhook.service.ts` (objeto `baseWhere`, hoy `:699-704`)
- Test: `tests/unit/services/tpv/blumon-webhook.matching.test.ts` (nuevo archivo)

**Interfaces:**
- Consumes: `reconcileBlumonEvent(eventLogId, payload, {scopeVenueIds})` (export existente `:489`)
- Produces: el scope de búsqueda gana `type: { not: 'REFUND' }`. Ningún cambio de firma. Task 2 hereda este filtro dentro de `scopeWhere`.

- [ ] **Step 1: Escribir el test que falla**

```typescript
// tests/unit/services/tpv/blumon-webhook.matching.test.ts
import { reconcileBlumonEvent } from '@/services/tpv/blumon-webhook.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    payment: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    providerEventLog: { update: jest.fn() },
    merchantAccount: { findFirst: jest.fn() },
    terminal: { findFirst: jest.fn() },
    venue: { findMany: jest.fn() },
  },
}))

export const mockedFindFirst = prisma.payment.findFirst as jest.Mock
export const mockedFindMany = prisma.payment.findMany as jest.Mock
export const mockedPaymentUpdate = prisma.payment.update as jest.Mock
export const mockedEventLogUpdate = prisma.providerEventLog.update as jest.Mock

export const ventaPayload = {
  amount: '100.00',
  reference: '260718120000',
  operationNumber: 99000001,
  authorizationCode: 'AUTH99',
  operationType: 'VENTA',
  codeResponse: '00',
} as any

beforeEach(() => {
  ;[mockedFindFirst, mockedFindMany, mockedPaymentUpdate, mockedEventLogUpdate].forEach(m => m.mockReset())
  mockedPaymentUpdate.mockResolvedValue({})
  mockedEventLogUpdate.mockResolvedValue({})
  mockedFindFirst.mockResolvedValue(null)
  mockedFindMany.mockResolvedValue([])
})

describe('Task 1 — VENTA matching excludes REFUND payments', () => {
  it('every search WHERE excludes type REFUND', async () => {
    await reconcileBlumonEvent('evt_t1', ventaPayload, { scopeVenueIds: ['venue_1'] })
    const call = mockedFindMany.mock.calls[0] ?? mockedFindFirst.mock.calls[0]
    expect(call).toBeDefined()
    expect(call[0].where).toEqual(expect.objectContaining({ type: { not: 'REFUND' } }))
  })
})
```

- [ ] **Step 2: Correr el test — debe FALLAR**

Run: `npx jest tests/unit/services/tpv/blumon-webhook.matching.test.ts -t "excludes type REFUND" --maxWorkers=1`
Expected: FAIL — el `where` actual no contiene `type: { not: 'REFUND' }`.

- [ ] **Step 3: Implementación mínima** — en `attemptPaymentMatch`, el `baseWhere` (`:699-704`):

```typescript
    const baseWhere: Prisma.PaymentWhereInput = {
      OR: matchConditions,
      status: { in: ['COMPLETED', 'PENDING'] },
      // Refunds share referenceNumber with their originals — a VENTA webhook must
      // never confirm/annotate a REFUND row (same guard as payment.tpv.service.ts:1413).
      type: { not: 'REFUND' },
      ...(scopeVenueIds.length > 0 ? { order: { venueId: { in: scopeVenueIds } } } : {}),
    }
```

- [ ] **Step 4: Correr el test — debe PASAR.** Correr también `npx jest tests/unit/services/tpv/blumon-webhook.service.test.ts --maxWorkers=1` → PASS (el cambio es aditivo).

- [ ] **Step 5: Commit**

```bash
git add src/services/tpv/blumon-webhook.service.ts tests/unit/services/tpv/blumon-webhook.matching.test.ts
git commit -m "fix(blumon-webhook): exclude REFUND payments from VENTA matching"
```

---

### Task 2: Matching determinista por tiers (monto en las llaves débiles) + scope obligatorio + cuarentena

Reemplaza el `OR` único por tiers ordenados. Reglas (mínimo seguro):

| Tier | Llave | Auto-match |
|---|---|---|
| A `OP_NUMBER` | `operationNumber` (JSON + legacy) + merchant/venue exacto | ✅ (el monto se sigue verificando después → MATCHED/DISCREPANCY, como hoy) |
| B `REFERENCE_EXACT` | referencia **exacta** + scope + **monto** | ✅ si hay exactamente 1 |
| C `AUTH_CODE` | auth code + **monto** + scope | ✅ si hay exactamente 1 — **nunca auth solo** |
| D `REFERENCE_PARTIAL` | `contains` último-10 | ❌ **JAMÁS** — sólo reporta candidatos |

≥2 candidatos en cualquier tier ⇒ `AMBIGUOUS` (cuarentena, nunca auto-ligar). Scope vacío ⇒ `PENDING` sin buscar.

**Files:**
- Modify: `src/services/tpv/blumon-webhook.service.ts` (`resolveScopeVenueIdsFromBlumonSerial` `:116-140` y sus 2 call sites `:343`/`:495`; action union `:262-283`; `BLUMON_WEBHOOK_ERROR_REASONS` `:34-48`; `matchConditions`/`baseWhere` `:644-704`; retry-loop `:705-750`; `updateEventLogFromMatchResult` `:579-610`)
- Test: `tests/unit/services/tpv/blumon-webhook.matching.test.ts` (ampliar)

**Interfaces:**
- Produces: actions nuevas `'AMBIGUOUS'` y `'NO_AUTO_MATCH'`; errorReasons nuevos `AMBIGUOUS_MATCH`, `WEAK_MATCH_ONLY`. `resolveScopeVenueIdsFromBlumonSerial` pasa a devolver `{ venueIds: string[]; merchantAccountId: string | null }`. La búsqueda pasa de `findFirst` a `findMany` por tier. Tasks 3/5/6 asumen estos nombres EXACTOS.

- [ ] **Step 1: Tests que fallan**

```typescript
const candidate = (id: string, amount: number, tip = 0) => ({
  id, amount, tipAmount: tip, processorData: null,
  order: { id: 'o1', orderNumber: 1, venueId: 'venue_1', venue: { id: 'venue_1', name: 'V', status: 'ACTIVE' } },
})

describe('Task 2 — deterministic tiered matching', () => {
  it('empty venue scope → PENDING without searching', async () => {
    const result = await reconcileBlumonEvent('evt_t2a', ventaPayload, { scopeVenueIds: [] })
    expect(result.action).toBe('PENDING')
    expect(mockedFindMany).not.toHaveBeenCalled()
  })

  it('two candidates in a tier → AMBIGUOUS, never auto-links', async () => {
    mockedFindMany.mockResolvedValue([candidate('pay_a', 100), candidate('pay_b', 100)])
    const result = await reconcileBlumonEvent('evt_t2b', ventaPayload, { scopeVenueIds: ['venue_1'] })
    expect(result.action).toBe('AMBIGUOUS')
    expect(mockedPaymentUpdate).not.toHaveBeenCalled()
    expect(mockedEventLogUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ errorReason: 'AMBIGUOUS_MATCH' }) }),
    )
  })

  it('exactly one candidate still matches (regression)', async () => {
    mockedFindMany.mockResolvedValue([candidate('pay_one', 100)])
    const result = await reconcileBlumonEvent('evt_t2c', ventaPayload, { scopeVenueIds: ['venue_1'] })
    expect(['MATCHED', 'RECONCILED']).toContain(result.action)
    expect(result.paymentId).toBe('pay_one')
  })

  it('weak tier (partial reference) NEVER auto-links even with a single candidate', async () => {
    const onlyPartial = { amount: '100.00', reference: '260718120000', operationType: 'VENTA', codeResponse: '00' } as any
    // tiers A/B/C find nothing; the partial tier finds exactly one
    mockedFindMany
      .mockResolvedValueOnce([])                       // REFERENCE_EXACT
      .mockResolvedValueOnce([candidate('pay_weak', 100)]) // REFERENCE_PARTIAL
    const result = await reconcileBlumonEvent('evt_t2d', onlyPartial, { scopeVenueIds: ['venue_1'] })
    expect(result.action).toBe('NO_AUTO_MATCH')
    expect(mockedPaymentUpdate).not.toHaveBeenCalled()
  })

  it('amount is part of the KEY in weak tiers — wrong amount is not selected', async () => {
    const refOnly = { amount: '100.00', reference: '260718120000', operationType: 'VENTA', codeResponse: '00' } as any
    mockedFindMany.mockResolvedValue([candidate('pay_wrong_amount', 999)])
    const result = await reconcileBlumonEvent('evt_t2e', refOnly, { scopeVenueIds: ['venue_1'] })
    expect(['PENDING', 'NO_AUTO_MATCH']).toContain(result.action)
    expect(result.paymentId).toBeUndefined()
  })
})
```

- [ ] **Step 2: Correr — FALLAN.**

- [ ] **Step 3: Implementación**

(a) Action union (`:262-283`) — aditivo:

```typescript
    | 'AMBIGUOUS' // 2+ Payment candidates matched — quarantined, NEVER auto-linked
    | 'NO_AUTO_MATCH' // only weak-key candidates (partial reference) — human attribution required
```

(b) `BLUMON_WEBHOOK_ERROR_REASONS` (`:34-48`):

```typescript
  /** 2+ Payments matched the webhook keys — requires human attribution */
  AMBIGUOUS_MATCH: 'AMBIGUOUS_MATCH',
  /** Only a weak key (partial reference) matched — never auto-linked */
  WEAK_MATCH_ONLY: 'WEAK_MATCH_ONLY',
```

(c) `resolveScopeVenueIdsFromBlumonSerial` (`:116-140`) — devolver también el merchant. El `merchantAccount` ya se consulta en `:121-122`; sólo se propaga:

```typescript
): Promise<{ venueIds: string[]; merchantAccountId: string | null }> {
  // ... cuerpo existente sin cambios ...
  // Cada `return [...]` existente pasa a `return { venueIds: [...], merchantAccountId: merchantAccount?.id ?? null }`
}
```

Actualizar los **2 call sites**: `:343` (dentro del `Promise.all`) y `:495`. Ejemplo `:343`:

```typescript
    const [terminal, scope] = await Promise.all([...])
    const scopeVenueIds = scope.venueIds
    const merchantAccountId = scope.merchantAccountId
```

y pasar `merchantAccountId` en el ctx de `attemptPaymentMatch` (`:453`) y de `reconcileBlumonEvent` (`:495`).

(d) En `attemptPaymentMatch`, **reemplazar** el bloque `matchConditions` + `baseWhere` + `findFirst` (`:644-750`) por tiers:

```typescript
    // ── Tiered, deterministic matching (audit 2026-07-18) ───────────────────
    // WHY tiers and not one big OR: the weak keys are NOT unique in production.
    // `referenceNumber` is a timestamp to the second (yyMMddHHmmss, e.g.
    // 260717220609) and 6-digit issuer auth codes recycle — both collide TODAY
    // with DIFFERENT amounts. And the amount is only compared AFTER a candidate
    // is chosen, where BOTH branches write to that Payment (:792 / :829) — so a
    // wrong pick is never caught. Hence: the amount is part of the KEY in the
    // weak tiers, and a partial reference NEVER auto-links.
    if (scopeVenueIds.length === 0) {
      return {
        success: false,
        action: 'PENDING',
        message: 'No venue scope resolved for serial — matching deferred',
        details: { blumonAmount },
      }
    }

    const scopeWhere: Prisma.PaymentWhereInput = {
      status: { in: ['COMPLETED', 'PENDING'] },
      type: { not: 'REFUND' },
      ...(merchantAccountId ? { merchantAccountId } : {}),
      order: { venueId: { in: scopeVenueIds } },
    }

    type MatchTier = {
      name: 'OP_NUMBER' | 'REFERENCE_EXACT' | 'AUTH_CODE' | 'REFERENCE_PARTIAL'
      where: Prisma.PaymentWhereInput
      autoLink: boolean
      requireAmount: boolean
    }

    const tiers: MatchTier[] = []
    if (payload.operationNumber != null) {
      tiers.push({
        name: 'OP_NUMBER',
        where: {
          ...scopeWhere,
          OR: [
            { processorId: payload.operationNumber.toString() },
            // The REAL home of the Blumon operation number is the JSON the TPV
            // records. processorId is legacy-Menta and read by other domains —
            // match the JSON, don't repurpose the column.
            { processorData: { path: ['blumonOperationNumber'], equals: payload.operationNumber } },
          ],
        },
        autoLink: true,
        requireAmount: false,
      })
    }
    if (payload.reference) {
      tiers.push({ name: 'REFERENCE_EXACT', where: { ...scopeWhere, referenceNumber: payload.reference }, autoLink: true, requireAmount: true })
    }
    if (payload.authorizationCode) {
      tiers.push({ name: 'AUTH_CODE', where: { ...scopeWhere, authorizationNumber: payload.authorizationCode }, autoLink: true, requireAmount: true })
    }
    if (payload.reference && payload.reference.length >= 10) {
      tiers.push({ name: 'REFERENCE_PARTIAL', where: { ...scopeWhere, referenceNumber: { contains: payload.reference.slice(-10) } }, autoLink: false, requireAmount: true })
    }

    if (tiers.length === 0) {
      // handled by Task 3 (keyless payload)
      return {
        success: false,
        action: 'ERROR',
        message: 'No fields available for payment matching',
        details: { blumonAmount },
      }
    }

    // Tip-aware comparison — Blumon charges base+tip (prod fix 2026-06-24:
    // 67/67 historical "discrepancies" were exactly the tip).
    const amountMatches = (p: { amount: unknown; tipAmount: unknown }): boolean =>
      Math.abs(blumonAmount - (parseFloat(String(p.amount)) + parseFloat(String(p.tipAmount ?? 0)))) < 0.01

    const paymentInclude = {
      order: {
        select: {
          id: true, orderNumber: true, venueId: true,
          venue: { select: { id: true, name: true, status: true } },
        },
      },
    }

    type TierOutcome =
      | { kind: 'match'; payment: any; tier: string }
      | { kind: 'ambiguous'; tier: string; ids: string[] }
      | { kind: 'weak'; tier: string; ids: string[] }
      | { kind: 'none' }

    const resolveTiers = async (): Promise<TierOutcome> => {
      for (const tier of tiers) {
        const found = await prisma.payment.findMany({
          where: tier.where,
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: paymentInclude,
        })
        const viable = tier.requireAmount ? found.filter(amountMatches) : found
        if (viable.length === 0) continue
        if (viable.length >= 2) return { kind: 'ambiguous', tier: tier.name, ids: viable.map(v => v.id) }
        if (!tier.autoLink) return { kind: 'weak', tier: tier.name, ids: viable.map(v => v.id) }
        return { kind: 'match', payment: viable[0], tier: tier.name }
      }
      return { kind: 'none' }
    }
```

Dentro del retry-loop existente, sustituir el `findFirst` por `resolveTiers()` y manejar los desenlaces:

```typescript
      const outcome = await resolveTiers()

      if (outcome.kind === 'ambiguous') {
        logger.error('🚨 Blumon webhook: AMBIGUOUS match — quarantining, never auto-linking', {
          correlationId, tier: outcome.tier, reference: payload.reference,
          operationNumber: payload.operationNumber, candidateIds: outcome.ids,
        })
        return { success: false, action: 'AMBIGUOUS', message: `Multiple Payment candidates in tier ${outcome.tier} — requires human attribution`, details: { blumonAmount } }
      }
      if (outcome.kind === 'weak') {
        logger.error('🚨 Blumon webhook: only a WEAK key matched — not auto-linking', {
          correlationId, tier: outcome.tier, reference: payload.reference, candidateIds: outcome.ids,
        })
        return { success: false, action: 'NO_AUTO_MATCH', message: `Only weak-key candidates (${outcome.tier}) — requires human attribution`, details: { blumonAmount } }
      }
      payment = outcome.kind === 'match' ? outcome.payment : null
```

(e) `updateEventLogFromMatchResult` (`:579-610`) — casos nuevos:

```typescript
    case 'AMBIGUOUS':
      data.status = EventStatus.ERROR
      data.errorReason = BLUMON_WEBHOOK_ERROR_REASONS.AMBIGUOUS_MATCH
      data.processedAt = new Date()
      break
    case 'NO_AUTO_MATCH':
      data.status = EventStatus.ERROR
      data.errorReason = BLUMON_WEBHOOK_ERROR_REASONS.WEAK_MATCH_ONLY
      data.processedAt = new Date()
      break
```

- [ ] **Step 4: Correr los 5 tests nuevos + la suite existente completa del webhook** → PASS. Si algún test existente mockeaba `findFirst`, migrar el mock a `findMany` (mismo dato envuelto en `[...]`) — cambio mecánico.

- [ ] **Step 5: `npx tsc --noEmit`** → sin errores.

- [ ] **Step 6: Commit**

```bash
git add src/services/tpv/blumon-webhook.service.ts tests/unit/services/tpv/blumon-webhook.matching.test.ts
git commit -m "fix(blumon-webhook): deterministic tiered matching with amount in weak keys; quarantine ambiguity; never auto-link partial reference"
```

---

### Task 3: El validador acepta `operationNumber` + payload sin llave alerta (no PENDING eterno)

`:926` exige `lastFour | authorizationCode | reference` — **rechaza `operationNumber`, que es la llave MÁS fuerte**. Y un payload sin ninguna llave no puede casar JAMÁS: dejarlo `PENDING` es un reintento infinito del cron. Debe ser `ERROR` + `NO_MATCH_FIELDS` + alerta visible.

**Files:**
- Modify: `src/services/tpv/blumon-webhook.service.ts` (`:926` validador; el early-return de tiers vacíos de Task 2)
- Test: `tests/unit/services/tpv/blumon-webhook.matching.test.ts` (ampliar)

**Interfaces:**
- Produces: `hasCardIdentifier` acepta `operationNumber`. Payload sin llave ⇒ `action:'ERROR'` + `errorReason: NO_MATCH_FIELDS` (constante existente `:37`).

- [ ] **Step 1: Tests que fallan**

```typescript
import { validateBlumonWebhookPayload } from '@/services/tpv/blumon-webhook.service'

describe('Task 3 — operationNumber is a valid identifier; keyless alerts', () => {
  it('a payload identified ONLY by operationNumber is accepted', () => {
    const p = { amount: '100.00', operationNumber: 99000001, operationType: 'VENTA', codeResponse: '00' }
    expect(validateBlumonWebhookPayload(p as any).valid).toBe(true)
  })

  it('payload with NO matchable key → ERROR + NO_MATCH_FIELDS (not eternal PENDING)', async () => {
    const keyless = { amount: '50.00', operationType: 'VENTA', codeResponse: '00' } as any
    const result = await reconcileBlumonEvent('evt_t3b', keyless, { scopeVenueIds: ['venue_1'] })
    expect(result.action).toBe('ERROR')
    expect(mockedEventLogUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ errorReason: 'NO_MATCH_FIELDS' }) }),
    )
  })
})
```

Nota: confirmar el nombre real del validador exportado con `grep -n "export function validate" src/services/tpv/blumon-webhook.service.ts` y usar ese nombre en el test.

- [ ] **Step 2: Correr — FALLAN.**

- [ ] **Step 3: Implementación** — en el validador (`:926`):

```typescript
  // operationNumber is Blumon's strongest per-transaction key — it was missing
  // here, so payloads identified only by it were rejected outright.
  const hasCardIdentifier =
    'lastFour' in p || 'authorizationCode' in p || 'reference' in p || 'operationNumber' in p
```

Y en `updateEventLogFromMatchResult`, asegurar que el `case 'ERROR'` fije `errorReason` con `BLUMON_WEBHOOK_ERROR_REASONS.NO_MATCH_FIELDS` cuando el mensaje provenga del early-return de tiers vacíos; además log de alerta:

```typescript
      logger.error('🚨 [Blumon webhook] Payload with NO matchable key — manual review required', {
        correlationId, amount: blumonAmount, operationType: payload.operationType,
      })
```

- [ ] **Step 4: Tests nuevos + suite completa webhook → PASS. `npx tsc --noEmit` limpio.**

- [ ] **Step 5: Commit**

```bash
git add src/services/tpv/blumon-webhook.service.ts tests/unit/services/tpv/blumon-webhook.matching.test.ts
git commit -m "fix(blumon-webhook): accept operationNumber as identifier; keyless payloads alert instead of retrying forever"
```

---

### Task 4: ACK sólo tras persistencia durable

Hoy el catch del controller responde **200** ("Still return 200 to prevent Blumon from retrying") — una excepción ANTES de persistir pierde el evento para siempre **con acuse de recibo**. Con `@@unique([provider,eventId])` los reintentos son idempotentes: el fix correcto es 503. **Acotado:** sólo errores transitorios se vuelven reintentables; no se barre nada existente a ERROR.

**Files:**
- Modify: `src/controllers/tpv/blumon-webhook.tpv.controller.ts` (bloque try/catch `~:120-152`)
- Test: `tests/unit/controllers/tpv/blumon-webhook.controller.ack.test.ts` (nuevo)

**Interfaces:**
- Produces: regla de ACK — `200` ⟺ `result.eventLogId` presente; si falta o hay excepción ⇒ `503`. El `400` de payload inválido se conserva.

- [ ] **Step 1: Test que falla**

```typescript
// tests/unit/controllers/tpv/blumon-webhook.controller.ack.test.ts
import * as svc from '@/services/tpv/blumon-webhook.service'
import { handleBlumonTPVWebhook } from '@/controllers/tpv/blumon-webhook.tpv.controller'

jest.mock('@/services/tpv/blumon-webhook.service', () => ({
  ...jest.requireActual('@/services/tpv/blumon-webhook.service'),
  processBlumonPaymentWebhook: jest.fn(),
}))
const mockedProcess = svc.processBlumonPaymentWebhook as jest.Mock

function mockRes() {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}
const validBody = {
  amount: '100.00', reference: '260718120000', operationNumber: 99000001,
  codeResponse: '00', descriptionResponse: 'APROBADA', operationType: 'VENTA',
}
const mockReq = () => ({ body: validBody, header: () => undefined, headers: {} }) as any

describe('Task 4 — ACK only after durable persistence', () => {
  beforeEach(() => mockedProcess.mockReset())

  it('503 when the service threw (event may not be persisted)', async () => {
    mockedProcess.mockRejectedValue(new Error('db down'))
    const res = mockRes()
    await handleBlumonTPVWebhook(mockReq(), res)
    expect(res.status).toHaveBeenCalledWith(503)
  })

  it('503 when result has no eventLogId (not persisted)', async () => {
    mockedProcess.mockResolvedValue({ success: false, action: 'PENDING', message: 'x' })
    const res = mockRes()
    await handleBlumonTPVWebhook(mockReq(), res)
    expect(res.status).toHaveBeenCalledWith(503)
  })

  it('200 when persisted (eventLogId present)', async () => {
    mockedProcess.mockResolvedValue({ success: true, action: 'MATCHED', message: 'ok', eventLogId: 'evt_1', paymentId: 'pay_1' })
    const res = mockRes()
    await handleBlumonTPVWebhook(mockReq(), res)
    expect(res.status).toHaveBeenCalledWith(200)
  })
})
```

- [ ] **Step 2: Correr — FALLAN** (hoy ambos casos responden 200).

- [ ] **Step 3: Implementación** — en el controller:

```typescript
    const result = await processBlumonPaymentWebhook(payload)

    logger.info('📤 Blumon webhook processed', {
      correlationId, action: result.action, success: result.success,
      paymentId: result.paymentId, reference: payload.reference,
    })

    // ACK contract: 200 ONLY when the event row is durably persisted
    // (eventLogId present). Otherwise 503 so Blumon retries — retries are
    // idempotent via @@unique([provider, eventId]).
    if (!result.eventLogId) {
      res.status(503).json({ success: false, action: result.action, message: 'Event not persisted — please retry' })
      return
    }
    res.status(200).json({
      success: result.success, action: result.action, message: result.message,
      paymentId: result.paymentId, details: result.details,
    })
  } catch (error) {
    logger.error('❌ Blumon webhook: Unexpected error', {
      correlationId, reference: payload.reference, operationNumber: payload.operationNumber,
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    })
    // 503 (was 200): an exception here may mean the event was never persisted.
    // Blumon's retry is safe — duplicates dedup on the unique eventId.
    res.status(503).json({ success: false, error: 'Temporary processing failure — please retry' })
  }
```

- [ ] **Step 4: Verificar que todos los caminos post-validación SÍ persisten** (para no 503-ear legítimos): `grep -n "providerEventLog.create\|eventLogId" src/services/tpv/blumon-webhook.service.ts`. Los caminos de `:363`, `:395` y `:422` insertan el row. Si algún camino (p.ej. UNKNOWN_TERMINAL) retorna sin `eventLogId`, mover su persistencia ANTES del retorno. Correr la suite completa del webhook para confirmar que ningún test existente espere 200-en-error.

- [ ] **Step 5: Tests → PASS. `npx tsc --noEmit` limpio. Commit**

```bash
git add src/controllers/tpv/blumon-webhook.tpv.controller.ts tests/unit/controllers/tpv/blumon-webhook.controller.ack.test.ts
git commit -m "fix(blumon-webhook): ACK 200 only after durable event persistence; 503 otherwise (idempotent retries)"
```

---

### Task 5: Clasificar DEVOLUCION/CANCELACION fuera de la ruta de venta + eventId propio

Hoy `operationType` es texto muerto: un reverso corre la MISMA lógica que una venta (puede casar contra ventas y disparar la alarma "cargo sin registrar" por dinero que está SALIENDO). Además `buildBlumonEventId` (`:159-166`) **no incluye el tipo**, así que un reverso colisiona con el eventId de su venta.

**Files:**
- Modify: `src/services/tpv/blumon-webhook.service.ts` (`buildBlumonEventId` `:159-166`; inicio de `attemptPaymentMatch`; action union; `updateEventLogFromMatchResult`)
- Modify: `src/jobs/blumon-webhook-reconciliation.job.ts` (sweeps `:93-130` y `:136-187`)
- Test: `tests/unit/services/tpv/blumon-webhook.matching.test.ts` (ampliar)

**Interfaces:**
- Produces: action `'REVERSAL_RECEIVED'`; `errorReason: 'REVERSAL_UNMATCHED'`; eventId de reversos con prefijo `blumon-tpv-reversal-{tipo}-…`. **El eventId de VENTA queda BYTE-IDÉNTICO.**

- [ ] **Step 1: Tests que fallan**

```typescript
import { buildBlumonEventId } from '@/services/tpv/blumon-webhook.service'

describe('Task 5 — reversals never run sale logic and get their own event id', () => {
  it('VENTA event id is unchanged (legacy-compatible)', () => {
    expect(buildBlumonEventId({ operationNumber: 21372460, reference: '20260716084615', operationType: 'VENTA' } as any))
      .toBe('blumon-tpv-21372460-20260716084615')
  })

  it('a reversal gets a distinct namespace (no collision with its sale)', () => {
    expect(buildBlumonEventId({ operationNumber: 21372460, reference: '20260716084615', operationType: 'DEVOLUCION' } as any))
      .toBe('blumon-tpv-reversal-devolucion-21372460-20260716084615')
  })

  it.each(['DEVOLUCION', 'CANCELACION'])('%s → REVERSAL_RECEIVED, no sale search, no orphan alert', async opType => {
    const reversal = { ...ventaPayload, operationType: opType } as any
    const result = await reconcileBlumonEvent('evt_t5', reversal, { scopeVenueIds: ['venue_1'] })
    expect(result.action).toBe('REVERSAL_RECEIVED')
    expect(mockedFindMany).not.toHaveBeenCalled()
    expect(mockedEventLogUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PROCESSED', errorReason: 'REVERSAL_UNMATCHED' }),
      }),
    )
  })
})
```

- [ ] **Step 2: Correr — FALLAN.**

- [ ] **Step 3: Implementación**

(a) `buildBlumonEventId` (`:159-166`) — VENTA intacto:

```typescript
export function buildBlumonEventId(payload: BlumonWebhookPayload): string | null {
  const op = payload.operationNumber
  const ref = payload.reference
  const opType = payload.operationType
  // VENTA (and any legacy/absent operationType) MUST keep the exact historical
  // shape — changing it would break dedup against every existing row.
  // Reversals get their own namespace so they never collide with their sale.
  const isReversal = opType === 'DEVOLUCION' || opType === 'CANCELACION'
  const prefix = isReversal ? `blumon-tpv-reversal-${opType.toLowerCase()}` : 'blumon-tpv'
  if (op != null && ref) return `${prefix}-${op}-${ref}`
  if (op != null) return `${prefix}-${op}`
  if (ref) return `${prefix}-${ref}`
  return null
}
```

(b) Action union — agregar `| 'REVERSAL_RECEIVED' // DEVOLUCION/CANCELACION — recorded, excluded from sale matching`. Y en `BLUMON_WEBHOOK_ERROR_REASONS`:

```typescript
  /** Reversal event recorded but not yet tied to a refund (ledger plan) */
  REVERSAL_UNMATCHED: 'REVERSAL_UNMATCHED',
```

(c) Al inicio de `attemptPaymentMatch`, ANTES del scope-check de Task 2:

```typescript
    // Reversal/cancellation events must NEVER run the sale-matching logic:
    // they'd confirm the wrong row, and their non-match would fire the
    // "charge without record" alert for money that is LEAVING. Recorded as
    // informational; fine-grained reversal↔refund matching ships with the
    // ledger plan.
    if (payload.operationType === 'DEVOLUCION' || payload.operationType === 'CANCELACION') {
      logger.info('↩️ Blumon webhook: reversal-type event — recorded, excluded from sale matching', {
        correlationId, operationType: payload.operationType, reference: payload.reference,
        operationNumber: payload.operationNumber,
      })
      return { success: true, action: 'REVERSAL_RECEIVED', message: `Reversal event (${payload.operationType}) recorded`, details: { blumonAmount } }
    }
```

(d) `updateEventLogFromMatchResult` — caso nuevo. Se marca `PROCESSED` (terminal, no reintenta) **pero con `errorReason`** para que siga siendo consultable como "recibido, no conciliado" (el schema sanciona ese uso en el comentario de `:4395-4399`):

```typescript
    case 'REVERSAL_RECEIVED':
      data.status = EventStatus.PROCESSED
      data.errorReason = BLUMON_WEBHOOK_ERROR_REASONS.REVERSAL_UNMATCHED
      data.processedAt = new Date()
      break
```

(e) En `blumon-webhook-reconciliation.job.ts`, al `where` de AMBOS sweeps (`:93-130` PENDING y `:136-187` markOrphaned):

```typescript
        type: 'VENTA', // reversal events are informational — never orphan-alert them
```

(`ProviderEventLog.type` se puebla con `payload.operationType ?? 'VENTA'` en `:422`, así que los históricos quedan cubiertos.)

- [ ] **Step 4: Tests → PASS (nuevos + suite webhook + suite del job si existe). `npx tsc --noEmit` limpio.**

- [ ] **Step 5: Commit**

```bash
git add src/services/tpv/blumon-webhook.service.ts src/jobs/blumon-webhook-reconciliation.job.ts tests/unit/services/tpv/blumon-webhook.matching.test.ts
git commit -m "feat(blumon-webhook): classify reversals out of sale matching with their own event id namespace"
```

---

### Task 6: Auditoría simétrica Payment→webhook (job nuevo, solo-lectura + alerta)

Hoy la vigilancia es unidireccional (webhook→Payment). Un cargo registrado cuyo webhook nunca llegó es invisible. Job nuevo: cada 10 min, Payments Blumon COMPLETED de 30 min–48 h SIN `processorData.blumonWebhookReceived` → alerta **una sola vez** por pago.

**Files:**
- Create: `src/jobs/blumon-payment-audit.job.ts`
- Modify: `src/server.ts` (arrancar junto al de reconciliación; y registrar su `stop()` en el shutdown)
- Test: `tests/unit/jobs/blumon-payment-audit.job.test.ts` (nuevo)

**Interfaces:**
- Produces: `BlumonPaymentAuditJob { start(): void; stop(): void; runOnce(): Promise<number> }` — `runOnce` devuelve cuántos pagos alertó.
- Marca antispam: `processorData.webhookAuditAlertedAt` — **merge JSON, nunca reemplazo**.

- [ ] **Step 1: Test que falla**

```typescript
// tests/unit/jobs/blumon-payment-audit.job.test.ts
import { BlumonPaymentAuditJob } from '@/jobs/blumon-payment-audit.job'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { $queryRaw: jest.fn(), payment: { update: jest.fn(), findUnique: jest.fn() } },
}))
const mockedRaw = prisma.$queryRaw as jest.Mock
const mockedUpdate = prisma.payment.update as jest.Mock
const mockedFindUnique = prisma.payment.findUnique as jest.Mock

describe('BlumonPaymentAuditJob', () => {
  beforeEach(() => {
    ;[mockedRaw, mockedUpdate, mockedFindUnique].forEach(m => m.mockReset())
    mockedUpdate.mockResolvedValue({})
  })

  it('alerts once per webhook-less card payment and MERGES the antispam marker', async () => {
    mockedRaw.mockResolvedValue([
      { id: 'pay_x', amount: '150.00', venueName: 'Mindform', createdAt: new Date('2026-07-18T10:00:00Z'), authorizationNumber: 'A1' },
    ])
    mockedFindUnique.mockResolvedValue({ processorData: { existingKey: 'keep-me' } })
    const alerted = await new BlumonPaymentAuditJob().runOnce()
    expect(alerted).toBe(1)
    const data = mockedUpdate.mock.calls[0][0].data.processorData
    expect(data.existingKey).toBe('keep-me')      // previous JSON preserved
    expect(data.webhookAuditAlertedAt).toBeDefined()
  })

  it('quiet pass when nothing is missing', async () => {
    mockedRaw.mockResolvedValue([])
    expect(await new BlumonPaymentAuditJob().runOnce()).toBe(0)
    expect(mockedUpdate).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Correr — FALLA** (el archivo no existe).

- [ ] **Step 3: Implementación**

Primero verificar los helpers del repo a reutilizar (existen, confirmado 2026-07-18):
`ls src/utils/retry.ts src/utils/datetime.ts` y `grep -n "export" src/utils/retry.ts` para usar el helper de reintento de conexión con su firma real.

```typescript
// src/jobs/blumon-payment-audit.job.ts
import { CronJob } from 'cron'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'

/**
 * Symmetric Payment→webhook audit.
 *
 * The reconciliation job answers "webhook without Payment?" — this answers the
 * INVERSE: "card Payment without its Blumon webhook?" (the Mindform $1,400
 * class). READ-ONLY except one idempotent antispam stamp.
 *
 * Window: 30min old (give the webhook time) … 48h old (bounded scan).
 * All time math is done in SQL/UTC — never in local time.
 * BetterStack alerts on the '🚨 [Blumon audit]' log line.
 */
export class BlumonPaymentAuditJob {
  private readonly CRON_PATTERN = '0 */10 * * * *' // every 10 min
  private job: CronJob | null = null

  start(): void {
    this.job = new CronJob(this.CRON_PATTERN, () => void this.runOnce())
    this.job.start()
    logger.info('🪝 Blumon payment audit job started — every 10min, window 30min–48h')
  }

  /** Required for graceful shutdown — mirrors the reconciliation job. */
  stop(): void {
    this.job?.stop()
    this.job = null
    logger.info('🛑 Blumon payment audit job stopped')
  }

  async runOnce(): Promise<number> {
    try {
      const rows = (await prisma.$queryRaw`
        SELECT p.id, p.amount::text AS amount, p."authorizationNumber", p."createdAt", v.name AS "venueName"
        FROM "Payment" p
        JOIN "MerchantAccount" ma ON ma.id = p."merchantAccountId"
        LEFT JOIN "Order" o ON o.id = p."orderId"
        LEFT JOIN "Venue" v ON v.id = o."venueId"
        WHERE p.method IN ('CREDIT_CARD','DEBIT_CARD')
          AND p.status = 'COMPLETED'
          AND p.source = 'TPV'
          AND p.type <> 'REFUND'
          AND ma."blumonSerialNumber" IS NOT NULL
          AND p."createdAt" BETWEEN now() - interval '48 hours' AND now() - interval '30 minutes'
          AND (p."processorData"->>'blumonWebhookReceived') IS NULL
          AND (p."processorData"->>'blumonDiscrepancy') IS NULL
          AND (p."processorData"->>'webhookAuditAlertedAt') IS NULL
        LIMIT 50
      `) as Array<{ id: string; amount: string; authorizationNumber: string | null; createdAt: Date; venueName: string | null }>

      for (const row of rows) {
        logger.error('🚨 [Blumon audit] Card payment WITHOUT Blumon webhook — verify capture', {
          paymentId: row.id, amount: row.amount, venue: row.venueName,
          authorizationNumber: row.authorizationNumber, createdAt: row.createdAt,
        })
        // MERGE, never replace: processorData carries blumon* keys written by
        // the webhook service (:790-803). A bare update would wipe them.
        const current = await prisma.payment.findUnique({ where: { id: row.id }, select: { processorData: true } })
        const existing = (current?.processorData as Record<string, unknown>) ?? {}
        await prisma.payment
          .update({
            where: { id: row.id },
            data: { processorData: { ...existing, webhookAuditAlertedAt: new Date().toISOString() } as any },
          })
          .catch(err => logger.warn('Blumon audit: failed to stamp antispam marker', { paymentId: row.id, err }))
      }
      return rows.length
    } catch (error) {
      logger.error('❌ Blumon payment audit job failed', { error: error instanceof Error ? error.message : error })
      return 0
    }
  }
}
```

**Exclusiones deliberadas del query** (evitan falsos positivos): refunds (`type <> 'REFUND'`), pagos ya marcados con discrepancia (ya tienen su propia alerta), pagos sin merchant Blumon (`JOIN` + `blumonSerialNumber IS NOT NULL` deja fuera efectivo/AngelPay/sandbox), y los ya alertados.

Envolver la consulta con el helper de reintento del repo (`src/utils/retry.ts`) siguiendo su firma real, para que una caída momentánea de conexión no cuente como "0 pendientes".

(b) En `src/server.ts`, junto al arranque de `BlumonWebhookReconciliationJob` (grep y replicar el patrón, incluido el registro en el shutdown):

```typescript
import { BlumonPaymentAuditJob } from '@/jobs/blumon-payment-audit.job'
const blumonPaymentAuditJob = new BlumonPaymentAuditJob()
blumonPaymentAuditJob.start()
// en el handler de shutdown existente:
blumonPaymentAuditJob.stop()
```

- [ ] **Step 4: Tests → PASS. `npx tsc --noEmit` limpio.**

- [ ] **Step 5: Commit**

```bash
git add src/jobs/blumon-payment-audit.job.ts src/server.ts tests/unit/jobs/blumon-payment-audit.job.test.ts
git commit -m "feat(blumon-audit): symmetric Payment→webhook sweep with once-per-payment alert"
```

---

### Task 7: Verificación integral + changelog

**Files:**
- Modify: changelog del server si existe (`ls CHANGELOG*.md docs/CHANGELOG*.md 2>/dev/null`)

- [ ] **Step 1: Suite completa** — `npm run test:unit` → PASS. Si algo ajeno falla, confirmar que ya fallaba antes de atribuirlo a este plan (comparar contra `git stash list` / un checkout limpio — **no** `git stash` a ciegas del working tree).
- [ ] **Step 2: `npx tsc --noEmit`** → limpio.
- [ ] **Step 3: Smoke del ACK** (si hay entorno local): `curl -X POST localhost:PORT/api/v1/webhooks/blumon/tpv -H 'Content-Type: application/json' -d '{}'` → **400** (payload inválido conserva su semántica; el 400 NO debe volverse 503).
- [ ] **Step 4: Changelog** — si el repo lleva changelog, entrada bajo Unreleased: "fix(blumon-webhook): matching determinista por tiers con monto en llaves débiles; referencia parcial nunca auto-liga; scope obligatorio + cuarentena de ambigüedad; exclusión de REFUNDs y reversos (con eventId propio); ACK durable (503 + retry idempotente); operationNumber aceptado como identificador; job de auditoría Payment→webhook". Si no existe changelog, omitir sin crear archivos.
- [ ] **Step 5: Commit final + resumen al founder.**

```bash
git add src/ tests/ docs/superpowers/plans/2026-07-18-blumon-webhook-hardening.md
git commit -m "chore(blumon-webhook): hardening complete — tests green, tsc clean"
```

**Deploy queda FUERA** — requiere GO explícito del founder (Render, branch `main`).

---

## Self-review del plan

- **Cobertura vs spec §5.1–5.2:** REFUND-filter ✓(T1) · match determinista por tiers + monto en llaves débiles + scope + cuarentena ✓(T2) · `operationNumber` válido + keyless alerta ✓(T3) · ACK durable ✓(T4) · reversos clasificados + eventId propio + fuera del orphan-sweep ✓(T5) · sweep simétrico ✓(T6). **Fuera de alcance** (van con la libreta / plan 2): bandeja UI, verificación de captura pre-alerta, job AngelPay, `recordRecoveredPayment`, fingerprint, matching fino reverso↔refund. **Fuera de alcance explícito:** XFF/IP-whitelist y HMAC (tarea de ops, ver Global Constraints).
- **Consistencia de nombres:** `AMBIGUOUS`/`AMBIGUOUS_MATCH`, `NO_AUTO_MATCH`/`WEAK_MATCH_ONLY`, `REVERSAL_RECEIVED`/`REVERSAL_UNMATCHED`, `webhookAuditAlertedAt`, `{ venueIds, merchantAccountId }` — idénticos en tareas, código y tests.
- **Sin placeholders:** cada paso trae código o comando ejecutable. Los 3 puntos que exigen confirmación in-situ están marcados con el `grep` exacto: nombre del validador exportado (T3), caminos que persisten `eventLogId` (T4), firma real del helper de retry (T6).
- **Riesgo residual conocido:** el scope exacto por merchant puede **aumentar la cuarentena** si `blumonSerialNumber` no resuelve (más trabajo manual, nunca dinero mal atribuido). Observar el conteo de `AMBIGUOUS`/`NO_AUTO_MATCH` la primera semana.
