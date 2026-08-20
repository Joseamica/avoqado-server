# Núcleo único de delivery + adaptadores por proveedor — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que Uber Eats, Rappi y DiDi Food compartan UNA sola lógica de negocio, con un adaptador delgado por proveedor que solo traduce.

**Architecture:** El contrato de datos del core (`NormalizedDeliveryOrder`) se reemplaza por el de Uber (`NormalizedUberOrder`), que ya
lleva el dinero como string decimal con invariantes verificadas. El core ingiere; los adaptadores traducen. Un registro `provider → adapter`
es el único lugar donde se menciona un proveedor por nombre.

**Tech Stack:** TypeScript, Express, Prisma/PostgreSQL, Jest (proyectos `unit` e `integration`).

**Spec:** `docs/superpowers/specs/2026-08-20-delivery-multiproveedor-design.md`

## Global Constraints

- **Dinero: `Prisma.Decimal` o string decimal. NUNCA `number`.** Regla dura del repo (`.claude/rules/critical-warnings.md`). Un `number` en
  un campo de dinero es un defecto, no un estilo.
- **Pesos 1:1, unidades mayores.** `1.00` = un peso. El `÷100` de centavos ocurre SOLO en el mapper de cada proveedor.
- **Todo query filtra por `venueId` u `orgId`.** Sin excepción.
- **Tests primero en todo lo que toque dinero.** Rojo → verde → commit.
- **Mensajes de Zod en español.**
- **No tocar Deliverect más allá de lo que este plan indica.** Su migración es un trabajo aparte.
- Correr `npm run format && npm run lint:fix` antes de cada commit.
- Verificación pesada por `../scripts/avq-verify.sh` desde el root del workspace; `npx tsc -p tsconfig.build.json --noEmit` para typecheck.

---

## File Structure

| Archivo                                                                             | Responsabilidad                                                                  |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `src/services/delivery-channels/core/types.ts`                                      | **Modificar.** El contrato de datos y el del adaptador. Dinero a string decimal. |
| `src/services/delivery-channels/core/money.ts`                                      | **Crear.** Validación de invariantes de dinero, pura y reutilizable.             |
| `src/services/delivery-channels/core/adapterRegistry.ts`                            | **Crear.** El único `provider → adapter`.                                        |
| `src/services/delivery-channels/core/deliveryOrderIngestion.service.ts`             | **Modificar.** Adopta el contrato nuevo; arregla la propina.                     |
| `src/services/delivery-channels/providers/uber-eats/uber.adapter.ts`                | **Crear.** Implementa el contrato; delega en lo que ya existe.                   |
| `src/services/delivery-channels/providers/uber-eats/uber.orderIngestion.service.ts` | **Borrar** al final de la Tarea 4.                                               |
| `tests/unit/services/delivery-channels/deliveryMoney.test.ts`                       | **Crear.** Invariantes de dinero.                                                |
| `tests/unit/services/delivery-channels/adapterRegistry.test.ts`                     | **Crear.** Incluye el guardrail anti-`if`.                                       |
| `tests/integration/delivery-channels/deliveryOrderIngestion.contract.test.ts`       | **Crear.** Suite de contrato compartida.                                         |

---

## Task 1: Invariantes de dinero, aisladas y puras

**Files:**

- Create: `src/services/delivery-channels/core/money.ts`
- Modify: `src/services/delivery-channels/core/types.ts` (**sólo añadir** `NormalizedDeliveryPayment`)
- Test: `tests/unit/services/delivery-channels/deliveryMoney.test.ts`

**Interfaces:**

- Consumes: nada.
- Produces: `NormalizedDeliveryPayment` (la interface), `assertDeliveryMoneyInvariants(payment: NormalizedDeliveryPayment): void` (lanza
  `DeliveryMoneyMismatchError`), `DeliveryMoneyMismatchError`.

Esta lógica hoy vive dentro de `uber.orderIngestion.service.ts:55` (`assertMoneyInvariants`). Se extrae para que TODOS los proveedores la
compartan y sea testeable sin base de datos.

⚠️ **`NormalizedDeliveryPayment` se añade AQUÍ, no en la Tarea 2**, porque `money.ts` lo necesita para compilar. Es puramente aditivo: no
toca ningún tipo existente, así que el árbol sigue verde y esta tarea puede commitear sola.

- [ ] **Step 0: Añadir la interface a `core/types.ts`**

Pégala al final del archivo, sin tocar nada de lo que ya está:

```typescript
/**
 * Reparto explícito de quién cobra qué. Lo entrega el ADAPTADOR; el core NO deduce nada.
 * Invariantes (verificadas por `assertDeliveryMoneyInvariants` en `core/money.ts`):
 *   saleAmount + merchantFees === externallyPaidSale + cashDueSale
 *   tipAmount                 === externallyPaidTip  + cashDueTip
 *
 * 🔴 Dinero en STRING DECIMAL, nunca `number` (`.claude/rules/critical-warnings.md`).
 */
export interface NormalizedDeliveryPayment {
  currency: 'MXN'
  /** artículos, IVA incluido (México) */
  saleAmount: string
  /** cargos cobrados al cliente que se pagan AL COMERCIO (bolsa, envío propio…) */
  merchantFees: string
  tipAmount: string
  /** parte de (saleAmount + merchantFees) que la plataforma liquida al comercio */
  externallyPaidSale: string
  externallyPaidTip: string
  /** parte que el comercio cobra en efectivo en persona */
  cashDueSale: string
  cashDueTip: string
}
```

- [ ] **Step 1: Escribir el test que falla**

