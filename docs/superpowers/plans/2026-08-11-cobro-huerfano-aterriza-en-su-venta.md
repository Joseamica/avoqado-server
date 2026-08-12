# El cobro huérfano aterriza en SU venta — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que un cobro con tarjeta que sobrevive a una cancelación se registre en la venta que lo originó —con sus productos— en vez de en
una venta sintética `FAST-…` vacía.

**Architecture:** El server ya recibe el `terminalPaymentRequestId` en la ruta de cobro rápido, y esa fila ya guarda el `orderId` de la
venta real. El arreglo es una **decisión pura** ("¿a qué orden pertenece este dinero?") más un desvío: si hay orden, `recordFastPayment`
delega en `recordOrderPayment`, que ya sabe descontar inventario, cerrar la orden y actualizar el turno. No se reimplementa nada de eso.

**Tech Stack:** TypeScript · Express · Prisma/PostgreSQL · Jest (unit, con `prisma as any` como mock)

## Global Constraints

- **Alcance de este plan: SOLO avoqado-server.** La parte de POS (que el cajero decida entregar o devolver) va en un plan aparte: depende de
  que esto exista primero y no es necesaria para que este cambio aporte valor.
- **avoqado-tpv NO se toca.** Manda `terminalPaymentRequestId` desde **v26 (2026-07-14)**. Verificado en `PendingPaymentEntity.kt:107`.
- **El reembolso por TPV está fuera de alcance.** Parkeado en el spec.
- **Rama: `develop`.** El merge a `main` lo hace el founder.
- **La ruta del dinero exige test primero.** No negociable.
- **Aditivo:** ninguna respuesta de API cambia de forma; ningún campo se renombra ni se quita.
- Spec de referencia: `docs/superpowers/specs/2026-08-11-cobro-huerfano-aterriza-en-su-venta-design.md`

---

## File Structure

| Archivo                                                           | Responsabilidad                                                                                                                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/services/tpv/fastPaymentTarget.ts` _(nuevo)_                 | **Decisión pura**: dada la fila de arbitraje, ¿a qué orden pertenece el dinero? Sin Prisma, sin red. Espeja el patrón de `CardChargeDecision` del cliente: la corrección vive en una función testeable sola. |
| `tests/unit/services/tpv/fastPaymentTarget.test.ts` _(nuevo)_     | Tests de esa decisión.                                                                                                                                                                                       |
| `src/services/tpv/payment.tpv.service.ts:2608` _(modificar)_      | `recordFastPayment` consulta la fila y, si la decisión dice que hay orden, delega en `recordOrderPayment`.                                                                                                   |
| `tests/unit/services/tpv/fastPaymentDelegation.test.ts` _(nuevo)_ | Test del desvío: con orden delega, sin orden sigue por FAST.                                                                                                                                                 |

---

## Task 1: La decisión pura — ¿a qué orden pertenece este dinero?

**Files:**

- Create: `src/services/tpv/fastPaymentTarget.ts`
- Test: `tests/unit/services/tpv/fastPaymentTarget.test.ts`

**Interfaces:**

- Consumes: nada (función pura, primer eslabón)
- Produces: `resolveFastPaymentTarget(row: ArbitrationRowSnapshot | null): FastPaymentTarget` — usada por Task 2. Tipos exactos abajo.

- [ ] **Step 1: Escribir el test que falla**

```typescript
// tests/unit/services/tpv/fastPaymentTarget.test.ts
import { resolveFastPaymentTarget } from '@/services/tpv/fastPaymentTarget'

