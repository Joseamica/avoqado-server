# Delivery Channels Scaffold (Deliverect adapter #1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backend scaffold completo de delivery-channels en avoqado-server (core genérico + adapter Deliverect) listo para conectar a staging de Deliverect el día que lleguen credenciales.

**Architecture:** Core agnóstico (`src/services/delivery-channels/core/`) que ingiere una orden normalizada → `Order`+`Payment` y publica menú/status; adapter Deliverect (`providers/deliverect/`) que traduce payloads/HMAC/centavos. Webhook con contrato ACK estilo Blumon (persistir evento → 200; fallo → 5xx). Spec: `docs/superpowers/specs/2026-07-18-delivery-channels-design.md`.

**Tech Stack:** Express + TS, Prisma/PostgreSQL, Socket.IO (socketManager), Jest + prismaMock, cron (patrón BlumonWebhookReconciliationJob), axios.

## Global Constraints

- **Dinero en PESOS `Prisma.Decimal` 1:1.** Centavos SOLO en `deliverect.mapper.ts` (`÷10^decimalDigits` al entrar, `×100` al publicar menú).
- **Schema 100% aditivo.** Nunca modificar/renombrar campos existentes ni respuestas de API.
- **Todo query filtrado por `venueId`** (tenant isolation).
- **Zod en español, shape-only.**
- **Commits: SOLO con autorización explícita del founder** (regla repo). Los pasos "Commit" de este plan asumen esa autorización dada de antemano para la ejecución; si no, acumular y pedir permiso.
- Después de editar TS: los tests del task; al final `npm run format && npm run lint:fix` + `npm run pre-deploy` (Task 13).
- Constantes marcadas `// REVALIDAR EN STAGING` (header HMAC, mapa de status, shape exacto del payload) se confirman con credenciales — están aisladas en el adapter a propósito.
- Tests de fechas/dinero corren con `TZ=UTC`. Fechas hardcodeadas prohibidas (usar `Date.now()` + offsets).

---

### Task 1: Schema — enums, modelos, migración, schema map, prismaMock

**Files:**
- Modify: `prisma/schema.prisma` (enums `OrderSource` ~línea 6173, `PaymentSource` ~5918, `OriginSystem` ~6424; modelos nuevos al final de la sección de webhooks/orders)
- Modify: `scripts/generate-schema-map.ts` (mapa `MODEL_TO_DOMAIN`)
- Modify: `tests/__helpers__/setup.ts` (registro prismaMock)
- Modify: `prisma/schema.prisma` model `Venue` (agregar relación `deliveryChannelLinks`)

**Interfaces:**
- Produces: modelos `DeliveryChannelLink`, `DeliveryOrderEvent`; enums `DeliveryProvider`, `OrderAcceptanceMode`, `DeliveryChannelStatus`, `DeliveryOrderEventStatus`; valores nuevos `OrderSource.UBER_EATS|RAPPI|DIDI_FOOD|DELIVERY_PLATFORM`, `PaymentSource.DELIVERY_PLATFORM`, `OriginSystem.DELIVERY_PLATFORM`.

- [ ] **Step 1: Agregar enums nuevos** (junto a los enums de order, ~línea 6187 después de `OrderSource`):

```prisma
enum DeliveryProvider {
  DELIVERECT
  UBER_EATS // integración directa (futuro)
  RAPPI // integración directa (futuro)
  DIDI_FOOD // integración directa (futuro)
}

enum OrderAcceptanceMode {
  AUTO // pedido entra confirmado y se reporta accepted al canal (default industria)
  MANUAL // staff acepta/rechaza en POS — requiere UI Android+iOS (v2, aún no implementado)
}

enum DeliveryChannelStatus {
  PENDING // creado, sin verificar contra el proveedor
  ACTIVE
  PAUSED // pausado por el venue o por billing (feature suspendido)
  DISABLED
}

enum DeliveryOrderEventStatus {
  RECEIVED
  PROCESSED
  FAILED
  DUPLICATE
}
```

- [ ] **Step 2: Extender enums existentes (solo agregar valores, al final de cada enum):**

```prisma
enum OrderSource {
  // ... valores existentes SIN TOCAR ...
  UBER_EATS // Pedido de delivery originado en Uber Eats (vía agregador o directo)
  RAPPI // Pedido de delivery originado en Rappi
  DIDI_FOOD // Pedido de delivery originado en DiDi Food
  DELIVERY_PLATFORM // Canal de delivery no identificado (fallback)
}

enum PaymentSource {
  // ... existentes SIN TOCAR ...
  DELIVERY_PLATFORM // Pagado en la plataforma de delivery (Uber/Rappi/DiDi) — sin dinero por Avoqado
}

enum OriginSystem {
  // ... existentes SIN TOCAR ...
  DELIVERY_PLATFORM // Orden inyectada por un canal de delivery (Deliverect o directo)
}
```

- [ ] **Step 3: Agregar modelos** (nueva sección `// NOTE: DELIVERY CHANNELS` después del modelo `ProviderEventLog`, ~línea 4440):

```prisma
model DeliveryChannelLink {
  id      String @id @default(cuid())
  venueId String
  venue   Venue  @relation(fields: [venueId], references: [id], onDelete: Cascade)

  provider           DeliveryProvider
  /// locationId del proveedor (Deliverect location / store id del canal directo)
  externalLocationId String
  /// accountId de Deliverect (null para proveedores directos)
  externalAccountId  String?

  /// Secret HMAC por vínculo para verificar webhooks entrantes
  webhookSecret String

  orderAcceptanceMode OrderAcceptanceMode   @default(AUTO)
  status              DeliveryChannelStatus @default(PENDING)

  autoSyncMenu   Boolean   @default(true)
  lastMenuSyncAt DateTime?

  /// Config extra por proveedor (p.ej. mapa channelId→OrderSource de Deliverect)
  config Json?

  events DeliveryOrderEvent[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([provider, externalLocationId])
  @@index([venueId])
  @@index([status])
}

/// Log de eventos de webhook de delivery — patrón ProviderEventLog/Blumon:
/// persistir ANTES de ACK; idempotencia por unique(provider, externalEventId, eventType).
model DeliveryOrderEvent {
  id String @id @default(cuid())

  provider        DeliveryProvider
  /// ID del pedido/evento en el proveedor (p.ej. channelOrderId de Deliverect)
  externalEventId String
  eventType       String // 'order' | 'cancel' | 'status'

  channelLinkId String?
  channelLink   DeliveryChannelLink? @relation(fields: [channelLinkId], references: [id], onDelete: SetNull)
  venueId       String?

  payload Json
  status  DeliveryOrderEventStatus @default(RECEIVED)
  error   String?                  @db.Text

  /// Order creada al procesar (null si FAILED/DUPLICATE)
  orderId String?

  receivedAt  DateTime  @default(now())
  processedAt DateTime?

  @@unique([provider, externalEventId, eventType])
  @@index([status, receivedAt])
  @@index([venueId])
}
```

- [ ] **Step 4: Relación en `Venue`:** buscar el modelo `Venue` y junto a `ecommerceMerchants` agregar `deliveryChannelLinks DeliveryChannelLink[]`.

- [ ] **Step 5: Migración (NUNCA db push):**

Run: `npx prisma migrate dev --name delivery-channels-scaffold`
Expected: migración creada y aplicada, `prisma generate` OK.

- [ ] **Step 6: Schema map (obligatorio mismo commit):** en `scripts/generate-schema-map.ts` agregar al `MODEL_TO_DOMAIN`:

```typescript
DeliveryChannelLink: 'Orders, KDS & Cash',
DeliveryOrderEvent: 'Orders, KDS & Cash',
```

Run: `npm run schema:map`
Expected: regenera `docs/SCHEMA_MAP.md` sin "unclassified model".

- [ ] **Step 7: prismaMock:** en `tests/__helpers__/setup.ts`, junto a `order: createMockModel()` agregar:

```typescript
deliveryChannelLink: createMockModel(),
deliveryOrderEvent: createMockModel(),
```

- [ ] **Step 8: Verificar build:**

Run: `npx prisma validate && npm run build`
Expected: sin errores.