```typescript
// tests/unit/services/delivery-channels/deliveryMoney.test.ts
import { assertDeliveryMoneyInvariants, DeliveryMoneyMismatchError } from '@/services/delivery-channels/core/money'

const base = {
  currency: 'MXN' as const,
  saleAmount: '100.00',
  merchantFees: '20.00',
  tipAmount: '15.00',
  externallyPaidSale: '120.00',
  externallyPaidTip: '15.00',
  cashDueSale: '0.00',
  cashDueTip: '0.00',
}

describe('delivery money invariants', () => {
  it('acepta un reparto que cuadra al centavo', () => {
    expect(() => assertDeliveryMoneyInvariants(base)).not.toThrow()
  })

  it('acepta el reparto mixto: parte en plataforma, parte en efectivo', () => {
    expect(() => assertDeliveryMoneyInvariants({ ...base, externallyPaidSale: '70.00', cashDueSale: '50.00' })).not.toThrow()
  })

  it('🔴 RECHAZA si la venta no cuadra — jamás estima', () => {
    expect(() => assertDeliveryMoneyInvariants({ ...base, cashDueSale: '0.01' })).toThrow(DeliveryMoneyMismatchError)
  })

  it('🔴 RECHAZA si la propina no cuadra', () => {
    expect(() => assertDeliveryMoneyInvariants({ ...base, externallyPaidTip: '14.99' })).toThrow(DeliveryMoneyMismatchError)
  })

  it('🔴 RECHAZA cualquier monto negativo', () => {
    expect(() => assertDeliveryMoneyInvariants({ ...base, tipAmount: '-1.00' })).toThrow(DeliveryMoneyMismatchError)
  })

  it('🔴 RECHAZA moneda distinta de MXN', () => {
    expect(() => assertDeliveryMoneyInvariants({ ...base, currency: 'USD' as never })).toThrow(DeliveryMoneyMismatchError)
  })

  it('el mensaje del error dice qué lado no cuadró, con los dos montos', () => {
    try {
      assertDeliveryMoneyInvariants({ ...base, cashDueSale: '5.00' })
      throw new Error('debió lanzar')
    } catch (e) {
      expect((e as Error).message).toMatch(/120\.00/)
      expect((e as Error).message).toMatch(/125\.00/)
    }
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx jest --selectProjects unit --testPathPattern "deliveryMoney" --runInBand` Expected: FAIL —
`Cannot find module '@/services/delivery-channels/core/money'`

- [ ] **Step 3: Implementar el mínimo**

```typescript
// src/services/delivery-channels/core/money.ts
/**
 * Invariantes de dinero de un pedido de delivery. Módulo PURO: sin Prisma, sin env.
 *
 * 🔴 Si el reparto no cuadra al centavo, RECHAZA. Nunca estima ni redondea a favor:
 * un pedido mal repartido produce un cobro incorrecto que nadie detecta hasta el corte.
 */
import { Prisma } from '@prisma/client'
import type { NormalizedDeliveryPayment } from './types'

export class DeliveryMoneyMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeliveryMoneyMismatchError'
  }
}

const D = (v: string) => new Prisma.Decimal(v)
const q = (d: Prisma.Decimal) => d.toDecimalPlaces(2)

export function assertDeliveryMoneyInvariants(p: NormalizedDeliveryPayment): void {
  if (p.currency !== 'MXN') {
    throw new DeliveryMoneyMismatchError(`Moneda no soportada: "${p.currency}". Sólo MXN.`)
  }

  const campos: Array<[string, string]> = [
    ['saleAmount', p.saleAmount],
    ['merchantFees', p.merchantFees],
    ['tipAmount', p.tipAmount],
    ['externallyPaidSale', p.externallyPaidSale],
    ['externallyPaidTip', p.externallyPaidTip],
    ['cashDueSale', p.cashDueSale],
    ['cashDueTip', p.cashDueTip],
  ]
  for (const [nombre, valor] of campos) {
    let d: Prisma.Decimal
    try {
      d = D(valor)
    } catch {
      throw new DeliveryMoneyMismatchError(`El monto "${nombre}" no es un decimal válido: ${JSON.stringify(valor)}`)
    }
    if (d.isNegative()) throw new DeliveryMoneyMismatchError(`El monto "${nombre}" es negativo: ${valor}`)
  }

  const ventaTotal = q(D(p.saleAmount).plus(D(p.merchantFees)))
  const ventaSplit = q(D(p.externallyPaidSale).plus(D(p.cashDueSale)))
  if (!ventaTotal.equals(ventaSplit)) {
    throw new DeliveryMoneyMismatchError(
      `La venta no cuadra: saleAmount + merchantFees = ${ventaTotal.toFixed(2)}, ` +
        `pero externallyPaidSale + cashDueSale = ${ventaSplit.toFixed(2)}.`,
    )
  }

  const propina = q(D(p.tipAmount))
  const propinaSplit = q(D(p.externallyPaidTip).plus(D(p.cashDueTip)))
  if (!propina.equals(propinaSplit)) {
    throw new DeliveryMoneyMismatchError(
      `La propina no cuadra: tipAmount = ${propina.toFixed(2)}, ` + `pero externallyPaidTip + cashDueTip = ${propinaSplit.toFixed(2)}.`,
    )
  }
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx jest --selectProjects unit --testPathPattern "deliveryMoney" --runInBand` Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
npm run format && npm run lint:fix
git add src/services/delivery-channels/core/money.ts tests/unit/services/delivery-channels/deliveryMoney.test.ts
git commit -m "feat(delivery): invariantes de dinero compartidas, con rechazo en vez de estimación"
```

---

## Task 2: El contrato de datos, con el dinero bien

**Files:**

- Modify: `src/services/delivery-channels/core/types.ts` (reemplaza `NormalizedDeliveryOrder`, `NormalizedDeliveryItem`,
  `DeliveryProviderAdapter`)
- Test: el typecheck es la prueba; no hay test unitario de un `interface`.

**Interfaces:**

- Consumes: `DeliveryMoneyMismatchError` de la Tarea 1 (sólo en docs).
- Produces: `NormalizedDeliveryOrder`, `NormalizedDeliveryItem`, `NormalizedDeliveryModifier`, `NormalizedDeliveryPayment`,
  `DeliveryProviderAdapter`, `ProviderContext`, `EventIdentity`, `WebhookVerdict`.

Es el contrato de `uber.types.ts` promovido a core, más las capacidades del adaptador. **`uber.types.ts` queda como alias re-exportado**
para no romper los 7 tests de integración existentes mientras dura la migración; se borra en la Tarea 4.

- [ ] **Step 1: Reemplazar los tipos de dinero en `core/types.ts`**

```typescript
// src/services/delivery-channels/core/types.ts — reemplaza NormalizedDeliveryItem/Order
/**
 * 🔴 Todo el dinero viaja como STRING DECIMAL, nunca `number`
 * (`.claude/rules/critical-warnings.md`: Money = Decimal, Never Float).
 * El ÷100 de los centavos del proveedor ocurre en SU mapper, jamás aquí ni en el core.
 *
 * Historia: hasta 2026-08-20 este contrato usaba `number` y documentaba como normal que
 * los montos NO cuadraran ("pueden no cuadrar aritméticamente contra total"). Eso es lo
 * que permitió que la propina se contara dos veces. Ahora el reparto es explícito y se
 * verifica con `assertDeliveryMoneyInvariants`.
 */