describe('resolveFastPaymentTarget — a qué venta pertenece un cobro de terminal', () => {
  it('con una solicitud que traía orden, el dinero es de ESA orden', () => {
    const target = resolveFastPaymentTarget({ orderId: 'order-1', venueId: 'venue-1', status: 'CANCEL_REQUESTED' })
    expect(target).toEqual({ kind: 'existingOrder', orderId: 'order-1' })
  })

  it('sin solicitud (cobro nacido EN la terminal) es venta rápida', () => {
    // Una TPV < v26, o alguien cobrando directo en el aparato: no hay orden que asociar.
    expect(resolveFastPaymentTarget(null)).toEqual({ kind: 'fastOrder' })
  })

  it('una solicitud SIN orden también es venta rápida', () => {
    // El POS cobró sin mesa: la solicitud existe pero nunca tuvo orden.
    expect(resolveFastPaymentTarget({ orderId: null, venueId: 'venue-1', status: 'SENT' })).toEqual({ kind: 'fastOrder' })
  })

  it('un orderId en blanco NO es una orden — nunca se paga "la cadena vacía"', () => {
    expect(resolveFastPaymentTarget({ orderId: '   ', venueId: 'venue-1', status: 'SENT' })).toEqual({ kind: 'fastOrder' })
  })

  it('la orden manda aunque la solicitud ya esté cancelada: el dinero SÍ se movió', () => {
    // 🔴 Cancelar es una PETICIÓN. Si la terminal cobró igual, la venta es real y sus
    // productos salieron del inventario. Mandarla a FAST perdería esa información.
    const target = resolveFastPaymentTarget({ orderId: 'order-9', venueId: 'venue-1', status: 'CANCELLED' })
    expect(target).toEqual({ kind: 'existingOrder', orderId: 'order-9' })
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx jest tests/unit/services/tpv/fastPaymentTarget.test.ts` Expected: FAIL — `Cannot find module '@/services/tpv/fastPaymentTarget'`

- [ ] **Step 3: Escribir la implementación mínima**

```typescript
// src/services/tpv/fastPaymentTarget.ts

/** Lo único que la decisión necesita saber de la fila de arbitraje. */
export interface ArbitrationRowSnapshot {
  orderId: string | null
  venueId: string
  status: string
}

/** A qué venta pertenece el dinero que acaba de cobrar la terminal. */
export type FastPaymentTarget = { kind: 'existingOrder'; orderId: string } | { kind: 'fastOrder' }

/**
 * ¿A qué venta pertenece este cobro?
 *
 * 🔴 El caso que arregla: el cajero manda un cobro desde el POS, cancela, y la terminal
 * cobra igual. Hoy ese dinero cae en una venta sintética `FAST-…` con CERO líneas de
 * producto — así que no se descuenta inventario, los reportes por producto no la ven, y
 * el carrito del cajero sigue mostrando sin pagar algo que el cliente ya pagó. El dinero
 * cuadra y la venta no: el descuadre que nadie reclama porque el total del día sí suma.
 *
 * La información SIEMPRE estuvo ahí: la solicitud de arbitraje guarda el `orderId`.
 *
 * Que la solicitud esté `CANCELLED` no cambia nada: cancelar es una PETICIÓN, y si la
 * terminal cobró igual, la venta ocurrió de verdad.
 */
export function resolveFastPaymentTarget(row: ArbitrationRowSnapshot | null): FastPaymentTarget {
  const orderId = row?.orderId?.trim()
  // Una cadena vacía no es una orden: pagar "" reventaría o, peor, pagaría cualquier cosa.
  if (!orderId) return { kind: 'fastOrder' }
  return { kind: 'existingOrder', orderId }
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx jest tests/unit/services/tpv/fastPaymentTarget.test.ts` Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/services/tpv/fastPaymentTarget.ts tests/unit/services/tpv/fastPaymentTarget.test.ts
git commit -m "feat(tpv): decision pura de a que venta pertenece un cobro de terminal"
```

---

## Task 2: El desvío — si hay orden, se paga ESA orden

**Files:**

- Modify: `src/services/tpv/payment.tpv.service.ts:2608` (inicio de `recordFastPayment`)
- Test: `tests/unit/services/tpv/fastPaymentDelegation.test.ts`

**Interfaces:**

- Consumes: `resolveFastPaymentTarget(row)` de Task 1
- Produces: nada nuevo hacia afuera — `recordFastPayment` conserva su firma
  `recordFastPayment(venueId: string, paymentData: PaymentCreationData, userId?: string, _orgId?: string)`

- [ ] **Step 1: Escribir el test que falla**

```typescript
// tests/unit/services/tpv/fastPaymentDelegation.test.ts
import prisma from '@/utils/prismaClient'

const prismaMock = prisma as any
const mockRecordOrderPayment = jest.fn()

jest.mock('@/services/tpv/payment.tpv.service', () => {
  const actual = jest.requireActual('@/services/tpv/payment.tpv.service')
  return { ...actual, recordOrderPayment: (...args: unknown[]) => mockRecordOrderPayment(...args) }
})

describe('recordFastPayment — un cobro con orden NO crea venta sintetica', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.terminalPaymentRequest.findUnique.mockResolvedValue(null)
  })

  it('con solicitud que traia orden, delega en recordOrderPayment y NO crea orden FAST', async () => {
    prismaMock.terminalPaymentRequest.findUnique.mockResolvedValueOnce({
      orderId: 'order-real',
      venueId: 'venue-1',
      status: 'CANCELLED',
    })
    mockRecordOrderPayment.mockResolvedValue({ id: 'pay-1' })

    const { recordFastPayment } = require('@/services/tpv/payment.tpv.service')
    await recordFastPayment('venue-1', { amount: 30, terminalPaymentRequestId: 'req-1' } as any, 'user-1')

    expect(mockRecordOrderPayment).toHaveBeenCalledWith(
      'venue-1',
      'order-real',
      expect.objectContaining({ terminalPaymentRequestId: 'req-1' }),
      'user-1',
    )
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('sin terminalPaymentRequestId sigue por la ruta FAST — ni siquiera consulta la fila', async () => {
    const { recordFastPayment } = require('@/services/tpv/payment.tpv.service')
    await recordFastPayment('venue-1', { amount: 30 } as any, 'user-1').catch(() => {})

    expect(prismaMock.terminalPaymentRequest.findUnique).not.toHaveBeenCalled()
    expect(mockRecordOrderPayment).not.toHaveBeenCalled()
  })

  it('si la consulta de la fila truena, NO bloquea el cobro — cae a FAST', async () => {
    // 🔴 Fail-open: un fallo de infra jamás puede impedir registrar dinero que YA se cobró.
    prismaMock.terminalPaymentRequest.findUnique.mockRejectedValueOnce(new Error('connection refused'))

    const { recordFastPayment } = require('@/services/tpv/payment.tpv.service')
    await recordFastPayment('venue-1', { amount: 30, terminalPaymentRequestId: 'req-1' } as any, 'user-1').catch(() => {})

    expect(mockRecordOrderPayment).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx jest tests/unit/services/tpv/fastPaymentDelegation.test.ts` Expected: FAIL — `recordOrderPayment` no fue llamado (hoy siempre crea
la orden FAST)

- [ ] **Step 3: Escribir la implementación mínima**

En `src/services/tpv/payment.tpv.service.ts`, justo después del `logger.info('Recording fast payment', …)` de la línea 2609:

```typescript
// 🔴 ¿Este dinero pertenece a una venta que YA existe? El cajero pudo mandar el cobro
// desde el POS, cancelar, y la terminal cobrar igual. Ese cobro es de la venta que lo
// originó —con sus productos—, no de una venta sintética vacía. La solicitud de
// arbitraje guarda el `orderId`; hasta hoy sólo se usaba para cerrar la fila.
//
// Fail-open a propósito: si la consulta truena, se sigue por FAST. Un fallo de infra
// jamás puede impedir registrar dinero que YA se cobró.
if (paymentData.terminalPaymentRequestId) {
  let arbitrationRow: { orderId: string | null; venueId: string; status: string } | null = null
  try {
    arbitrationRow = await prisma.terminalPaymentRequest.findUnique({
      where: { requestId: paymentData.terminalPaymentRequestId },
      select: { orderId: true, venueId: true, status: true },
    })
  } catch (err) {
    logger.error('⚠️ [FastPayment] No se pudo leer la solicitud de arbitraje — se sigue como venta rápida', {
      requestId: paymentData.terminalPaymentRequestId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  const target = resolveFastPaymentTarget(arbitrationRow)
  if (target.kind === 'existingOrder') {
    logger.info('🎯 [FastPayment] El cobro pertenece a una venta existente — no se crea venta rápida', {
      requestId: paymentData.terminalPaymentRequestId,
      orderId: target.orderId,
      priorStatus: arbitrationRow?.status,
    })
    // recordOrderPayment ya sabe descontar inventario, cerrar la orden, actualizar el
    // turno y cerrar la fila de arbitraje. No se reimplementa nada de eso aquí.
    return recordOrderPayment(venueId, target.orderId, paymentData, userId, _orgId)
  }
}
```

Y el import arriba del archivo:

```typescript
import { resolveFastPaymentTarget } from './fastPaymentTarget'
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx jest tests/unit/services/tpv/` Expected: PASS — 8 tests (5 de Task 1 + 3 de éste)

- [ ] **Step 5: Correr la suite alrededor para no romper nada**

Run: `npx jest tests/unit/services/terminal-payment tests/unit/services/tpv tests/unit/jobs` Expected: PASS — sin regresiones

- [ ] **Step 6: Verificar que compila**

Run: `npm run build` Expected: sin errores. ⚠️ **No usar `npx tsc --noEmit`**: revienta por memoria en este repo. Es un caso conocido.

- [ ] **Step 7: Commit**

```bash
git add src/services/tpv/payment.tpv.service.ts tests/unit/services/tpv/fastPaymentDelegation.test.ts
git commit -m "fix(tpv): el cobro que sobrevive a un cancel aterriza en SU venta, no en una FAST vacia"
```

---

## Task 3: Verificación contra Postgres real

Los tests con mocks prueban la decisión y el desvío. **No prueban que la venta quede bien de verdad.** Hoy el bug se descubrió justamente
porque una premisa equivocada estaba también en los tests — así que esta tarea es obligatoria.

**Files:**

- Create (temporal, se borra al final): `scripts/tmp-verificar-cobro-huerfano.ts`

**Interfaces:**

- Consumes: `recordFastPayment` ya modificada por Task 2
- Produces: evidencia, no código

- [ ] **Step 1: Escribir el script de verificación**

```typescript
// scripts/tmp-verificar-cobro-huerfano.ts
// Verifica contra Postgres REAL que un cobro con solicitud que traía orden aterriza en
// ESA orden, con sus líneas, y NO crea una venta FAST vacía. Borra lo que crea.
import prisma from '@/utils/prismaClient'
import { recordFastPayment } from '@/services/tpv/payment.tpv.service'

const MARCA = 'VERIF-HUERFANO-'

async function main() {
  const venueId = process.env.VENUE_ID!
  // 1. Una orden real con al menos una línea (usar una PENDING existente del venue).
  const orden = await prisma.order.findFirst({
    where: { venueId, status: 'PENDING', items: { some: {} } },
    select: { id: true, total: true, _count: { select: { items: true } } },
  })
  if (!orden) throw new Error('no hay orden PENDING con líneas para la prueba')

  // 2. Una solicitud de arbitraje que apunte a ella.
  await prisma.terminalPaymentRequest.create({
    data: {
      requestId: `${MARCA}1`,
      venueId,
      terminalId: 'verif-huerfano',
      status: 'CANCELLED',
      amountCents: Math.round(Number(orden.total) * 100),
      tipCents: 0,
      orderId: orden.id,
      expiresAt: new Date(Date.now() - 3600_000),
    },
  })

  const ordenesFastAntes = await prisma.order.count({ where: { venueId, orderNumber: { startsWith: 'FAST-' } } })

  // 3. La terminal registra el cobro, como haría de verdad.
  await recordFastPayment(venueId, {
    amount: Number(orden.total),
    method: 'CREDIT_CARD',
    status: 'COMPLETED',
    terminalPaymentRequestId: `${MARCA}1`,
    idempotencyKey: `${MARCA}idem-1`,
  } as any)

  // 4. Comprobar.
  const ordenDespues = await prisma.order.findUnique({
    where: { id: orden.id },
    select: { status: true, paymentStatus: true, payments: { select: { id: true, amount: true } } },
  })
  const ordenesFastDespues = await prisma.order.count({ where: { venueId, orderNumber: { startsWith: 'FAST-' } } })

  const pagoEnLaOrdenReal = (ordenDespues?.payments.length ?? 0) > 0
  const noCreoFast = ordenesFastDespues === ordenesFastAntes
  console.log(
    `${pagoEnLaOrdenReal ? '✅' : '❌'} el pago quedó en la orden REAL (${ordenDespues?.payments.length} pagos, status ${ordenDespues?.status})`,
  )
  console.log(`${noCreoFast ? '✅' : '❌'} NO se creó venta FAST (antes ${ordenesFastAntes}, después ${ordenesFastDespues})`)
  console.log(`   la orden tenía ${orden._count.items} líneas de producto — eso es lo que antes se perdía`)

  await prisma.terminalPaymentRequest.deleteMany({ where: { requestId: { startsWith: MARCA } } })
  process.exit(pagoEnLaOrdenReal && noCreoFast ? 0 : 1)
}

main().catch(async e => {
  console.error(e.message)
  await prisma.terminalPaymentRequest.deleteMany({ where: { requestId: { startsWith: MARCA } } })
  process.exit(1)
})
```

- [ ] **Step 2: Correrlo**

Run: `VENUE_ID=<id de un venue de pruebas> NODE_ENV=development npx tsx scripts/tmp-verificar-cobro-huerfano.ts` Expected: las dos líneas en
✅.

⚠️ Si alguna sale ❌, **antes de tocar el código verifica que el escenario sea válido**: hoy un caso falló porque el pago elegido ya estaba
reclamado por otra solicitud, no porque el arreglo estuviera mal.

- [ ] **Step 3: Borrar el script y comprobar que no quedó basura**

```bash
rm scripts/tmp-verificar-cobro-huerfano.ts
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM \"TerminalPaymentRequest\" WHERE \"requestId\" LIKE 'VERIF-%';"
```

Expected: `0`, y `git status` sin el script.

- [ ] **Step 4: Commit del reporte**

Escribir `docs/superpowers/reports/2026-08-11-cobro-huerfano-aterriza-en-su-venta.md` con: la salida del script, cuántas líneas tenía la
orden, y el conteo de FAST antes/después.

```bash
git add docs/superpowers/reports/2026-08-11-cobro-huerfano-aterriza-en-su-venta.md
git commit -m "docs(report): verificacion contra Postgres del cobro huerfano"
```

---

## Fuera de alcance (planes aparte)

1. **POS: que el cajero decida entregar o devolver.** Con el server arreglado, la pantalla de "Cobro anterior sin confirmar" puede ofrecer
   **Entregar** / **Devolver**. Depende de esto y no hace falta para que este cambio aporte valor. Android **e** iOS en el mismo trabajo.
2. **Reembolso por TPV.** Parkeado. Antes hay que averiguar si el SDK de Nexgo/AngelPay expone una devolución disparable en remoto.
3. **Datos históricos.** Las ventas `FAST` vacías que ya existen no se migran: este plan corrige de aquí en adelante.

---

## Self-review

**Cobertura del spec:** la raíz (server delega a la orden real) → Tasks 1-2. Las trampas del spec: idempotencia → se hereda de
`recordOrderPayment`, que ya la tiene, en vez de duplicarla; orden `CANCELLED` → decidido explícitamente y con test (la orden manda: el
dinero se movió); sólo la orden de ESA solicitud → la decisión sólo lee `row.orderId`; ventas rápidas legítimas → intactas, con test. La
verificación contra Postgres → Task 3. El POS y el reembolso quedan declarados fuera, no olvidados.

**Placeholders:** ninguno — todos los pasos llevan código o comando ejecutable.

**Consistencia de tipos:** `resolveFastPaymentTarget(row: ArbitrationRowSnapshot | null): FastPaymentTarget` se define en Task 1 y se usa
con esa firma exacta en Task 2. `recordOrderPayment(venueId, orderId, paymentData, userId, _orgId)` coincide con la firma real de
`payment.tpv.service.ts:1717`.