- [ ] **Step 9: Commit** — `git add prisma/ scripts/generate-schema-map.ts docs/SCHEMA_MAP.md tests/__helpers__/setup.ts && git commit -m "feat(delivery): schema delivery-channels (DeliveryChannelLink, DeliveryOrderEvent, enums aditivos)"`

---

### Task 2: Tipos del core + interfaz adapter + HMAC de Deliverect

**Files:**
- Create: `src/services/delivery-channels/core/types.ts`
- Create: `src/services/delivery-channels/providers/deliverect/deliverect.hmac.ts`
- Test: `tests/unit/services/delivery-channels/deliverect.hmac.test.ts`

**Interfaces:**
- Produces: `NormalizedDeliveryOrder`, `NormalizedDeliveryItem`, `DeliveryOrderStatus`, `DeliveryProviderAdapter`, `verifyDeliverectHmac(rawBody: Buffer, headerValue: string | undefined, secret: string): boolean`, `DELIVERECT_HMAC_HEADER`.

- [ ] **Step 1: Escribir `types.ts`:**

```typescript
import { DeliveryChannelLink, OrderSource } from '@prisma/client'

/** Estados internos que el core propaga hacia el canal (el adapter los traduce). */
export type DeliveryOrderStatus = 'ACCEPTED' | 'PREPARING' | 'READY' | 'PICKED_UP' | 'CANCELLED' | 'FAILED'

export interface NormalizedDeliveryItem {
  /** PLU = Product.sku de Avoqado (el menú lo publicamos nosotros) */
  plu: string
  name: string
  quantity: number
  /** PESOS por unidad (el adapter ya convirtió de centavos) */
  unitPrice: number
  /** Modificadores aplanados como texto (v1) + monto ya incluido en unitPrice=false → se suma */
  modifiers: Array<{ plu: string; name: string; quantity: number; unitPrice: number }>
  notes?: string
}

export interface NormalizedDeliveryOrder {
  /** ID del pedido en el proveedor — va a Order.externalId (unique por venue) */
  externalId: string
  /** Número corto para mostrar en KDS/tickets (channelOrderDisplayId) */
  displayId: string
  /** Canal real resuelto (UBER_EATS/RAPPI/DIDI_FOOD) o DELIVERY_PLATFORM */
  source: OrderSource
  items: NormalizedDeliveryItem[]
  /** PESOS. total = subtotal - discount + tax + tip + serviceCharge + deliveryFee */
  subtotal: number
  taxAmount: number
  discountAmount: number
  tipAmount: number
  serviceChargeAmount: number
  deliveryFeeAmount: number
  total: number
  customer?: { name?: string; phone?: string; note?: string }
  /** Payload crudo del proveedor — va a Order.posRawData */
  raw: unknown
  placedAt: Date
}

/** Contrato que TODO proveedor de delivery implementa (Deliverect hoy; DiDi/Rappi/Uber directo mañana). */
export interface DeliveryProviderAdapter {
  readonly provider: 'DELIVERECT' | 'UBER_EATS' | 'RAPPI' | 'DIDI_FOOD'
  verifySignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, link: DeliveryChannelLink): boolean
  parseOrderWebhook(rawBody: Buffer, link: DeliveryChannelLink): NormalizedDeliveryOrder
  sendStatusUpdate(link: DeliveryChannelLink, externalOrderId: string, status: DeliveryOrderStatus): Promise<void>
  pushMenu(link: DeliveryChannelLink, snapshot: import('./menuSnapshot.service').MenuSnapshot): Promise<void>
  setChannelPaused(link: DeliveryChannelLink, paused: boolean): Promise<void>
}
```

- [ ] **Step 2: Test del HMAC (falla primero):**

```typescript
// tests/unit/services/delivery-channels/deliverect.hmac.test.ts
import crypto from 'crypto'
import {
  verifyDeliverectHmac,
  DELIVERECT_HMAC_HEADER,
} from '../../../../src/services/delivery-channels/providers/deliverect/deliverect.hmac'

describe('verifyDeliverectHmac', () => {
  const secret = 'test-secret'
  const body = Buffer.from(JSON.stringify({ channelOrderId: 'abc123' }))
  const validSig = crypto.createHmac('sha256', secret).update(body).digest('base64')

  // NUEVO
  it('acepta firma válida', () => {
    expect(verifyDeliverectHmac(body, validSig, secret)).toBe(true)
  })
  it('rechaza firma inválida', () => {
    expect(verifyDeliverectHmac(body, 'AAAA' + validSig.slice(4), secret)).toBe(false)
  })
  it('rechaza header ausente', () => {
    expect(verifyDeliverectHmac(body, undefined, secret)).toBe(false)
  })
  it('rechaza firma de otro body (replay con payload alterado)', () => {
    expect(verifyDeliverectHmac(Buffer.from('{"otro":1}'), validSig, secret)).toBe(false)
  })
  it('no truena con firma de longitud distinta (timingSafeEqual lanza si length difiere)', () => {
    expect(verifyDeliverectHmac(body, 'corta', secret)).toBe(false)
  })
  it('exporta el nombre del header', () => {
    expect(DELIVERECT_HMAC_HEADER).toBe('x-deliverect-hmac-sha256')
  })
})
```

- [ ] **Step 3: Correr para verlo fallar:** `npx jest tests/unit/services/delivery-channels/deliverect.hmac.test.ts` → FAIL (module not found).

- [ ] **Step 4: Implementar `deliverect.hmac.ts`:**

```typescript
import crypto from 'crypto'

/**
 * Header HMAC de Deliverect sobre el body crudo del webhook de órdenes.
 * Doc: developers.deliverect.com/docs/validating-orders-in-pos-using-hmac
 * REVALIDAR EN STAGING: nombre exacto del header y encoding (base64 asumido).
 */
export const DELIVERECT_HMAC_HEADER = 'x-deliverect-hmac-sha256'

export function verifyDeliverectHmac(rawBody: Buffer, headerValue: string | undefined, secret: string): boolean {
  if (!headerValue) return false
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64')
  const a = Buffer.from(expected)
  const b = Buffer.from(headerValue)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
```

- [ ] **Step 5: Correr tests → PASS.** También `npm run build` (types.ts compila; el import de `menuSnapshot.service` se crea en Task 7 — mientras tanto usar `unknown` si rompe el build: `pushMenu(link, snapshot: unknown)`, y ajustarlo en Task 7).
- [ ] **Step 6: Commit** — `git add src/services/delivery-channels tests/unit/services/delivery-channels && git commit -m "feat(delivery): tipos core + interfaz adapter + verificación HMAC Deliverect"`

---

### Task 3: Deliverect order mapper (payload → NormalizedDeliveryOrder)

**Files:**
- Create: `src/services/delivery-channels/providers/deliverect/deliverect.mapper.ts`
- Create: `tests/__fixtures__/deliverect/order-webhook.json` (fixture)
- Test: `tests/unit/services/delivery-channels/deliverect.mapper.test.ts`

**Interfaces:**
- Consumes: `NormalizedDeliveryOrder` (Task 2)
- Produces: `parseDeliverectOrder(rawBody: Buffer, link: DeliveryChannelLink): NormalizedDeliveryOrder`, `resolveOrderSource(channelId: number | undefined, link: DeliveryChannelLink): OrderSource`, `DELIVERECT_STATUS_MAP`.

- [ ] **Step 1: Fixture basado en la doc pública** (`tests/__fixtures__/deliverect/order-webhook.json`) — campos según channel-orders.md; `// REVALIDAR EN STAGING` el shape completo:

```json
{
  "_id": "64f0deliverectid",
  "channelOrderId": "UE-12345-A",
  "channelOrderDisplayId": "A1B2C3",
  "channelLink": "chl-001",
  "location": "loc-001",
  "channel": 7,
  "orderType": 2,
  "orderIsAlreadyPaid": true,
  "decimalDigits": 2,
  "pickupTime": null,
  "note": "Sin cebolla por favor",
  "customer": { "name": "Juan Pérez", "phoneNumber": "+52155****90" },
  "items": [
    {
      "plu": "TACO-PASTOR",
      "name": "Taco al Pastor",
      "price": 4500,
      "quantity": 2,
      "subItems": [{ "plu": "EXTRA-QUESO", "name": "Extra queso", "price": 1000, "quantity": 1 }]
    },
    { "plu": "AGUA-JAMAICA", "name": "Agua de Jamaica", "price": 3000, "quantity": 1 }
  ],
  "payment": { "amount": 14000, "type": 2 },
  "taxTotal": 1931,
  "discountTotal": 0,
  "tip": 1000,
  "serviceCharge": 0,
  "deliveryCost": 0,
  "createdAt": "2026-07-18T18:30:00.000Z"
}
```