export interface NormalizedDeliveryModifier {
  externalId: string
  name: string
  quantity: number
  /** PESOS, string decimal. Ya multiplicado por la cantidad del padre si aplica. */
  price: string
}

export interface NormalizedDeliveryItem {
  /** id del item en el catálogo del proveedor */
  externalId: string
  /** Lo que Avoqado escribió al publicar el menú (su `Product.sku`), si el proveedor lo devuelve */
  externalData?: string | null
  name: string
  quantity: number
  /** PESOS, string decimal */
  unitPrice: string
  /** total de la línea = unitPrice × quantity + modificadores */
  total: string
  modifiers?: NormalizedDeliveryModifier[]
}

// `NormalizedDeliveryPayment` YA fue añadida en la Tarea 1 — no la dupliques aquí.

export interface NormalizedDeliveryOrder {
  /** id del pedido en el proveedor. Se namespacea al guardarlo: `{PROVIDER}:{externalId}` */
  externalId: string
  /** número corto que ve el repartidor y va en el ticket */
  displayId: string
  source: OrderSource
  items: NormalizedDeliveryItem[]
  payment: NormalizedDeliveryPayment
  customer?: { name?: string; phone?: string; note?: string }
  /** JSON crudo del proveedor, para auditoría — va a `Order.posRawData` */
  raw: unknown
  placedAt: Date
}
```

- [ ] **Step 2: Extender el contrato del adaptador**

```typescript
// src/services/delivery-channels/core/types.ts — reemplaza DeliveryProviderAdapter
import { DeliveryChannelLink, DeliveryProvider, OrderSource } from '@prisma/client'

export interface ProviderContext {
  link: DeliveryChannelLink
  /** Rappi resuelve dominio por país; el core NUNCA arma URLs. */
  countryCode?: string
}

export interface EventIdentity {
  eventId: string
  eventType: string
  /** id de la tienda en el proveedor — es como se resuelve el venue */
  storeId: string | null
  /** id del PEDIDO (agrupa varios eventos del mismo pedido) */
  orderId: string | null
  /** Presente si el webhook manda un puntero en vez del pedido (Uber). */
  resourceRef?: string | null
}

export type WebhookVerdict = 'VALID' | 'INVALID_SIGNATURE' | 'MALFORMED'

export type DenyReason = 'OUT_OF_ITEMS' | 'STORE_CLOSED' | 'TOO_BUSY' | 'OTHER'

export interface ActionResult {
  ok: boolean
  status: number
  /** Cuerpo crudo — se guarda para auditoría cuando falla. */
  raw: string
}

/**
 * Lo ÚNICO que el core sabe de un proveedor. Las tres primeras capacidades son
 * obligatorias; el resto son opcionales y el core consulta su presencia
 * (`typeof adapter.markReady === 'function'`), nunca quién es el proveedor.
 */
export interface DeliveryProviderAdapter {
  readonly provider: DeliveryProvider

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, secrets: string[]): WebhookVerdict
  extractIdentity(payload: unknown): EventIdentity
  normalizeOrder(raw: unknown, ctx: ProviderContext): NormalizedDeliveryOrder

  /** Sólo si el webhook manda un puntero y hay que ir por el pedido. */
  fetchOrder?(orderId: string, ctx: ProviderContext): Promise<unknown>

  acceptOrder?(orderId: string, ctx: ProviderContext): Promise<ActionResult>
  denyOrder?(orderId: string, reason: DenyReason, ctx: ProviderContext): Promise<ActionResult>
  markReady?(orderId: string, ctx: ProviderContext): Promise<ActionResult>
  publishMenu?(snapshot: MenuSnapshot, ctx: ProviderContext): Promise<ActionResult>
  setStoreStatus?(paused: boolean, ctx: ProviderContext): Promise<ActionResult>
}
```

- [ ] **Step 3: Dejar `uber.types.ts` como alias temporal**

```typescript
// src/services/delivery-channels/providers/uber-eats/uber.types.ts — reemplaza TODO el archivo
/**
 * TEMPORAL — el contrato se promovió a `core/types.ts` (plan 2026-08-20, Tarea 2).
 * Estos alias existen sólo para que los 7 tests de integración de la ingesta de Uber
 * sigan compilando durante la migración. Se BORRA en la Tarea 4.
 */