- [ ] **Step 2: Test (falla primero):**

```typescript
// tests/unit/services/delivery-channels/deliverect.mapper.test.ts
import fs from 'fs'
import path from 'path'
import { OrderSource } from '@prisma/client'
import { parseDeliverectOrder, resolveOrderSource } from '../../../../src/services/delivery-channels/providers/deliverect/deliverect.mapper'

const fixture = fs.readFileSync(path.join(__dirname, '../../../__fixtures__/deliverect/order-webhook.json'))
const link: any = {
  id: 'link1',
  venueId: 'venue1',
  provider: 'DELIVERECT',
  externalLocationId: 'loc-001',
  config: { channelSourceMap: { '7': 'UBER_EATS' } },
}

describe('parseDeliverectOrder', () => {
  // NUEVO
  it('convierte centavos a pesos según decimalDigits', () => {
    const o = parseDeliverectOrder(fixture, link)
    expect(o.items[0].unitPrice).toBe(45.0)
    expect(o.items[0].modifiers[0].unitPrice).toBe(10.0)
    expect(o.tipAmount).toBe(10.0)
    expect(o.taxAmount).toBe(19.31)
  })
  it('total = payment.amount en pesos (lo que el cliente pagó manda)', () => {
    const o = parseDeliverectOrder(fixture, link)
    expect(o.total).toBe(140.0)
  })
  it('subtotal = suma de items+modifiers en pesos', () => {
    const o = parseDeliverectOrder(fixture, link)
    // 2×45 + 1×10 (modifier) + 30 = 130
    expect(o.subtotal).toBe(130.0)
  })
  it('externalId y displayId vienen del canal', () => {
    const o = parseDeliverectOrder(fixture, link)
    expect(o.externalId).toBe('UE-12345-A')
    expect(o.displayId).toBe('A1B2C3')
  })
  it('resuelve el canal real desde config.channelSourceMap', () => {
    const o = parseDeliverectOrder(fixture, link)
    expect(o.source).toBe(OrderSource.UBER_EATS)
  })
  it('payload crudo se preserva en raw', () => {
    const o = parseDeliverectOrder(fixture, link)
    expect((o.raw as any).channelOrderId).toBe('UE-12345-A')
  })
  it('cliente y nota se capturan', () => {
    const o = parseDeliverectOrder(fixture, link)
    expect(o.customer?.name).toBe('Juan Pérez')
    expect(o.customer?.note).toBe('Sin cebolla por favor')
  })

  // REGRESIÓN / bordes
  it('canal desconocido → DELIVERY_PLATFORM (fallback, nunca truena)', () => {
    expect(resolveOrderSource(999, link)).toBe(OrderSource.DELIVERY_PLATFORM)
  })
  it('decimalDigits ausente → asume 2', () => {
    const p = JSON.parse(fixture.toString())
    delete p.decimalDigits
    const o = parseDeliverectOrder(Buffer.from(JSON.stringify(p)), link)
    expect(o.items[0].unitPrice).toBe(45.0)
  })
  it('body inválido lanza error legible', () => {
    expect(() => parseDeliverectOrder(Buffer.from('not-json'), link)).toThrow(/payload/i)
  })
})
```

- [ ] **Step 3: Correr → FAIL.**
- [ ] **Step 4: Implementar `deliverect.mapper.ts`:**

```typescript
import { DeliveryChannelLink, OrderSource } from '@prisma/client'
import { NormalizedDeliveryOrder, NormalizedDeliveryItem, DeliveryOrderStatus } from '../../core/types'

/**
 * Mapa status interno → código numérico de Deliverect.
 * Fuente: developers.deliverect.com/order-status — REVALIDAR EN STAGING.
 */
export const DELIVERECT_STATUS_MAP: Record<DeliveryOrderStatus, number> = {
  ACCEPTED: 20,
  PREPARING: 30,
  READY: 40,
  PICKED_UP: 50,
  CANCELLED: 110,
  FAILED: 120,
}

export function resolveOrderSource(channelId: number | undefined, link: DeliveryChannelLink): OrderSource {
  const map = ((link.config as any)?.channelSourceMap ?? {}) as Record<string, string>
  const mapped = channelId != null ? map[String(channelId)] : undefined
  if (mapped && mapped in OrderSource) return mapped as OrderSource
  return OrderSource.DELIVERY_PLATFORM
}

/** centavos (o la unidad que declare decimalDigits) → PESOS. SOLO aquí se divide. */
function toPesos(minor: number | undefined | null, decimalDigits: number): number {
  if (minor == null) return 0
  return Math.round(minor) / Math.pow(10, decimalDigits)
}

export function parseDeliverectOrder(rawBody: Buffer, link: DeliveryChannelLink): NormalizedDeliveryOrder {
  let p: any
  try {
    p = JSON.parse(rawBody.toString('utf8'))
  } catch {
    throw new Error('Deliverect: payload no es JSON válido')
  }
  if (!p?.channelOrderId || !Array.isArray(p?.items)) {
    throw new Error('Deliverect: payload sin channelOrderId/items')
  }
  const dd = typeof p.decimalDigits === 'number' ? p.decimalDigits : 2

  const items: NormalizedDeliveryItem[] = p.items.map((it: any) => ({
    plu: String(it.plu ?? ''),
    name: String(it.name ?? 'Producto'),
    quantity: Number(it.quantity ?? 1),
    unitPrice: toPesos(it.price, dd),
    modifiers: (it.subItems ?? []).map((s: any) => ({
      plu: String(s.plu ?? ''),
      name: String(s.name ?? 'Modificador'),
      quantity: Number(s.quantity ?? 1),
      unitPrice: toPesos(s.price, dd),
    })),
    notes: it.remark ? String(it.remark) : undefined,
  }))

  const subtotal = items.reduce(
    (sum, it) => sum + it.unitPrice * it.quantity + it.modifiers.reduce((m, s) => m + s.unitPrice * s.quantity, 0),
    0,
  )

  return {
    externalId: String(p.channelOrderId),
    displayId: String(p.channelOrderDisplayId ?? p.channelOrderId),
    source: resolveOrderSource(p.channel, link),
    items,
    subtotal: Math.round(subtotal * 100) / 100,
    taxAmount: toPesos(p.taxTotal, dd),
    discountAmount: toPesos(p.discountTotal, dd),
    tipAmount: toPesos(p.tip, dd),
    serviceChargeAmount: toPesos(p.serviceCharge, dd),
    deliveryFeeAmount: toPesos(p.deliveryCost, dd),
    total: toPesos(p.payment?.amount, dd),
    customer: p.customer || p.note ? { name: p.customer?.name, phone: p.customer?.phoneNumber, note: p.note } : undefined,
    raw: p,
    placedAt: p.createdAt ? new Date(p.createdAt) : new Date(),
  }
}
```

- [ ] **Step 5: Correr → PASS.**
- [ ] **Step 6: Commit** — `git commit -m "feat(delivery): mapper de pedidos Deliverect (centavos→pesos, canal→OrderSource)"`

---

### Task 4: Ingestion service (NormalizedDeliveryOrder → Order + Payment + socket)

**Files:**
- Create: `src/services/delivery-channels/core/deliveryOrderIngestion.service.ts`
- Test: `tests/unit/services/delivery-channels/deliveryOrderIngestion.test.ts`

**Interfaces:**
- Consumes: `NormalizedDeliveryOrder` (Task 2)
- Produces: `ingestDeliveryOrder(normalized: NormalizedDeliveryOrder, link: DeliveryChannelLink): Promise<{ order: Order; created: boolean }>`

- [ ] **Step 1: Tests (prismaMock; falla primero).** Casos NUEVOS: crea Order type DELIVERY con source del canal + `originSystem: DELIVERY_PLATFORM` + `externalId` + `posRawData`; crea OrderItems con productId resuelto por `sku` y placeholder si el PLU no existe (categoría `delivery-desconocido` find-or-create); crea Payment `source: DELIVERY_PLATFORM`, `status: COMPLETED`, `method: OTHER`, `processor: 'deliverect'`, `externalSource` = canal, `feePercentage/feeAmount = 0`, `netAmount = amount` + `PaymentAllocation`; idempotencia (order.upsert por `venueId_externalId`, payments saltados si ya existen — patrón posSync); socket `broadcastToVenue(ORDER_CREATED)` DESPUÉS de la tx con el shape posSync (incl. `eventType: 'created'`); fallo del socket NO tumba la ingesta. REGRESIÓN: no toca `venue.feeValue` (fee 0 explícito).

```typescript
// esqueleto de los asserts clave (escribir el archivo completo con este estilo):
import { OrderSource, OrderType, OriginSystem, PaymentSource, TransactionStatus } from '@prisma/client'
import prisma from '../../../../src/utils/prismaClient'
import { socketManager } from '../../../../src/communication/sockets/managers/socketManager'
import { ingestDeliveryOrder } from '../../../../src/services/delivery-channels/core/deliveryOrderIngestion.service'

jest.mock('../../../../src/communication/sockets/managers/socketManager', () => ({
  socketManager: { broadcastToVenue: jest.fn() },
}))

const link: any = { id: 'link1', venueId: 'venue1', provider: 'DELIVERECT', orderAcceptanceMode: 'AUTO' }
const normalized: any = {
  externalId: 'UE-1',
  displayId: 'A1',
  source: OrderSource.UBER_EATS,
  items: [{ plu: 'TACO', name: 'Taco', quantity: 2, unitPrice: 45, modifiers: [] }],
  subtotal: 90, taxAmount: 14.4, discountAmount: 0, tipAmount: 10,
  serviceChargeAmount: 0, deliveryFeeAmount: 0, total: 114.4,
  raw: { any: 'payload' }, placedAt: new Date(),
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(prisma))
  ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ id: 'venue1', organizationId: 'org1' })
  ;(prisma.product.findUnique as jest.Mock).mockResolvedValue({ id: 'prod1', sku: 'TACO', name: 'Taco' })
  ;(prisma.order.upsert as jest.Mock).mockResolvedValue({ id: 'order1', externalId: 'UE-1', orderNumber: 'A1', status: 'CONFIRMED', paymentStatus: 'PAID', source: OrderSource.UBER_EATS })
  ;(prisma.payment.count as jest.Mock).mockResolvedValue(0)
  ;(prisma.payment.create as jest.Mock).mockResolvedValue({ id: 'pay1', amount: 114.4 })
})
```

- [ ] **Step 2: Correr → FAIL.**
- [ ] **Step 3: Implementar.** Estructura (misma forma que `processPosOrderEvent` — leerlo como referencia `src/services/pos-sync/posSyncOrder.service.ts:145`):

```typescript
import prisma from '../../../utils/prismaClient'
import logger from '../../../config/logger'
import { DeliveryChannelLink, Order, OrderSource, OrderType, OriginSystem, PaymentMethod, PaymentSource, Prisma, SplitType, TransactionStatus } from '@prisma/client'
import { socketManager } from '../../../communication/sockets/managers/socketManager'
import { SocketEventType } from '../../../communication/sockets/types'
import { NormalizedDeliveryOrder } from './types'

const PLACEHOLDER_CATEGORY_SLUG = 'delivery-desconocido'

async function resolveProductId(tx: Prisma.TransactionClient, venueId: string, plu: string, name: string, unitPrice: number): Promise<string> {
  const existing = await tx.product.findUnique({ where: { venueId_sku: { venueId, sku: plu } } })
  if (existing) return existing.id
  logger.warn(`[🛵 DeliveryIngest] PLU desconocido '${plu}' en venue ${venueId} — creando placeholder`)
  let category = await tx.menuCategory.findUnique({ where: { venueId_slug: { venueId, slug: PLACEHOLDER_CATEGORY_SLUG } } })
  if (!category) {
    category = await tx.menuCategory.create({
      data: { venueId, name: 'Delivery (sin mapear)', slug: PLACEHOLDER_CATEGORY_SLUG, active: false },
    })
  }
  const created = await tx.product.create({
    data: { venueId, sku: plu || `delivery-${Date.now()}`, name, price: new Prisma.Decimal(unitPrice), categoryId: category.id, active: false },
  })
  return created.id
}

export async function ingestDeliveryOrder(normalized: NormalizedDeliveryOrder, link: DeliveryChannelLink): Promise<{ order: Order; created: boolean }> {
  const venue = await prisma.venue.findUnique({ where: { id: link.venueId } })
  if (!venue) throw new Error(`Venue ${link.venueId} del channel link no existe`)

  const existing = await prisma.order.findUnique({
    where: { venueId_externalId: { venueId: venue.id, externalId: normalized.externalId } },
  })
  const isNew = !existing

  const order = await prisma.$transaction(async tx => {
    const order = await tx.order.upsert({
      where: { venueId_externalId: { venueId: venue.id, externalId: normalized.externalId } },
      update: { posRawData: normalized.raw as Prisma.InputJsonValue, syncedAt: new Date() },
      create: {
        externalId: normalized.externalId,
        orderNumber: normalized.displayId,
        source: normalized.source,
        originSystem: OriginSystem.DELIVERY_PLATFORM,
        type: OrderType.DELIVERY,
        status: 'CONFIRMED', // AUTO-accept: entra confirmada directo a cocina
        kitchenStatus: 'PENDING',
        paymentStatus: 'PAID',
        subtotal: new Prisma.Decimal(normalized.subtotal),
        taxAmount: new Prisma.Decimal(normalized.taxAmount),
        discountAmount: new Prisma.Decimal(normalized.discountAmount),
        tipAmount: new Prisma.Decimal(normalized.tipAmount),
        total: new Prisma.Decimal(normalized.total),
        posRawData: normalized.raw as Prisma.InputJsonValue,
        createdAt: normalized.placedAt,
        syncedAt: new Date(),
        venue: { connect: { id: venue.id } },
      },
    })

    if (isNew) {
      for (const item of normalized.items) {
        const productId = await resolveProductId(tx, venue.id, item.plu, item.name, item.unitPrice)
        await tx.orderItem.create({
          data: {
            orderId: order.id,
            productId,
            productName: item.name,
            productSku: item.plu,
            quantity: item.quantity,
            unitPrice: new Prisma.Decimal(item.unitPrice),
            taxAmount: new Prisma.Decimal(0),
            externalId: `${normalized.externalId}-${item.plu}`,
            notes: item.notes,
          },
        })
      }

      const existingPayments = await tx.payment.count({ where: { orderId: order.id } })
      if (existingPayments === 0) {
        const payment = await tx.payment.create({
          data: {
            amount: new Prisma.Decimal(normalized.total),
            tipAmount: new Prisma.Decimal(normalized.tipAmount),
            method: PaymentMethod.OTHER,
            source: PaymentSource.DELIVERY_PLATFORM,
            externalSource: normalized.source, // 'UBER_EATS' | 'RAPPI' | ...
            status: TransactionStatus.COMPLETED,
            splitType: SplitType.FULLPAYMENT,
            processor: link.provider.toLowerCase(),
            // Avoqado NO procesó este dinero: fee 0, neto = monto. La comisión de la
            // plataforma es entre restaurante y plataforma (fuera de Avoqado).
            feePercentage: new Prisma.Decimal(0),
            feeAmount: new Prisma.Decimal(0),
            netAmount: new Prisma.Decimal(normalized.total),
            originSystem: OriginSystem.DELIVERY_PLATFORM,
            externalId: `${normalized.externalId}-platform`,
            posRawData: normalized.raw as Prisma.InputJsonValue,
            venue: { connect: { id: venue.id } },
            order: { connect: { id: order.id } },
          },
        })
        await tx.paymentAllocation.create({ data: { amount: payment.amount, payment: { connect: { id: payment.id } }, order: { connect: { id: order.id } } } })
      }
    }
    return order
  })

  try {
    socketManager.broadcastToVenue(venue.id, isNew ? SocketEventType.ORDER_CREATED : SocketEventType.ORDER_UPDATED, {
      orderId: order.id,
      orderNumber: order.orderNumber,
      venueId: venue.id,
      status: order.status,
      paymentStatus: order.paymentStatus,
      source: order.source,
      externalId: order.externalId,
      eventType: isNew ? 'created' : 'updated',
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error('[🛵 DeliveryIngest] Socket emit falló (no fatal)', { orderId: order.id, error })
  }

  return { order, created: isNew }
}
```