export type {
  NormalizedDeliveryModifier as NormalizedUberModifier,
  NormalizedDeliveryItem as NormalizedUberItem,
  NormalizedDeliveryPayment as NormalizedUberPayment,
  NormalizedDeliveryOrder as NormalizedUberOrder,
} from '../../core/types'
```

- [ ] **Step 4: Typecheck — debe fallar en Deliverect, y eso es esperado**

Run: `npx tsc -p tsconfig.build.json --noEmit` Expected: FAIL en `providers/deliverect/deliverect.mapper.ts` y en
`core/deliveryOrderIngestion.service.ts` — usan los campos viejos (`subtotal`, `total`, `tipAmount` como `number`). Se arreglan en la
Tarea 3. **Anota los errores exactos**: son la lista de trabajo de la siguiente tarea.

- [ ] **Step 5: NO commitear todavía**

El árbol no compila. La Tarea 3 lo cierra. Commit único al final de la Tarea 3.

---

## Task 3: El core ingiere con el contrato nuevo (y la propina deja de contarse dos veces)

**Files:**

- Modify: `src/services/delivery-channels/core/deliveryOrderIngestion.service.ts`
- Modify: `src/services/delivery-channels/providers/deliverect/deliverect.mapper.ts` (adaptar al contrato nuevo)
- Test: `tests/integration/delivery-channels/deliveryOrderIngestion.test.ts` (existente — extender)

**Interfaces:**

- Consumes: `NormalizedDeliveryOrder`, `NormalizedDeliveryPayment` (Tarea 2); `assertDeliveryMoneyInvariants` (Tarea 1).
- Produces:
  `ingestDeliveryOrder(normalized: NormalizedDeliveryOrder, link: DeliveryChannelLink): Promise<{ order: Order; created: boolean }>` — misma
  firma, contrato nuevo.

**El defecto a matar**, `deliveryOrderIngestion.service.ts:220-221`:

```typescript
amount:    new Prisma.Decimal(normalized.total),      // el total YA incluye la propina
tipAmount: new Prisma.Decimal(normalized.tipAmount),  // y otra vez, aparte
```

- [ ] **Step 1: Escribir el test que falla (dinero — test primero, no negociable)**

```typescript
// tests/integration/delivery-channels/deliveryOrderIngestion.test.ts — añadir al describe existente
it('🔴 Payment.amount es la venta SIN propina; la propina va sólo en tipAmount', async () => {
  const normalized = makeNormalizedOrder({
    payment: {
      currency: 'MXN',
      saleAmount: '200.00',
      merchantFees: '0.00',
      tipAmount: '30.00',
      externallyPaidSale: '200.00',
      externallyPaidTip: '30.00',
      cashDueSale: '0.00',
      cashDueTip: '0.00',
    },
  })

  const { order } = await ingestDeliveryOrder(normalized, link)
  const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } })

  expect(payment.amount.toFixed(2)).toBe('200.00') // la venta, SIN la propina
  expect(payment.tipAmount.toFixed(2)).toBe('30.00') // la propina, aparte
  // Antes: amount venía 230.00 y tipAmount 30.00 ⇒ la propina se contaba dos veces
})