- [ ] **Step 4: Correr → PASS.** Nota: si el test de `resolveProductId` requiere `menuCategory` en prismaMock ya está (`createMockModel` genérico); verificar que `paymentAllocation` esté registrado en setup.ts — si no, agregarlo.
- [ ] **Step 5: Commit** — `git commit -m "feat(delivery): ingesta de pedidos delivery → Order+Payment externo+socket"`

---

### Task 5: Webhook controller + rutas + contrato ACK

**Files:**
- Create: `src/services/delivery-channels/core/deliveryWebhookEvent.service.ts`
- Create: `src/controllers/delivery-channels/deliverect.webhook.controller.ts`
- Modify: `src/routes/webhook.routes.ts` (agregar rutas al final, antes del export)
- Test: `tests/unit/controllers/delivery-channels/deliverect.webhook.ack.test.ts`

**Interfaces:**
- Consumes: `verifyDeliverectHmac` (T2), `parseDeliverectOrder` (T3), `ingestDeliveryOrder` (T4)
- Produces: `persistDeliveryEvent(...)` → `{ event, duplicate }`; ruta `POST /api/v1/webhooks/delivery/deliverect/:channelLinkId/orders`; `GET /api/v1/webhooks/delivery/deliverect/health`

- [ ] **Step 1: Tests ACK (espejo de `tests/unit/controllers/tpv/blumon-webhook.controller.ack.test.ts` — leerlo antes).** Casos: 401 si HMAC inválido; 404 si channelLinkId no existe o DISABLED; **200 solo si el evento se persistió**; DUPLICATE → 200 sin re-procesar; error de BD al persistir → **503** (retry de Deliverect); error de ingesta DESPUÉS de persistir → 200 con evento FAILED (lo levanta la reconciliación, no el retry del proveedor); health → 200.
- [ ] **Step 2: Correr → FAIL.**
- [ ] **Step 3: Implementar `deliveryWebhookEvent.service.ts`:**

```typescript
import prisma from '../../../utils/prismaClient'
import { DeliveryOrderEvent, DeliveryOrderEventStatus, DeliveryProvider, Prisma } from '@prisma/client'

export async function persistDeliveryEvent(params: {
  provider: DeliveryProvider
  externalEventId: string
  eventType: string
  channelLinkId: string
  venueId: string
  payload: unknown
}): Promise<{ event: DeliveryOrderEvent; duplicate: boolean }> {
  try {
    const event = await prisma.deliveryOrderEvent.create({
      data: {
        provider: params.provider,
        externalEventId: params.externalEventId,
        eventType: params.eventType,
        channelLinkId: params.channelLinkId,
        venueId: params.venueId,
        payload: params.payload as Prisma.InputJsonValue,
      },
    })
    return { event, duplicate: false }
  } catch (e: any) {
    if (e?.code === 'P2002') {
      const existing = await prisma.deliveryOrderEvent.findUnique({
        where: {
          provider_externalEventId_eventType: {
            provider: params.provider,
            externalEventId: params.externalEventId,
            eventType: params.eventType,
          },
        },
      })
      if (existing) return { event: existing, duplicate: true }
    }
    throw e
  }
}

export async function markEventResult(eventId: string, status: DeliveryOrderEventStatus, orderId?: string, error?: string): Promise<void> {
  await prisma.deliveryOrderEvent.update({
    where: { id: eventId },
    data: { status, orderId, error, processedAt: new Date() },
  })
}
```

- [ ] **Step 4: Implementar el controller** (Buffer crudo → HMAC → link → persistir → ingerir → status update AUTO):

```typescript
import { Request, Response } from 'express'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { DeliveryOrderEventStatus, DeliveryProvider } from '@prisma/client'
import { verifyDeliverectHmac, DELIVERECT_HMAC_HEADER } from '../../services/delivery-channels/providers/deliverect/deliverect.hmac'
import { parseDeliverectOrder } from '../../services/delivery-channels/providers/deliverect/deliverect.mapper'
import { ingestDeliveryOrder } from '../../services/delivery-channels/core/deliveryOrderIngestion.service'
import { persistDeliveryEvent, markEventResult } from '../../services/delivery-channels/core/deliveryWebhookEvent.service'

export async function handleDeliverectOrderWebhook(req: Request, res: Response): Promise<void> {
  try {
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}))
    const link = await prisma.deliveryChannelLink.findUnique({ where: { id: req.params.channelLinkId } })
    if (!link || link.status === 'DISABLED') {
      res.status(404).json({ success: false, message: 'Canal no registrado' })
      return
    }
    if (!verifyDeliverectHmac(rawBody, req.header(DELIVERECT_HMAC_HEADER), link.webhookSecret)) {
      logger.warn('[🛵 DeliverectWebhook] HMAC inválido', { channelLinkId: link.id })
      res.status(401).json({ success: false, message: 'Firma inválida' })
      return
    }

    let normalized
    try {
      normalized = parseDeliverectOrder(rawBody, link)
    } catch (e: any) {
      res.status(400).json({ success: false, message: e.message })
      return
    }

    // Contrato ACK (patrón Blumon): persistir ANTES de responder 200.
    const { event, duplicate } = await persistDeliveryEvent({
      provider: DeliveryProvider.DELIVERECT,
      externalEventId: normalized.externalId,
      eventType: 'order',
      channelLinkId: link.id,
      venueId: link.venueId,
      payload: normalized.raw,
    })
    if (duplicate) {
      res.status(200).json({ success: true, status: 'DUPLICATE', eventId: event.id })
      return
    }

    try {
      const { order } = await ingestDeliveryOrder(normalized, link)
      await markEventResult(event.id, DeliveryOrderEventStatus.PROCESSED, order.id)
      res.status(200).json({ success: true, status: 'PROCESSED', orderId: order.id, eventId: event.id })
    } catch (e: any) {
      // Evento YA persistido → 200 (la reconciliación lo reintenta; el proveedor no debe re-postear)
      logger.error('[🛵 DeliverectWebhook] Ingesta falló, evento FAILED para reconciliación', { eventId: event.id, error: e?.message })
      await markEventResult(event.id, DeliveryOrderEventStatus.FAILED, undefined, e?.message ?? 'unknown')
      res.status(200).json({ success: true, status: 'FAILED_WILL_RETRY', eventId: event.id })
    }
  } catch (e: any) {
    // Ni siquiera pudimos persistir el evento → 503 para que Deliverect reintente
    logger.error('[🛵 DeliverectWebhook] Error pre-persistencia', { error: e?.message })
    res.status(503).json({ success: false, message: 'Error temporal, reintentar' })
  }
}

export function deliverectWebhookHealthCheck(_req: Request, res: Response): void {
  res.status(200).json({ status: 'healthy', service: 'deliverect-webhook', timestamp: new Date().toISOString() })
}
```

- [ ] **Step 5: Rutas en `webhook.routes.ts`** (mismo router raw-body ya montado en app.ts:110-114 — el orden de mounting NO se toca):

```typescript
import { handleDeliverectOrderWebhook, deliverectWebhookHealthCheck } from '../controllers/delivery-channels/deliverect.webhook.controller'
// ...
router.post('/delivery/deliverect/:channelLinkId/orders', handleDeliverectOrderWebhook)
router.get('/delivery/deliverect/health', deliverectWebhookHealthCheck)
```