it('🔴 rechaza un pedido cuyo reparto de dinero no cuadra, sin escribir nada', async () => {
  const antes = await prisma.order.count({ where: { venueId: link.venueId } })
  const malo = makeNormalizedOrder({
    payment: {
      currency: 'MXN',
      saleAmount: '100.00',
      merchantFees: '0.00',
      tipAmount: '0.00',
      externallyPaidSale: '99.00',
      externallyPaidTip: '0.00',
      cashDueSale: '0.00',
      cashDueTip: '0.00',
    },
  })

  await expect(ingestDeliveryOrder(malo, link)).rejects.toThrow(DeliveryMoneyMismatchError)
  expect(await prisma.order.count({ where: { venueId: link.venueId } })).toBe(antes)
})
```

- [ ] **Step 2: Correr y verificar que falla**

Run:
`export TEST_DATABASE_URL=$(node -e "require('dotenv/config');process.stdout.write(process.env.TEST_DATABASE_URL||'')") && npx jest --selectProjects integration --testPathPattern "deliveryOrderIngestion" --runInBand`
Expected: FAIL — `payment.amount` da `230.00`, no `200.00`.

- [ ] **Step 3: Adoptar el contrato nuevo en el core**

Cambios concretos en `deliveryOrderIngestion.service.ts`:

1. Al entrar: `assertDeliveryMoneyInvariants(normalized.payment)` **antes de abrir la transacción**. Un pedido que no cuadra no toca la
   base.
2. `Order.subtotal` = `payment.saleAmount`; `Order.total` = `saleAmount + merchantFees` (**sin propina**); `Order.taxAmount` = `0` (México:
   el IVA va incluido en el precio; el impuesto del proveedor no es fuente fiscal — spec §5 de Uber).
3. `Payment.amount` = `payment.externallyPaidSale`; `Payment.tipAmount` = `payment.externallyPaidTip`.
4. Las líneas usan `item.unitPrice`/`item.total` como `Prisma.Decimal(string)`, sin `Number()`.
5. Copiar de `uber.orderIngestion.service.ts` el manejo de `paidAmount`/`remainingBalance` (ya verificado por sus 7 tests).

- [ ] **Step 4: Adaptar el mapper de Deliverect al contrato nuevo**

`deliverect.mapper.ts` produce hoy los campos viejos. Convertir a string decimal con `.toFixed(2)` y construir el reparto: Deliverect
entrega pedidos ya pagados por la plataforma, así que `externallyPaidSale = saleAmount + merchantFees` y `cashDueSale = '0.00'`. **No
cambiar su lógica de negocio**: sólo el formato de salida.

- [ ] **Step 5: Correr y verificar que pasa**

Run: el mismo del Step 2, más `npx jest --selectProjects unit --testPathPattern "delivery-channels" --runInBand` Expected: PASS en ambos.
Los 7 tests de `uberOrderIngestion` deben seguir verdes.

- [ ] **Step 6: Typecheck limpio**

Run: `npx tsc -p tsconfig.build.json --noEmit` Expected: cero errores.

- [ ] **Step 7: Commit**

```bash
npm run format && npm run lint:fix
git add src/services/delivery-channels/core/ src/services/delivery-channels/providers/deliverect/ src/services/delivery-channels/providers/uber-eats/uber.types.ts tests/integration/delivery-channels/deliveryOrderIngestion.test.ts
git commit -m "fix(delivery): el core deja de contar la propina dos veces y el dinero deja de ser float"
```

---

## Task 4: Uber usa el núcleo; su ingesta duplicada desaparece

**Files:**

- Create: `src/services/delivery-channels/providers/uber-eats/uber.adapter.ts`
- Delete: `src/services/delivery-channels/providers/uber-eats/uber.orderIngestion.service.ts`
- Delete: `src/services/delivery-channels/providers/uber-eats/uber.types.ts` (el alias temporal)
- Modify: `tests/integration/delivery-channels/uberOrderIngestion.test.ts` → apunta a `ingestDeliveryOrder`

**Interfaces:**

- Consumes: `DeliveryProviderAdapter`, `ProviderContext` (Tarea 2); `ingestDeliveryOrder` (Tarea 3); `verifyUberSignature`,
  `orderIdFromResourceHref`, `fetchUberOrder`, `uberApi` (ya existen).
- Produces: `uberAdapter: DeliveryProviderAdapter`.

- [ ] **Step 1: Escribir el adaptador**

```typescript
// src/services/delivery-channels/providers/uber-eats/uber.adapter.ts
/**
 * Adaptador de Uber Eats: lo ÚNICO que el core sabe de Uber.
 * Sólo traduce — no crea órdenes, no cobra, no toca inventario. Eso es del núcleo.
 */
import { DeliveryProvider } from '@prisma/client'
import type {
  ActionResult,
  DeliveryProviderAdapter,
  EventIdentity,
  NormalizedDeliveryOrder,
  ProviderContext,
  WebhookVerdict,
} from '../../core/types'
import { fetchUberOrder, uberApi } from './uber.client'
import { orderIdFromResourceHref } from './uber.http'
import { verifyUberSignature } from './uber.signature'

export const uberAdapter: DeliveryProviderAdapter = {
  provider: DeliveryProvider.UBER_EATS,

  verifyWebhook(rawBody, headers, secrets): WebhookVerdict {
    const firma = headers['x-uber-signature']
    const valor = Array.isArray(firma) ? firma[0] : firma
    return secrets.some(s => verifyUberSignature(rawBody, valor, s)) ? 'VALID' : 'INVALID_SIGNATURE'
  },

  extractIdentity(payload): EventIdentity {
    const p = payload as {
      event_id?: unknown
      event_type?: unknown
      resource_href?: unknown
      meta?: { user_id?: unknown; resource_id?: unknown }
    }
    return {
      eventId: typeof p?.event_id === 'string' ? p.event_id : '',
      eventType: typeof p?.event_type === 'string' ? p.event_type : '',
      // 🔴 Uber manda el store_id en `meta.user_id`, no en `meta.store_id`. Rareza real de su API.
      storeId: typeof p?.meta?.user_id === 'string' ? p.meta.user_id : null,
      orderId: orderIdFromResourceHref(p?.resource_href),
      resourceRef: typeof p?.resource_href === 'string' ? p.resource_href : null,
    }
  },

  async fetchOrder(orderId: string): Promise<unknown> {
    const r = await fetchUberOrder(orderId)
    if (r.status >= 400) throw new Error(`Uber devolvió HTTP ${r.status} al traer el pedido ${orderId}`)
    return r.json
  },

  normalizeOrder(raw, _ctx): NormalizedDeliveryOrder {
    // El mapper real (formato crudo de Uber → contrato) es trabajo aparte: necesita
    // fixtures de un pedido real. Hasta entonces esto lanza en vez de inventar montos.
    throw new Error('El mapper de Uber aún no existe: falta capturar un pedido real (spec paso 5)')
  },

  async acceptOrder(orderId, ctx): Promise<ActionResult> {
    const r = await uberApi({
      method: 'POST',
      path: `/v1/eats/orders/${encodeURIComponent(orderId)}/accept_pos_order`,
      storeId: ctx.link.externalLocationId,
      body: { reason: 'accepted by POS' },
    })
    return { ok: r.status < 400 || r.status === 409, status: r.status, raw: r.text }
  },

  async denyOrder(orderId, reason, ctx): Promise<ActionResult> {
    const r = await uberApi({
      method: 'POST',
      path: `/v1/eats/orders/${encodeURIComponent(orderId)}/deny_pos_order`,
      storeId: ctx.link.externalLocationId,
      body: { reason: { explanation: reason } },
    })
    return { ok: r.status < 400, status: r.status, raw: r.text }
  },
}
```

**Nota sobre `acceptOrder`:** un `409` cuenta como éxito. Uber responde `409 resource_status_conflict` cuando el pedido ya estaba aceptado,
y el outbox es at-least-once: reintentar debe ser inofensivo.

- [ ] **Step 2: Migrar los tests de ingesta al núcleo**

En `tests/integration/delivery-channels/uberOrderIngestion.test.ts`: cambiar el import de `ingestUberOrder` por `ingestDeliveryOrder` y
ajustar la llamada (`(normalized, link)` en vez de `(normalized, ctx)`). **Los 7 casos no cambian** — son el contrato que debe seguir
cumpliéndose.

- [ ] **Step 3: Correr y verificar que pasan**

Run: `npx jest --selectProjects integration --testPathPattern "delivery-channels" --runInBand` Expected: PASS — los 7 casos de Uber ahora
corriendo contra el núcleo.

- [ ] **Step 4: Borrar los duplicados**

```bash
rm src/services/delivery-channels/providers/uber-eats/uber.orderIngestion.service.ts
rm src/services/delivery-channels/providers/uber-eats/uber.types.ts
grep -rn "uber.orderIngestion\|uber.types" src/ tests/ --include="*.ts"   # debe salir vacío
```

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc -p tsconfig.build.json --noEmit
npm run format && npm run lint:fix
git add -A src/services/delivery-channels tests/integration/delivery-channels
git commit -m "refactor(delivery): Uber usa el núcleo; se borra su ingesta duplicada"
```

---

## Task 5: El registro de adaptadores y el guardrail anti-`if`

**Files:**

- Create: `src/services/delivery-channels/core/adapterRegistry.ts`
- Modify: `src/services/delivery-channels/core/statusDispatcher.service.ts` (**absorber su registro**)
- Test: `tests/unit/services/delivery-channels/adapterRegistry.test.ts`

**Interfaces:**

- Consumes: `DeliveryProviderAdapter` (Tarea 2), `uberAdapter` (Tarea 4).
- Produces: `adapterFor(provider: DeliveryProvider): DeliveryProviderAdapter`, `hasAdapter(provider: DeliveryProvider): boolean`.

🔴 **Ya existe un registro `provider → adapter`** en `statusDispatcher.service.ts:19-21`, con Deliverect dentro. **NO lo absorbas** y **NO
toques `deliverect.adapter.ts`**: implementa el contrato VIEJO (`verifySignature`, `parseOrderWebhook`, `sendStatusUpdate`) y unificarlo
obligaría a migrar Deliverect, que es trabajo aparte (spec §8, paso 7).

Lo que sí haces: crear `adapterRegistry.ts` para el contrato NUEVO (hoy sólo Uber), y añadir en `statusDispatcher.service.ts:19` un
comentario que nombre la deuda:

```typescript
// ⚠️ DEUDA (plan 2026-08-20): este mapa y `core/adapterRegistry.ts` son DOS registros de
// lo mismo. Conviven porque `deliverectAdapter` implementa el contrato viejo. Se funden
// cuando Deliverect migre a `DeliveryProviderAdapter` (spec §8, paso 7).
```

Los tests existentes de `statusDispatcher` deben seguir en verde sin tocarlos.

- [ ] **Step 1: Escribir el test que falla**

```typescript
// tests/unit/services/delivery-channels/adapterRegistry.test.ts
import fs from 'fs'
import path from 'path'
import { DeliveryProvider } from '@prisma/client'
import { adapterFor, hasAdapter } from '@/services/delivery-channels/core/adapterRegistry'

describe('adapterRegistry', () => {
  it('devuelve el adaptador de Uber', () => {
    expect(adapterFor(DeliveryProvider.UBER_EATS).provider).toBe(DeliveryProvider.UBER_EATS)
  })

  it('un proveedor sin adaptador lanza con un mensaje que dice qué falta', () => {
    expect(() => adapterFor(DeliveryProvider.RAPPI)).toThrow(/RAPPI/)
    expect(hasAdapter(DeliveryProvider.RAPPI)).toBe(false)
  })

  it('🔴 GUARDRAIL: el core NO menciona proveedores por nombre — sólo el registro puede', () => {
    const coreDir = path.join(process.cwd(), 'src/services/delivery-channels/core')
    const ofensores: string[] = []

    // 🔴 Prohíbe DECISIONES por proveedor, no menciones. Un mapa de etiquetas legibles
    // (`{ [UBER_EATS]: 'Uber Eats' }` en deliveryTenderProvisioning) es presentación
    // legítima; lo que no puede existir es que el núcleo RAMIFIQUE según quién sea.
    const DECISION = /(provider\s*[=!]==|case\s+DeliveryProvider\.|if\s*\([^)]*(UBER_EATS|RAPPI|DIDI_FOOD|DELIVERECT))/

    for (const f of fs.readdirSync(coreDir).filter(f => f.endsWith('.ts') && f !== 'adapterRegistry.ts')) {
      const contenido = fs.readFileSync(path.join(coreDir, f), 'utf8')
      contenido.split('\n').forEach((linea, i) => {
        const sinComentario = linea.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')
        if (DECISION.test(sinComentario)) {
          ofensores.push(`${f}:${i + 1}: ${linea.trim()}`)
        }
      })
    }

    expect(ofensores).toEqual([])
  })
})
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx jest --selectProjects unit --testPathPattern "adapterRegistry" --runInBand` Expected: FAIL — el módulo no existe. **El guardrail
también puede fallar** listando menciones que quedaron en el core; si es así, esas menciones son trabajo de este mismo paso (mover la
decisión al registro).