- [ ] **Step 6: Correr tests → PASS.** Correr también la suite existente de webhooks: `npx jest tests/unit/controllers/tpv/blumon-webhook.controller.ack.test.ts` (regresión: nada del router compartido se rompió).
- [ ] **Step 7: Commit** — `git commit -m "feat(delivery): webhook Deliverect con HMAC + contrato ACK persist-first"`

---

### Task 6: Cron de reconciliación de eventos FAILED

**Files:**
- Create: `src/jobs/delivery-webhook-reconciliation.job.ts`
- Modify: `src/server.ts` (registrar start/stop junto al BlumonWebhookReconciliationJob)
- Test: `tests/unit/jobs/delivery-webhook-reconciliation.job.test.ts`

**Interfaces:**
- Consumes: `parseDeliverectOrder`, `ingestDeliveryOrder`, `markEventResult`
- Produces: `DeliveryWebhookReconciliationJob` (clase singleton `start()/stop()`)

- [ ] **Step 1: Tests.** Casos: procesa eventos FAILED <24h (re-parsea payload del evento + reingesta → PROCESSED); evento FAILED >24h → error `ORPHANED` (no reintenta más); lectura inicial envuelta en `retry(..., { shouldRetry: shouldRetryDbConnectionError })` (mockear retry y verificar que se usa); batch cap 50.
- [ ] **Step 2: Implementar** siguiendo la estructura EXACTA de `src/jobs/blumon-webhook-reconciliation.job.ts` (clase + CronJob + tz America/Mexico_City) con estas diferencias: `CRON_PATTERN = '45 */2 * * * *'` (cada 2 min al segundo :45 — NUNCA en :00 exacto, regla anti-stampede), `BATCH_SIZE = 50`, y la query inicial:

```typescript
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
// dentro de run():
const events = await retry(
  () => prisma.deliveryOrderEvent.findMany({
    where: { status: 'FAILED', receivedAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
    orderBy: { receivedAt: 'asc' },
    take: this.BATCH_SIZE,
    include: { channelLink: true },
  }),
  { shouldRetry: shouldRetryDbConnectionError, context: 'deliveryWebhookReconciliation.scan' },
)
```

Por cada evento: si `channelLink` null → ORPHANED; si no, `parseDeliverectOrder(Buffer.from(JSON.stringify(event.payload)), event.channelLink)` → `ingestDeliveryOrder` → `markEventResult(PROCESSED, order.id)`; catch → dejar FAILED (lo reintenta la próxima pasada) y >24h → sweep a error `ORPHANED`.
- [ ] **Step 3: Registrar en `src/server.ts`** junto al job de Blumon (start en boot, stop en SIGTERM — copiar las 2 líneas del patrón existente).
- [ ] **Step 4: Tests → PASS. Commit** — `git commit -m "feat(delivery): cron reconciliación eventos delivery FAILED"`

---

### Task 7: Menu snapshot service (core)

**Files:**
- Create: `src/services/delivery-channels/core/menuSnapshot.service.ts`
- Test: `tests/unit/services/delivery-channels/menuSnapshot.test.ts`

**Interfaces:**
- Produces: `MenuSnapshot` (tipo), `buildMenuSnapshot(venueId: string): Promise<MenuSnapshot>`. Actualizar `DeliveryProviderAdapter.pushMenu` (T2) para usar `MenuSnapshot` si quedó como `unknown`.

- [ ] **Step 1: Tests (prismaMock).** Casos: arma snapshot con categorías activas → productos activos (`sku` como plu, `price` numérico en PESOS, `imageUrl`, `description`) → modifier groups (`required/minSelections/maxSelections/allowMultiple`) → modifiers activos con precio; excluye productos/categorías inactivos; venue sin menú → snapshot vacío (no truena); respeta `displayOrder`.
- [ ] **Step 2: Implementar:**

```typescript
import prisma from '../../../utils/prismaClient'

export interface MenuSnapshotModifier { plu: string; name: string; price: number }
export interface MenuSnapshotModifierGroup {
  id: string; name: string; required: boolean; allowMultiple: boolean
  minSelections: number; maxSelections: number | null; modifiers: MenuSnapshotModifier[]
}
export interface MenuSnapshotProduct {
  plu: string; name: string; description: string | null; price: number
  imageUrl: string | null; modifierGroups: MenuSnapshotModifierGroup[]
}
export interface MenuSnapshotCategory { name: string; products: MenuSnapshotProduct[] }
export interface MenuSnapshot { venueId: string; generatedAt: string; categories: MenuSnapshotCategory[] }

/** Menú completo del venue en PESOS — fuente de verdad para publicar a cualquier canal. */
export async function buildMenuSnapshot(venueId: string): Promise<MenuSnapshot> {
  const categories = await prisma.menuCategory.findMany({
    where: { venueId, active: true },
    orderBy: { displayOrder: 'asc' },
    include: {
      products: {
        where: { active: true },
        orderBy: { displayOrder: 'asc' },
        include: {
          modifierGroups: {
            orderBy: { displayOrder: 'asc' },
            include: { group: { include: { modifiers: { where: { active: true } } } } },
          },
        },
      },
    },
  })

  return {
    venueId,
    generatedAt: new Date().toISOString(),
    categories: categories
      .filter(c => c.products.length > 0)
      .map(c => ({
        name: c.name,
        products: c.products.map(p => ({
          plu: p.sku,
          name: p.name,
          description: p.description,
          price: Number(p.price),
          imageUrl: p.imageUrl,
          modifierGroups: p.modifierGroups.map(pmg => ({
            id: pmg.group.id,
            name: pmg.group.name,
            required: pmg.group.required,
            allowMultiple: pmg.group.allowMultiple,
            minSelections: pmg.group.minSelections,
            maxSelections: pmg.group.maxSelections,
            modifiers: pmg.group.modifiers.map(m => ({ plu: `MOD-${m.id}`, name: m.name, price: Number(m.price) })),
          })),
        })),
      })),
  }
}
```

Nota: `Product.active` — verificar el nombre exacto del campo de disponibilidad en el modelo Product (leer `prisma/schema.prisma` model Product completo antes de implementar; si el campo es `available` o similar, ajustar el `where` y los tests).
- [ ] **Step 3: Tests → PASS. Commit** — `git commit -m "feat(delivery): menu snapshot service (menú completo del venue, pesos)"`

---

### Task 8: Deliverect menu mapper (snapshot → formato Deliverect)

**Files:**
- Modify: `src/services/delivery-channels/providers/deliverect/deliverect.mapper.ts` (agregar)
- Test: `tests/unit/services/delivery-channels/deliverect.menu.test.ts`

**Interfaces:**
- Consumes: `MenuSnapshot` (T7)
- Produces: `mapSnapshotToDeliverectProducts(snapshot: MenuSnapshot): DeliverectProductsPayload`

- [ ] **Step 1: Tests.** Casos: precios PESOS → **centavos** (`45.00` → `4500`); productos con `plu`, `name`, `description`, `imageURL`; modifier groups anidados con min/max; snapshot vacío → payload con products `[]`; redondeo correcto (`19.31` → `1931`, nunca flotantes).
- [ ] **Step 2: Implementar** (shape según POS_API/create-a-menu docs — `// REVALIDAR EN STAGING` el shape exacto):

```typescript
export interface DeliverectProductsPayload {
  products: Array<{
    plu: string; name: string; description?: string; price: number // CENTAVOS
    imageURL?: string; productType: number // 1=product, 2=modifier, 3=modifierGroup
    subProducts?: string[]
  }>
}

/** PESOS → centavos. La ÚNICA multiplicación ×100 permitida (frontera Deliverect). */
const toCents = (pesos: number): number => Math.round(pesos * 100)

export function mapSnapshotToDeliverectProducts(snapshot: import('../../core/menuSnapshot.service').MenuSnapshot): DeliverectProductsPayload {
  const products: DeliverectProductsPayload['products'] = []
  for (const category of snapshot.categories) {
    for (const p of category.products) {
      products.push({
        plu: p.plu,
        name: p.name,
        description: p.description ?? undefined,
        price: toCents(p.price),
        imageURL: p.imageUrl ?? undefined,
        productType: 1,
        subProducts: p.modifierGroups.map(g => `GRP-${g.id}`),
      })
      for (const g of p.modifierGroups) {
        if (!products.some(x => x.plu === `GRP-${g.id}`)) {
          products.push({ plu: `GRP-${g.id}`, name: g.name, price: 0, productType: 3, subProducts: g.modifiers.map(m => m.plu) })
          for (const m of g.modifiers) {
            if (!products.some(x => x.plu === m.plu)) {
              products.push({ plu: m.plu, name: m.name, price: toCents(m.price), productType: 2 })
            }
          }
        }
      }
    }
  }
  return { products }
}
```

- [ ] **Step 3: Tests → PASS. Commit** — `git commit -m "feat(delivery): mapper de menú a formato Deliverect (pesos→centavos en frontera)"`

---

### Task 9: Deliverect API client + status dispatcher

**Files:**
- Create: `src/services/delivery-channels/providers/deliverect/deliverect.client.ts`
- Create: `src/services/delivery-channels/core/statusDispatcher.service.ts`
- Create: `src/services/delivery-channels/providers/deliverect/deliverect.adapter.ts` (une todo: implementa `DeliveryProviderAdapter`)
- Modify: `tests/__helpers__/setup.ts` (env vars del client — regla: env de SDK clients va en setup.ts, no en el test)
- Test: `tests/unit/services/delivery-channels/statusDispatcher.test.ts`

**Interfaces:**
- Consumes: `DELIVERECT_STATUS_MAP` (T3), `DeliveryProviderAdapter` (T2)
- Produces: `deliverectClient` (`getToken()`, `postOrderStatus(remoteOrderId, statusCode)`, `pushProducts(...)`, `busyMode(...)`), `dispatchOrderStatus(order: Order, status: DeliveryOrderStatus): Promise<void>`, `deliverectAdapter: DeliveryProviderAdapter`, registry `getAdapter(provider)`.

- [ ] **Step 1: Env vars en `tests/__helpers__/setup.ts`:**

```typescript
process.env.DELIVERECT_API_URL = process.env.DELIVERECT_API_URL || 'https://api.staging.deliverect.com'
process.env.DELIVERECT_CLIENT_ID = process.env.DELIVERECT_CLIENT_ID || 'test-deliverect-client-id'
process.env.DELIVERECT_CLIENT_SECRET = process.env.DELIVERECT_CLIENT_SECRET || 'test-deliverect-client-secret'
```

- [ ] **Step 2: Tests del dispatcher** (mock del client con `jest.mock`): busca el `DeliveryChannelLink` de la orden (por venueId + provider ACTIVE); si la orden no es delivery (`originSystem !== DELIVERY_PLATFORM`) → no-op **(regresión: órdenes TPV/QR jamás disparan llamadas a Deliverect)**; mapea `ACCEPTED→20`; errores del client se loguean y NO lanzan (status update fallido nunca tumba el flujo del POS); link PAUSED → no-op.
- [ ] **Step 3: Implementar `deliverect.client.ts`** — axios con `baseURL: process.env.DELIVERECT_API_URL`, OAuth client-credentials (`POST /oauth/token` con client_id/secret, cache del token en memoria hasta expiry — `// REVALIDAR EN STAGING` paths exactos), métodos `postOrderStatus(channelOrderId, statusCode)` → `POST /orders/{id}/status`, `pushProducts(accountId, locationId, payload)`, `setBusyMode(locationId, paused)`. Todos lanzan `DeliverectApiError` con status+body para logging.
- [ ] **Step 4: Implementar `statusDispatcher.service.ts`** (core): recibe `(order, status)`, corta si `order.originSystem !== 'DELIVERY_PLATFORM'`, resuelve link ACTIVE del venue, llama `getAdapter(link.provider).sendStatusUpdate(...)` con try/catch + logger. `getAdapter` = registry simple `{ DELIVERECT: deliverectAdapter }` que lanza para providers no implementados.
- [ ] **Step 5: Implementar `deliverect.adapter.ts`** juntando hmac+mapper+client en el objeto `deliverectAdapter: DeliveryProviderAdapter`.
- [ ] **Step 6: Tests → PASS. Commit** — `git commit -m "feat(delivery): client Deliverect + status dispatcher + adapter completo"`

---

### Task 10: Gestión de canales — service + controller + rutas + ActivityLog

**Files:**
- Create: `src/services/delivery-channels/core/deliveryChannelLink.service.ts`
- Create: `src/controllers/delivery-channels/deliveryChannels.controller.ts`
- Create: `src/schemas/delivery-channels.schema.ts` (Zod, mensajes en ESPAÑOL, shape-only)
- Create: `src/routes/delivery-channels.routes.ts`
- Modify: `src/routes/index.ts` (`router.use('/delivery-channels', deliveryChannelsRoutes)`)
- Test: `tests/unit/services/delivery-channels/deliveryChannelLink.service.test.ts`

**Interfaces:**
- Produces: `listChannelLinks(venueId)`, `createChannelLink(venueId, data, performedBy?)`, `updateChannelLink(venueId, linkId, data, performedBy?)`, `pauseChannelLink(venueId, linkId, paused, performedBy?)`; rutas REST `GET/POST /venues/:venueId/channels`, `PATCH /venues/:venueId/channels/:linkId`, `POST /venues/:venueId/channels/:linkId/pause`.

- [ ] **Step 1: Tests del service.** Casos: create genera `webhookSecret` random (crypto.randomBytes(32).toString('hex')) y status PENDING; update/pause SIEMPRE `where: { id, venueId }` (tenant isolation — update de link de otro venue → NotFoundError); pause llama `adapter.setChannelPaused` best-effort; **cada mutación escribe ActivityLog** (`DELIVERY_CHANNEL_CONNECTED` / `DELIVERY_CHANNEL_UPDATED` / `DELIVERY_CHANNEL_PAUSED`) con `staffId=performedBy`, `venueId`, `data` — vía `logAction` de `src/services/dashboard/activity-log.service.ts` (fire-and-forget, fuera de tx); listChannelLinks NUNCA devuelve `webhookSecret`.
- [ ] **Step 2: Implementar service** (mutations + `void logAction(...)` + select explícito sin secret).
- [ ] **Step 3: Zod schema** (español, shape-only): `provider: z.enum([...], { message: 'Proveedor inválido' })`, `externalLocationId: z.string().min(1, 'El ID de ubicación es requerido')`, etc.
- [ ] **Step 4: Controller thin** (extrae `(req as any).authContext` → `venueId`/`userId` como performedBy — NUNCA `req.user`) + **rutas**:

```typescript
import { Router } from 'express'
import { authenticateTokenMiddleware } from '../middlewares/authenticateToken.middleware'
import { checkPermission } from '../middlewares/checkPermission.middleware'
import { checkFeatureAccess } from '../middlewares/checkFeatureAccess.middleware'
import { validateRequest } from '../middlewares/validation'
import * as ctrl from '../controllers/delivery-channels/deliveryChannels.controller'
import { createChannelSchema, updateChannelSchema } from '../schemas/delivery-channels.schema'

const router = Router({ mergeParams: true })

router.get('/venues/:venueId/channels', authenticateTokenMiddleware, checkPermission('delivery-channels:read'), checkFeatureAccess('DELIVERY_CHANNELS'), ctrl.listChannels)
router.post('/venues/:venueId/channels', authenticateTokenMiddleware, validateRequest(createChannelSchema), checkPermission('delivery-channels:manage'), checkFeatureAccess('DELIVERY_CHANNELS'), ctrl.createChannel)
router.patch('/venues/:venueId/channels/:linkId', authenticateTokenMiddleware, validateRequest(updateChannelSchema), checkPermission('delivery-channels:manage'), checkFeatureAccess('DELIVERY_CHANNELS'), ctrl.updateChannel)
router.post('/venues/:venueId/channels/:linkId/pause', authenticateTokenMiddleware, checkPermission('delivery-channels:manage'), checkFeatureAccess('DELIVERY_CHANNELS'), ctrl.pauseChannel)

export default router
```