- [ ] **Step 3: Implementar**

```typescript
// src/services/delivery-channels/core/adapterRegistry.ts
/**
 * El ÚNICO lugar del sistema donde un proveedor se menciona por nombre.
 *
 * 🔴 Si aparece un `if (provider === X)` o el nombre de un proveedor en cualquier otro
 * archivo de `core/`, es un bug de diseño: el núcleo debe trabajar contra el contrato.
 * Hay un test que recorre `core/` y falla si eso ocurre.
 *
 * Importación ESTÁTICA a propósito: cuatro adaptadores en el mismo repo no justifican
 * un cargador de plugins (spec §9, YAGNI).
 */
import { DeliveryProvider } from '@prisma/client'
import { uberAdapter } from '../providers/uber-eats/uber.adapter'
import type { DeliveryProviderAdapter } from './types'

const ADAPTERS: Partial<Record<DeliveryProvider, DeliveryProviderAdapter>> = {
  [DeliveryProvider.UBER_EATS]: uberAdapter,
  // RAPPI y DIDI_FOOD: cada uno con su plan. DELIVERECT migra en trabajo aparte.
}

export function hasAdapter(provider: DeliveryProvider): boolean {
  return ADAPTERS[provider] !== undefined
}

export function adapterFor(provider: DeliveryProvider): DeliveryProviderAdapter {
  const a = ADAPTERS[provider]
  if (!a) {
    throw new Error(
      `No hay adaptador para el proveedor "${provider}". Regístralo en core/adapterRegistry.ts ` +
        `implementando DeliveryProviderAdapter (core/types.ts).`,
    )
  }
  return a
}
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `npx jest --selectProjects unit --testPathPattern "adapterRegistry" --runInBand` Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
npm run format && npm run lint:fix
git add src/services/delivery-channels/core/adapterRegistry.ts tests/unit/services/delivery-channels/adapterRegistry.test.ts
git commit -m "feat(delivery): registro de adaptadores + guardrail que prohíbe nombrar proveedores en el núcleo"
```

---

## Task 6: Suite de contrato compartida

**Files:**

- Create: `tests/integration/delivery-channels/deliveryOrderIngestion.contract.test.ts`

**Interfaces:**

- Consumes: `ingestDeliveryOrder` (Tarea 3), `adapterFor` (Tarea 5).
- Produces: `runIngestionContract(nombre: string, hacerPedido: (o?: Partial<NormalizedDeliveryOrder>) => NormalizedDeliveryOrder)` — la
  función que cada proveedor nuevo invoca para demostrar que está bien integrado.

Es el entregable que hace que **agregar Rappi cueste una semana y no tres**: su adaptador se considera terminado cuando pasa esta suite.

- [ ] **Step 1: Escribir la suite reutilizable**

```typescript
// tests/integration/delivery-channels/deliveryOrderIngestion.contract.test.ts
/**
 * CONTRATO de ingesta: lo que TODO proveedor debe cumplir, sea quien sea.
 * Un adaptador nuevo (Rappi, DiDi) está terminado cuando pasa esta suite.
 */
import { ingestDeliveryOrder } from '@/services/delivery-channels/core/deliveryOrderIngestion.service'
import { DeliveryMoneyMismatchError } from '@/services/delivery-channels/core/money'
import type { NormalizedDeliveryOrder } from '@/services/delivery-channels/core/types'
import prisma from '@/utils/prismaClient'

export function runIngestionContract(
  nombre: string,
  hacerPedido: (o?: Partial<NormalizedDeliveryOrder>) => NormalizedDeliveryOrder,
  obtenerLink: () => { id: string; venueId: string; externalLocationId: string },
): void {
  describe(`contrato de ingesta — ${nombre}`, () => {
    it('crea la orden con el externalId namespaceado por proveedor', async () => {
      const p = hacerPedido()
      const { order } = await ingestDeliveryOrder(p, obtenerLink() as never)
      expect(order.externalId).toContain(p.externalId)
      expect(order.externalId).toMatch(/^[A-Z_]+:/)
    })

    it('no asigna mesero ni turno: nadie atendió esta venta en persona', async () => {
      const { order } = await ingestDeliveryOrder(hacerPedido(), obtenerLink() as never)
      expect(order.servedById).toBeNull()
      expect(order.shiftId).toBeNull()
    })

    it('la propina NO entra en Payment.amount', async () => {
      const p = hacerPedido({
        payment: {
          currency: 'MXN',
          saleAmount: '150.00',
          merchantFees: '0.00',
          tipAmount: '25.00',
          externallyPaidSale: '150.00',
          externallyPaidTip: '25.00',
          cashDueSale: '0.00',
          cashDueTip: '0.00',
        },
      })
      const { order } = await ingestDeliveryOrder(p, obtenerLink() as never)
      const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } })
      expect(pay.amount.toFixed(2)).toBe('150.00')
      expect(pay.tipAmount.toFixed(2)).toBe('25.00')
    })

    it('IDEMPOTENTE: el mismo pedido dos veces no duplica orden ni cobro', async () => {
      const p = hacerPedido()
      const a = await ingestDeliveryOrder(p, obtenerLink() as never)
      const b = await ingestDeliveryOrder(p, obtenerLink() as never)
      expect(b.order.id).toBe(a.order.id)
      expect(await prisma.payment.count({ where: { orderId: a.order.id } })).toBe(1)
    })

    it('🔴 rechaza el dinero que no cuadra, sin escribir nada', async () => {
      const link = obtenerLink()
      const antes = await prisma.order.count({ where: { venueId: link.venueId } })
      const malo = hacerPedido({
        payment: {
          currency: 'MXN',
          saleAmount: '100.00',
          merchantFees: '0.00',
          tipAmount: '0.00',
          externallyPaidSale: '90.00',
          externallyPaidTip: '0.00',
          cashDueSale: '0.00',
          cashDueTip: '0.00',
        },
      })
      await expect(ingestDeliveryOrder(malo, link as never)).rejects.toThrow(DeliveryMoneyMismatchError)
      expect(await prisma.order.count({ where: { venueId: link.venueId } })).toBe(antes)
    })

    it('un producto que no resuelve entra marcado, sin productId, y no se pierde', async () => {
      const p = hacerPedido({ items: [{ externalId: 'no-existe-999', name: 'Fantasma', quantity: 1, unitPrice: '50.00', total: '50.00' }] })
      const { order } = await ingestDeliveryOrder(p, obtenerLink() as never)
      const items = await prisma.orderItem.findMany({ where: { orderId: order.id } })
      expect(items).toHaveLength(1)
      expect(items[0].productId).toBeNull()
      expect(items[0].name).toBe('Fantasma')
    })
  })
}
```