(Verificar la firma exacta de `validateRequest` y el orden validación-antes-de-permiso usados en rutas existentes — copiar el patrón de `tpv-commands` en `permissions-policy.md`.)
- [ ] **Step 5: Registrar en `src/routes/index.ts`. Tests → PASS. Commit** — `git commit -m "feat(delivery): gestión de canales (CRUD+pause) con gating, permisos y ActivityLog"`

---

### Task 11: Feature PREMIUM + permisos en catálogo

**Files:**
- Create: `scripts/seed-delivery-channels-feature.ts`
- Modify: `src/services/access/basePlan.service.ts:25-37` (`PREMIUM_ONLY_CODES`)
- Modify: `src/lib/permissions.ts` (`INDIVIDUAL_PERMISSIONS_BY_RESOURCE` ~línea 1370, `DEFAULT_PERMISSIONS` ~línea 517)
- Test: correr `npm run audit:permissions`

- [ ] **Step 1: Seed** (calcado de `scripts/seed-cfdi-feature.ts`):

```typescript
/**
 * Seed: DELIVERY_CHANNELS feature (PREMIUM — decisión founder 2026-07-18).
 * Hygiene-only: registra el Feature row; el gating funciona por blanket grant PREMIUM
 * + PREMIUM_ONLY_CODES. Idempotente. Run:
 *   npx ts-node -r tsconfig-paths/register scripts/seed-delivery-channels-feature.ts
 */
import prisma from '../src/utils/prismaClient'
import logger from '../src/config/logger'

async function main() {
  await prisma.feature.upsert({
    where: { code: 'DELIVERY_CHANNELS' },
    update: { active: true },
    create: {
      code: 'DELIVERY_CHANNELS',
      name: 'Delivery (Uber Eats, Rappi, DiDi)',
      description: 'Pedidos de plataformas de delivery directo en tu POS y cocina (vía Deliverect)',
      category: 'INTEGRATIONS',
      monthlyPrice: 0, // se cobra vía tier PREMIUM, no como add-on suelto
      active: true,
    },
  })
  logger.info('✅ Seeded DELIVERY_CHANNELS feature')
}

main().catch(e => { logger.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
```

- [ ] **Step 2: `PREMIUM_ONLY_CODES`** — agregar `'DELIVERY_CHANNELS', // Delivery apps vía agregador (2026-07-18)` al array. ⚠️ El comentario del array exige espejo en `avoqado-web-dashboard/src/config/plan-catalog.ts` PREMIUM `includes` — **fuera de scope backend-only: anotar como pendiente del teaser** (dejar TODO-tracking en el spec, no en código).
- [ ] **Step 3: Permisos** — en `INDIVIDUAL_PERMISSIONS_BY_RESOURCE`: `'delivery-channels': ['delivery-channels:read', 'delivery-channels:manage']`. En `DEFAULT_PERMISSIONS`: OWNER y ADMIN += ambos; MANAGER += `delivery-channels:read`.
- [ ] **Step 4:** Run `npm run audit:permissions` → exit 0 (sin PHANTOM/CATALOG_GAP nuevos). Run seed contra dev DB.
- [ ] **Step 5: Commit** — `git commit -m "feat(delivery): feature DELIVERY_CHANNELS PREMIUM + permisos delivery-channels"`

---

### Task 12: MCP tool `delivery_channels` (lockstep)

**Files:**
- Create: `src/mcp/tools/deliveryChannels.ts`
- Modify: `src/mcp/server.ts` (import + `registerDeliveryChannelTools(server, scope)` en `registerAllTools`)
- Test: `tests/unit/mcp/deliveryChannels.tool.test.ts` (si existe patrón de tests de tools; si no, verificación por build + smoke del registro)

- [ ] **Step 1: Implementar** (patrón exacto de `src/mcp/tools/features.ts` — guard + venueFilter + text; gate por **Feature resolver**, jamás Module):

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'

export function registerDeliveryChannelTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'delivery_channels',
    'Estado de los canales de delivery del venue (Uber Eats/Rappi/DiDi vía Deliverect): canales conectados, estado (activo/pausado), último sync de menú, y pedidos de delivery de hoy por canal. Responde "¿cómo van mis canales de delivery? ¿cuántos pedidos de Uber/Rappi hoy?". Pass venueId.',
    { venueId: z.string().describe('Venue cuyos canales de delivery leer (debe estar en tu scope)') },
    async ({ venueId }) => {
      const where = guard.venueFilter(venueId)
      if (!(await venueHasFeatureAccess(venueId, 'DELIVERY_CHANNELS'))) {
        return text({ ok: false, featureRequired: 'DELIVERY_CHANNELS', error: 'El venue no tiene el módulo de Delivery (plan PREMIUM).' })
      }
      const links = await prisma.deliveryChannelLink.findMany({
        where: { venueId: where.venueId ?? venueId },
        select: { id: true, provider: true, status: true, orderAcceptanceMode: true, autoSyncMenu: true, lastMenuSyncAt: true, externalLocationId: true },
      })
      const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0) // aproximación server-tz; ventana operativa, no reporte fiscal
      const todayOrders = await prisma.order.groupBy({
        by: ['source'],
        where: { venueId, originSystem: 'DELIVERY_PLATFORM', createdAt: { gte: startOfToday } },
        _count: { id: true },
        _sum: { total: true },
      })
      return text({
        venueId,
        channels: links.map(l => ({ ...l, lastMenuSyncAt: l.lastMenuSyncAt?.toISOString() ?? null })),
        todayByChannel: todayOrders.map(g => ({ channel: g.source, orders: g._count.id, totalPesos: Number(g._sum.total ?? 0) })),
      })
    },
  )
}
```

Nota fechas: para totales de dinero por rango este tool solo agrega conteo operativo del día; si se convierte en tool de reportes, migrar a `venueStartOfDay` (regla venue-local). Dejar el comentario en código.
- [ ] **Step 2: Registrar en `src/mcp/server.ts`** junto a `registerFeatureTools(server, scope)`.
- [ ] **Step 3: Build + tests → PASS. Commit** — `git commit -m "feat(mcp): tool delivery_channels (lockstep con feature DELIVERY_CHANNELS)"`

---

### Task 13: Verificación final y regresión

- [ ] **Step 1:** `npm run format && npm run lint:fix` — cero warnings.
- [ ] **Step 2:** Regresión de consumidores de `OrderSource`: `grep -rn "OrderSource\." src/ | grep -v delivery-channels | grep -iv "import"` — revisar cada switch/if que enumere valores: deben tener default/fallthrough seguro (reportes agrupan dinámicamente — confirmar que ninguno lanza con valores nuevos).
- [ ] **Step 3:** `npx jest tests/unit --silent` — suite unit completa verde (incluye regresión pos-sync, blumon, TPV).
- [ ] **Step 4:** `TZ=UTC npx jest tests/unit/services/delivery-channels tests/unit/mcp --silent` — verde bajo tz de prod.
- [ ] **Step 5:** `npm run pre-deploy` — MUST pass.
- [ ] **Step 6:** Actualizar memoria del proyecto (`delivery-aggregator-research.md`: scaffold construido, pendiente credenciales).
- [ ] **Step 7: Commit final** — `git commit -m "chore(delivery): verificación final scaffold delivery-channels"` (si quedó algo suelto de format).

---

## Self-review del plan (hecho)

- **Cobertura vs spec:** schema §4→T1; webhook+ACK §5→T5; ingesta §5→T4; menú §6→T7-T8; status §5→T9; gating/permisos/MCP/ActivityLog §7→T10-T12; regresión §8→T13; HMAC §5→T2; reconciliación §5→T6. Fuera de scope §9 respetado (sin dashboard, sin MANUAL, sin CFDI).
- **Sin placeholders:** los `// REVALIDAR EN STAGING` son constantes aisladas del adapter esperando credenciales (documentado en spec §10), no huecos del plan.
- **Consistencia de tipos:** `NormalizedDeliveryOrder` (T2) consumido por T3/T4/T6; `MenuSnapshot` (T7) por T8/T9; `DELIVERECT_STATUS_MAP` (T3) por T9; nombres de permisos idénticos en T10/T11.
- **Pendiente cross-repo anotado:** espejo de `DELIVERY_CHANNELS` en `plan-catalog.ts` del dashboard (fase teaser).