- [ ] **Step 2: Conectar Uber a la suite**

En `tests/integration/delivery-channels/uberOrderIngestion.test.ts`, al final:
`runIngestionContract('Uber Eats', makeNormalizedOrder, () => link)`.

- [ ] **Step 3: Correr y verificar que pasa**

Run: `npx jest --selectProjects integration --testPathPattern "delivery-channels" --runInBand` Expected: PASS — los 6 casos del contrato
corriendo contra Uber, más los suyos propios.

- [ ] **Step 4: Commit**

```bash
npm run format && npm run lint:fix
git add tests/integration/delivery-channels/
git commit -m "test(delivery): suite de contrato que todo proveedor debe pasar"
```

---

## Task 7: Gating PREMIUM

**Files:**

- Modify: `src/routes/delivery-channels.routes.ts`
- Test: `tests/unit/services/delivery-channels/deliveryGating.test.ts` (crear)

**Interfaces:**

- Consumes: `venueHasFeatureAccess` de `@/services/access/`.
- Produces: nada nuevo; endurece rutas existentes.

Delivery directo es **PREMIUM** (decisión del founder, 2026-08-20).

- [ ] **Step 1: Verificar cómo se llama el Feature**

Run: `grep -rn "INVENTORY_TRACKING\|'CFDI'" src/services/access/ | head -5` Usa el MISMO patrón. Si no existe un código de delivery, créalo
siguiendo `.claude/rules/feature-gating.md`.

- [ ] **Step 2: Escribir el test que falla**

```typescript
it('un venue sin PREMIUM recibe 403 que dice QUÉ falta y CÓMO activarlo', async () => {
  jest.mocked(venueHasFeatureAccess).mockResolvedValue(false)
  const res = await request(app).post(`/api/v1/venues/${venueId}/delivery-channels`).send({ provider: 'UBER_EATS' })
  expect(res.status).toBe(403)
  expect(res.body.message).toMatch(/PREMIUM/i) // dice qué plan hace falta
  expect(res.body.code).toBeDefined() // el cliente puede pintar el upsell sin adivinar
})
```

- [ ] **Step 3: Correr, implementar el gate, correr**

Usa `venueHasFeatureAccess` (el resolver de **Feature**, NO el de módulos — cruzarlos falla en silencio porque casi todo prod está
grandfathered).

- [ ] **Step 4: Commit**

```bash
npm run format && npm run lint:fix
git add src/routes/delivery-channels.routes.ts tests/unit/services/delivery-channels/deliveryGating.test.ts
git commit -m "feat(delivery): delivery directo es PREMIUM, con 403 que explica cómo activarlo"
```

---

## Task 8: MCP al día

**Files:**

- Modify: `src/mcp/tools/` — la tool `delivery_channels`

**Interfaces:**

- Consumes: `hasAdapter` (Tarea 5).
- Produces: la tool refleja proveedor, estado de conexión y si hay adaptador.

Regla dura del repo: una capacidad no alcanzable por el customer MCP está incompleta.

- [ ] **Step 1: Ver qué expone hoy**

Run: `grep -rn "delivery_channels" src/mcp/tools/ | head -5`

- [ ] **Step 2: Añadir a la salida, por cada vínculo**

`provider`, `status`, `orderAcceptanceMode`, `integrationReady: hasAdapter(provider)`. Sin montos, así que no aplica la reconciliación de
dinero; sí aplican `guard.venueFilter()` y fechas venue-local.

- [ ] **Step 3: Correr los tests del MCP y commitear**

```bash
npx jest --selectProjects unit --testPathPattern "mcp" --runInBand
npm run format && npm run lint:fix
git add src/mcp/
git commit -m "feat(mcp): delivery_channels reporta proveedor y si su integración está lista"
```

---

## Cierre

- [ ] Typecheck limpio: `npx tsc -p tsconfig.build.json --noEmit`
- [ ] Suite completa de delivery en verde (unit + integration)
- [ ] `grep -rn "uber.orderIngestion" src/ tests/` → vacío
- [ ] El guardrail anti-`if` pasa
- [ ] Actualizar el spec: marcar §8 pasos 1-6 como hechos

**Lo que NO cierra este plan** (trabajos aparte, cada uno con su propio plan): el mapper de Uber (necesita un pedido real), el outbox de
aceptar/rechazar, la impresión de comandas, la migración de Deliverect, y los adaptadores de Rappi y DiDi.
