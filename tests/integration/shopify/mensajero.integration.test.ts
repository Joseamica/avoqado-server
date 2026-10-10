// tests/integration/shopify/mensajero.integration.test.ts
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import {
  applyShopifyLevel,
  CercoShopify,
  initializePair,
  marcarFaltaPermiso,
  NivelLeido,
  suspendPair,
} from '@/services/commerce-channels/shopify/shopify.mirror.service'
import { shopifyGraphql, ShopifyFailureCode, ShopifyResult } from '@/services/commerce-channels/shopify/shopify.graphql'
import {
  claimShopifyOutbox,
  runShopifyOutboxRow,
  SHOPIFY_OUTBOX_MAX_ATTEMPTS,
} from '@/services/commerce-channels/shopify/shopify.outbox.service'
import {
  agregarProductoShopify,
  assertTestDatabase,
  crearEscenarioShopify,
  EscenarioShopify,
  graphqlFalso,
  huecoDelInvariante,
  limpiarEscenarioShopify,
  TOKEN_DE_PRUEBA,
  UBICACION_PRUEBA,
} from './fixtures'

const siAcceso = async () => true
const exito = () => ({
  ok: true as const,
  data: { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id: 'gid://shopify/InventoryAdjustmentGroup/1' }, userErrors: [] } },
})
const conError = (code: string) => () => ({
  ok: true as const,
  data: { inventoryAdjustQuantities: { inventoryAdjustmentGroup: null, userErrors: [{ field: ['input'], message: 'prueba', code }] } },
})
const falla = (code: ShopifyFailureCode, retryable: boolean, ambiguous: boolean) => () => ({
  ok: false as const,
  code,
  retryable,
  ambiguous,
  message: 'prueba',
})
const ok = (available: number): NivelLeido => ({ kind: 'OK', available, committed: 0 })
const venta = (inventoryId: string) =>
  prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE id = ${inventoryId}`
const fila = (id: string) => prisma.shopifyStockOutbox.findUniqueOrThrow({ where: { id } })
const filaDe = (productId: string) => prisma.shopifyStockOutbox.findFirstOrThrow({ where: { productId } })
const espejo = async (e: EscenarioShopify) =>
  (await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })).mirrorAvailable
const stock = async (e: EscenarioShopify) =>
  (await prisma.inventory.findUniqueOrThrow({ where: { id: e.inventoryId } })).currentStock.toString()
const hueco = (e: EscenarioShopify) => huecoDelInvariante(e.productId)
const avisos = (e: EscenarioShopify, aviso: string) =>
  prisma.notification.count({ where: { venueId: e.venueId, entityType: 'ShopifyAviso', entityId: { startsWith: `${aviso}:` } } })
const aplicar = (e: EscenarioShopify, nivel: NivelLeido) =>
  applyShopifyLevel({ variantLinkId: e.variantLinkId, nivel, fetchedAt: new Date(), cause: 'aviso' }, { hasAccess: siAcceso })
const comparar = (e: EscenarioShopify, nivel: NivelLeido) =>
  initializePair({ variantLinkId: e.variantLinkId, nivel, fetchedAt: new Date(), mode: 'COMPARAR' }, { hasAccess: siAcceso })
async function reclamar(now = new Date()): Promise<{ id: string; claimToken: string }> {
  const c = await claimShopifyOutbox(now)
  if (c.kind !== 'FILA') throw new Error(`se esperaba FILA y llegó ${c.kind}`)
  return c
}
/** Lo que Shopify contesta (HTTP 200) cuando a la app le falta un scope. */
const CUERPO_ACCESS_DENIED = {
  errors: [
    {
      message: 'Access denied for inventoryAdjustQuantities field. Required access: `write_inventory` access scope.',
      locations: [{ line: 2, column: 3 }],
      path: ['inventoryAdjustQuantities'],
      extensions: {
        code: 'ACCESS_DENIED',
        documentation: 'https://shopify.dev/api/usage/access-scopes',
        requiredAccess: '`write_inventory` access scope.',
      },
    },
  ],
  data: { inventoryAdjustQuantities: null },
}
const sucursal = (e: EscenarioShopify) => prisma.shopifyLocationLink.findUniqueOrThrow({ where: { id: e.locationLinkId } })
const dormir = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
/** Barrera: espera a que alguna sesión de esta base quede esperando un candado sobre `tabla`. */
async function esperarCandado(tabla: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const [r] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${`%${tabla}%`}`
    if (r.n > 0) return
    await dormir(25)
  }
  throw new Error(`nadie se quedó esperando un candado de ${tabla}`)
}
const cercoDe = (e: EscenarioShopify, o: Partial<CercoShopify> = {}): CercoShopify => ({
  generation: 1,
  storeId: e.storeId,
  shopifyLocationId: UBICACION_PRUEBA,
  tokenVersion: 1,
  ...o,
})
/** §11.2: cada caso cambia el contexto después del reclamo y devuelve el cerco viejo con el que el worker iba a enviar. */
const CONTEXTOS_VIEJOS: Array<[string, (e: EscenarioShopify) => Promise<CercoShopify>]> = [
  [
    'la sucursal cambió de generación',
    async e => {
      await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { generation: 2 } })
      return cercoDe(e)
    },
  ],
  [
    'la credencial cambió',
    async e => {
      await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { tokenVersion: 2 } })
      return cercoDe(e)
    },
  ],
  [
    'otro worker se quedó con la sucursal',
    async e => {
      await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { workToken: 'de-otro' } })
      return cercoDe(e, { workToken: 'mio' })
    },
  ],
  [
    'otro procesador reclamó el evento',
    async e => {
      const ev = await prisma.shopifyInboundEvent.create({
        data: {
          dedupKey: `ev-${randomUUID()}`,
          appKey: 'PILOTO',
          topic: 'inventory_levels/update',
          shopDomain: e.shopDomain,
          payload: {},
          status: 'PROCESSING',
          claimToken: 'de-otro',
        },
      })
      return cercoDe(e, { evento: { id: ev.id, claimToken: 'mio' } })
    },
  ],
]

let escenarios: EscenarioShopify[] = []
async function escenario(o?: Parameters<typeof crearEscenarioShopify>[0]): Promise<EscenarioShopify> {
  const e = await crearEscenarioShopify(o)
  escenarios.push(e)
  return e
}
beforeAll(() => assertTestDatabase())
afterEach(async () => {
  for (const e of escenarios) await limpiarEscenarioShopify(e)
  escenarios = []
})

it('envía el delta con @idempotent y llave = id de la fila; SENT, ambiguous false, parámetros congelados y espejo += delta', async () => {
  const e = await escenario()
  await venta(e.inventoryId)
  const graphql = graphqlFalso(exito)
  const c = await reclamar()
  // Una IN_PROGRESS con el lease vivo no se vuelve a reclamar.
  expect(await claimShopifyOutbox(new Date())).toEqual({ kind: 'VACIO' })
  expect(await runShopifyOutboxRow(c.id, c.claimToken, new Date(), { graphql, hasAccess: siAcceso })).toBe('SENT')
  const [shop, token, query, vars, opts] = graphql.mock.calls[0]
  expect([shop, token]).toEqual([e.shopDomain, TOKEN_DE_PRUEBA])
  expect(opts.timeoutMs).toBeUndefined() // sin plazo del llamador, el del cliente (SHOPIFY_TIMEOUT_MS)
  expect(query).toContain('@idempotent(key: $key)')
  expect(vars.key).toBe(c.id)
  expect(vars.input).toMatchObject({ name: 'available', reason: 'correction', referenceDocumentUri: `gid://avoqado/StockChange/${c.id}` })
  expect(vars.input.changes).toEqual([
    { delta: -1, inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: UBICACION_PRUEBA, changeFromQuantity: null },
  ])
  expect(await fila(c.id)).toMatchObject({
    status: 'SENT',
    ambiguous: false,
    attempts: 1,
    claimToken: null,
    sentInventoryItemId: 'gid://shopify/InventoryItem/1',
    sentLocationId: UBICACION_PRUEBA,
  })
  expect(await espejo(e)).toBe(9)
  expect(await hueco(e)).toBe('0')
})

it('🔴 P1-2: una fila de un producto que ya no se sincroniza (pasó a kilo sin suspender la pareja) NO sale: se suspende y se descarta', async () => {
  const e = await escenario()
  await venta(e.inventoryId) // el −1 de una pesada de 1.000 kg con la pareja todavía viva
  await prisma.product.update({ where: { id: e.productId }, data: { soldByWeight: true, unit: 'KILOGRAM' } }) // sin ayudantes
  const graphql = graphqlFalso(exito)
  const c = await reclamar()
  expect(await runShopifyOutboxRow(c.id, c.claimToken, new Date(), { graphql, hasAccess: siAcceso })).toBe('DISCARDED')
  expect(graphql).not.toHaveBeenCalled() // Shopify no pierde la pieza
  expect(await fila(c.id)).toMatchObject({ status: 'DISCARDED', lastError: 'PAREJA_SUSPENDIDA', claimToken: null })
  expect((await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })).suspendedReason).toBe('SIN_INVENTARIO')
  expect(await prisma.shopifyImportIssue.findFirst({ where: { venueId: e.venueId, productId: e.productId } })).toMatchObject({
    reason: 'UNIDAD_NO_PIEZA',
  })
  expect(await espejo(e)).toBe(10)
})

it('ronda 2 (P1-1): la venta RETENIDA de una pareja creada por el conector se descarta si TOMAR la suspende al iniciar', async () => {
  const e = await escenario()
  const sinNivel = await agregarProductoShopify(e, { stock: 0, initialized: false, createdProduct: true })
  const aKilos = await agregarProductoShopify(e, { stock: 0, initialized: false, createdProduct: true })
  for (const p of [sinNivel, aKilos]) await venta(p.inventoryId) // −1 retenido de cada una
  expect(
    await prisma.shopifyStockOutbox.count({ where: { productId: { in: [sinNivel.productId, aKilos.productId] }, status: 'PENDING' } }),
  ).toBe(2)
  await prisma.product.update({ where: { id: aKilos.productId }, data: { unit: 'KILOGRAM' } })
  const tomar = (variantLinkId: string, nivel: NivelLeido) =>
    initializePair({ variantLinkId, nivel, fetchedAt: new Date(), mode: 'TOMAR_SHOPIFY' }, { hasAccess: siAcceso })
  expect(await tomar(sinNivel.variantLinkId!, { kind: 'SIN_NIVEL' })).toBe('SUSPENDIDA') // nunca cero por ausencia
  expect(await tomar(aKilos.variantLinkId!, ok(10))).toBe('SUSPENDIDA') // FF-I1: ya no se sincroniza
  for (const p of [sinNivel, aKilos]) {
    expect(
      await prisma.shopifyStockOutbox.findMany({ where: { productId: p.productId }, select: { status: true, lastError: true } }),
    ).toEqual([{ status: 'DISCARDED', lastError: 'PAREJA_SUSPENDIDA' }])
    expect((await prisma.inventory.findUniqueOrThrow({ where: { id: p.inventoryId } })).currentStock.toString()).toBe('-1')
  }
  expect(await claimShopifyOutbox(new Date())).toEqual({ kind: 'VACIO' }) // nada viaja a Shopify
})

it('ronda 2 (W5): la pareja que CREÓ el conector, suspendida en su primer inicio y reactivada después, no es «ya existía en Avoqado»', async () => {
  const e = await escenario()
  const creada = await agregarProductoShopify(e, { stock: 4, initialized: false, createdProduct: true })
  await prisma.shopifyVariantLink.update({
    where: { id: creada.variantLinkId! },
    data: { suspendedReason: 'NIVEL_INEXISTENTE', suspendedAt: new Date() },
  })
  const emparejada = await agregarProductoShopify(e, { stock: 4, initialized: false, createdProduct: false })
  const comparar2 = (variantLinkId: string) =>
    initializePair({ variantLinkId, nivel: ok(7), fetchedAt: new Date(), mode: 'COMPARAR' }, { hasAccess: siAcceso })
  expect(await comparar2(creada.variantLinkId!)).toBe('EN_REVISION')
  expect(await comparar2(emparejada.variantLinkId!)).toBe('EN_REVISION')
  const revision = (productId: string) => prisma.shopifyReviewItem.findFirstOrThrow({ where: { productId, status: 'OPEN' } })
  expect(await revision(creada.productId)).toMatchObject({ reason: 'REACTIVADA', firstPairing: false })
  expect(await revision(emparejada.productId)).toMatchObject({ reason: 'REACTIVADA', firstPairing: true })
})

it('P1-2 (regresión): una fila AMBIGUA con sus parámetros congelados de ese mismo producto se sigue resolviendo con su llave', async () => {
  const e = await escenario()
  await venta(e.inventoryId)
  const c1 = await reclamar()
  const timeout = graphqlFalso(falla('TIMEOUT', true, true))
  expect(await runShopifyOutboxRow(c1.id, c1.claimToken, new Date(), { graphql: timeout, hasAccess: siAcceso })).toBe('FAILED')
  expect(await fila(c1.id)).toMatchObject({ ambiguous: true, sentInventoryItemId: 'gid://shopify/InventoryItem/1' })
  await prisma.product.update({ where: { id: e.productId }, data: { unit: 'KILOGRAM' } })
  const c2 = await reclamar(new Date(Date.now() + 3_600_000))
  const graphql = graphqlFalso(exito)
  expect(await runShopifyOutboxRow(c2.id, c2.claimToken, new Date(), { graphql, hasAccess: siAcceso })).toBe('SENT')
  expect(graphql.mock.calls[0][3].key).toBe(c1.id) // la MISMA llave: pudo haber llegado
})

it('tras SENT con el espejo en negativo (vendido en caja después del pedido en línea) ⇒ aviso SOBREVENTA', async () => {
  const e = await escenario({ stock: 0 })
  await venta(e.inventoryId)
  const c = await reclamar()
  expect(await runShopifyOutboxRow(c.id, c.claimToken, new Date(), { graphql: graphqlFalso(exito), hasAccess: siAcceso })).toBe('SENT')
  expect(await espejo(e)).toBe(-1)
  expect(await avisos(e, 'SOBREVENTA')).toBe(1)
})

it('🔴 N7: si falla buscar el nombre del producto, el envío igual queda SENT y el aviso sale genérico', async () => {
  const e = await escenario({ stock: 0 })
  await venta(e.inventoryId)
  const c = await reclamar()
  const espia = jest.spyOn(prisma.product, 'findUnique').mockRejectedValueOnce(new Error('base caída'))
  try {
    expect(await runShopifyOutboxRow(c.id, c.claimToken, new Date(), { graphql: graphqlFalso(exito), hasAccess: siAcceso })).toBe('SENT')
  } finally {
    espia.mockRestore()
  }
  const aviso = await prisma.notification.findFirstOrThrow({ where: { venueId: e.venueId, entityId: { startsWith: 'SOBREVENTA:' } } })
  expect(aviso.message).toContain('Un producto')
})

it('🔴 contraejemplo #2 completo: timeout que sí llegó ⇒ INCIERTO ⇒ misma llave ⇒ SENT ⇒ sin doble descuento', async () => {
  const e = await escenario()
  await venta(e.inventoryId) // A 10 → 9, fila −1
  const t0 = new Date()
  const c1 = await reclamar(t0)
  const timeout = graphqlFalso(falla('TIMEOUT', true, true))
  expect(await runShopifyOutboxRow(c1.id, c1.claimToken, t0, { graphql: timeout, hasAccess: siAcceso })).toBe('FAILED')
  expect(await fila(c1.id)).toMatchObject({ status: 'FAILED', ambiguous: true, attempts: 1 })
  expect(await hueco(e)).toBe('0')

  // Shopify SÍ aplicó el −1 (tiene 9). Llega su aviso: el jalón no puede restar otra vez.
  expect(await aplicar(e, ok(9))).toBe('INCIERTO')
  expect(await stock(e)).toBe('9')
  expect(await espejo(e)).toBe(10)

  // Reintento con la MISMA llave: Shopify devuelve la respuesta guardada del primer intento.
  const t1 = new Date(t0.getTime() + 60_000)
  const c2 = await reclamar(t1)
  expect(c2.id).toBe(c1.id)
  const guardada = graphqlFalso(exito)
  expect(await runShopifyOutboxRow(c2.id, c2.claimToken, t1, { graphql: guardada, hasAccess: siAcceso })).toBe('SENT')
  expect(timeout.mock.calls[0][3].key).toBe(c1.id)
  expect(guardada.mock.calls[0][3].key).toBe(c1.id)
  expect(await fila(c1.id)).toMatchObject({ status: 'SENT', ambiguous: false })
  expect(await espejo(e)).toBe(9)

  // El siguiente aviso ya cuadra: nada que aplicar.
  expect(await aplicar(e, ok(9))).toBe('SIN_CAMBIO')
  expect(await stock(e)).toBe('9')
  expect(await hueco(e)).toBe('0')
})

it('🔴 N1: el envío en camino termina en Shopify DESPUÉS de suspender e intentar reactivar; al final Avoqado = 9', async () => {
  const e = await escenario()
  await venta(e.inventoryId) // A 9, espejo 10, −1 vivo
  const t0 = new Date()
  const c1 = await reclamar(t0)
  let soltar!: (r: ShopifyResult<any>) => void
  let avisarQueSalio!: () => void
  const salio = new Promise<void>(r => (avisarQueSalio = r))
  const lento = jest.fn((..._args: any[]) => {
    avisarQueSalio()
    return new Promise<ShopifyResult<any>>(r => (soltar = r))
  })
  const enCamino = runShopifyOutboxRow(c1.id, c1.claimToken, t0, { graphql: lento, hasAccess: siAcceso })
  await salio

  // Con la petición en el aire, la pareja se suspende (p. ej. el producto pasó a receta).
  // A7-2: IN_PROGRESS y los parámetros congelados ya están confirmados (se ven desde otra conexión) con la petición en el aire.
  expect(await fila(c1.id)).toMatchObject({
    status: 'IN_PROGRESS',
    sentInventoryItemId: 'gid://shopify/InventoryItem/1',
    sentLocationId: UBICACION_PRUEBA,
  })
  await prisma.$transaction(tx => suspendPair(tx, e.variantLinkId, 'SIN_INVENTARIO'))
  expect(await fila(c1.id)).toMatchObject({ status: 'IN_PROGRESS' }) // la barrera NO se borra
  expect(await comparar(e, ok(10))).toBe('REINTENTAR') // reactivar espera

  // Shopify aplica el −1 pero la respuesta se pierde.
  soltar({ ok: false, code: 'TIMEOUT', retryable: true, ambiguous: true, message: 'se cortó' })
  expect(await enCamino).toBe('FAILED')
  expect(await fila(c1.id)).toMatchObject({ status: 'FAILED', ambiguous: true })
  expect(await comparar(e, ok(9))).toBe('REINTENTAR') // sigue esperando: no sabemos si llegó

  // La fila ambigua se reclama con la pareja todavía suspendida y se resuelve con su MISMA llave.
  const t1 = new Date(t0.getTime() + 60_000)
  const c2 = await reclamar(t1)
  expect(c2.id).toBe(c1.id)
  const guardada = graphqlFalso(exito)
  expect(await runShopifyOutboxRow(c2.id, c2.claimToken, t1, { graphql: guardada, hasAccess: siAcceso })).toBe('SENT')
  expect(lento.mock.calls[0][3].key).toBe(c1.id)
  expect(guardada.mock.calls[0][3].key).toBe(c1.id)
  expect(await espejo(e)).toBe(9) // la pareja existe y su generación coincide

  // Ahora sí se reactiva: Shopify tiene 9 y Avoqado 9.
  expect(await comparar(e, ok(9))).toBe('INICIADA')
  expect(await aplicar(e, ok(9))).toBe('SIN_CAMBIO')
  expect(await stock(e)).toBe('9')
  expect(await hueco(e)).toBe('0')
})

it('🔴 una fila ambigua de una generación vieja se resuelve con su misma llave sin mirar fase ni plan; el espejo no se mueve; con la tienda REVOKED ni se reclama', async () => {
  const e = await escenario()
  await venta(e.inventoryId)
  const t0 = new Date()
  const c1 = await reclamar(t0)
  await runShopifyOutboxRow(c1.id, c1.claimToken, t0, { graphql: graphqlFalso(falla('TIMEOUT', true, true)), hasAccess: siAcceso })
  await prisma.shopifyLocationLink.update({
    where: { id: e.locationLinkId },
    data: { generation: 2, status: 'PAUSED', pausedFrom: 'ACTIVE' },
  })
  const t1 = new Date(t0.getTime() + 60_000)
  await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { status: 'REVOKED' } })
  expect(await claimShopifyOutbox(t1)).toEqual({ kind: 'VACIO' })
  await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { status: 'ACTIVE' } })
  const c2 = await reclamar(t1)
  expect(c2.id).toBe(c1.id)
  const guardada = graphqlFalso(exito)
  // Sin `hasAccess` inyectado (el negocio no tiene plan): resolver la duda no es un cambio nuevo.
  expect(await runShopifyOutboxRow(c2.id, c2.claimToken, t1, { graphql: guardada })).toBe('SENT')
  expect(guardada.mock.calls[0][3].key).toBe(c1.id)
  expect(await espejo(e)).toBe(10) // la pareja es de otra generación: el espejo no se toca
})

it('el reclamo no toma filas NO ambiguas de sucursal no ACTIVE, tienda REVOKED, pareja suspendida o sin iniciar', async () => {
  const e = await escenario()
  await venta(e.inventoryId)
  const casos: Array<[() => Promise<unknown>, () => Promise<unknown>]> = [
    [
      () => prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { status: 'PAUSED', pausedFrom: 'ACTIVE' } }),
      () => prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { status: 'ACTIVE', pausedFrom: null } }),
    ],
    [
      () => prisma.shopifyStore.update({ where: { id: e.storeId }, data: { status: 'REVOKED' } }),
      () => prisma.shopifyStore.update({ where: { id: e.storeId }, data: { status: 'ACTIVE' } }),
    ],
    [
      () => prisma.shopifyVariantLink.update({ where: { id: e.variantLinkId }, data: { suspendedReason: 'NO_RASTREADO' } }),
      () => prisma.shopifyVariantLink.update({ where: { id: e.variantLinkId }, data: { suspendedReason: null } }),
    ],
    [
      () => prisma.shopifyVariantLink.update({ where: { id: e.variantLinkId }, data: { initializedAt: null } }),
      () => prisma.shopifyVariantLink.update({ where: { id: e.variantLinkId }, data: { initializedAt: new Date() } }),
    ],
  ]
  for (const [romper, arreglar] of casos) {
    await romper()
    expect(await claimShopifyOutbox(new Date())).toEqual({ kind: 'VACIO' })
    await arreglar()
  }
  expect((await claimShopifyOutbox(new Date())).kind).toBe('FILA')
})

it('🔴 una fila NO ambigua de una generación vieja no se reclama (#8)', async () => {
  const e = await escenario()
  await venta(e.inventoryId)
  await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { generation: 2 } })
  expect(await claimShopifyOutbox(new Date())).toEqual({ kind: 'VACIO' })
})

it('🔴 una fila ambigua con la ventana de 23 h vencida queda en CUARENTENA y el worker sigue con la sana (#12)', async () => {
  const e = await escenario()
  const otro = await agregarProductoShopify(e)
  await venta(e.inventoryId)
  await venta(otro.inventoryId)
  const ahora = new Date()
  await prisma.shopifyStockOutbox.updateMany({
    where: { productId: e.productId },
    data: {
      status: 'FAILED',
      ambiguous: true,
      attempts: 1,
      firstAttemptAt: new Date(ahora.getTime() - 24 * 3600_000),
      scheduledAt: new Date(ahora.getTime() - 3600_000),
    },
  })
  const vieja = await filaDe(e.productId)
  const sana = await filaDe(otro.productId)
  expect(await claimShopifyOutbox(ahora)).toEqual({ kind: 'CUARENTENA', id: vieja.id })
  const cuarentena = await fila(vieja.id)
  expect(cuarentena).toMatchObject({ status: 'DEAD_LETTER', lastError: 'VENTANA_24H', ambiguous: true, claimToken: null, leaseUntil: null })
  expect(cuarentena.processedAt).not.toBeNull()
  expect(await claimShopifyOutbox(ahora)).toMatchObject({ kind: 'FILA', id: sana.id })
  expect(await avisos(e, 'ATORADOS')).toBe(1)
  expect(await hueco(e)).toBe('0') // el DEAD_LETTER sigue en la cuenta
})

it('una fila NO ambigua con la ventana vencida sí se manda: nunca llegó, y abre su ventana de nuevo', async () => {
  const e = await escenario()
  await venta(e.inventoryId)
  const ahora = new Date()
  await prisma.shopifyStockOutbox.updateMany({
    where: { productId: e.productId },
    data: {
      status: 'FAILED',
      ambiguous: false,
      attempts: 1,
      firstAttemptAt: new Date(ahora.getTime() - 24 * 3600_000),
      scheduledAt: new Date(ahora.getTime() - 3600_000),
    },
  })
  const c = await reclamar(ahora)
  expect(await fila(c.id)).toMatchObject({ status: 'IN_PROGRESS', firstAttemptAt: null })
  expect(await runShopifyOutboxRow(c.id, c.claimToken, ahora, { graphql: graphqlFalso(exito), hasAccess: siAcceso })).toBe('SENT')
  expect((await fila(c.id)).firstAttemptAt?.getTime()).toBe(ahora.getTime())
})

it('lease vencido: cuenta un intento; es ambiguo sólo si la petición pudo salir; con el tope ⇒ CUARENTENA LEASE_EXPIRED', async () => {
  const e = await escenario()
  await venta(e.inventoryId)
  const ahora = new Date()
  const f = await filaDe(e.productId)
  const muerta = { status: 'IN_PROGRESS' as const, claimToken: 'muerto', leaseUntil: new Date(ahora.getTime() - 60_000) }
  // Murió antes de mandar: sin parámetros congelados, la petición nunca salió ⇒ no es ambigua.
  await prisma.shopifyStockOutbox.update({ where: { id: f.id }, data: { ...muerta, attempts: 1 } })
  expect((await reclamar(ahora)).id).toBe(f.id)
  expect(await fila(f.id)).toMatchObject({ attempts: 2, ambiguous: false })
  // Murió con la petición en el aire ⇒ ambigua.
  await prisma.shopifyStockOutbox.update({
    where: { id: f.id },
    data: {
      ...muerta,
      sentInventoryItemId: 'gid://shopify/InventoryItem/1',
      sentLocationId: UBICACION_PRUEBA,
      firstAttemptAt: new Date(ahora.getTime() - 5 * 60_000),
    },
  })
  expect((await reclamar(ahora)).id).toBe(f.id)
  expect(await fila(f.id)).toMatchObject({ status: 'IN_PROGRESS', attempts: 3, ambiguous: true })
  await prisma.shopifyStockOutbox.update({ where: { id: f.id }, data: { attempts: 5, leaseUntil: new Date(ahora.getTime() - 60_000) } })
  expect(await claimShopifyOutbox(ahora)).toEqual({ kind: 'CUARENTENA', id: f.id })
  expect(await fila(f.id)).toMatchObject({ status: 'DEAD_LETTER', lastError: 'LEASE_EXPIRED', attempts: 6, ambiguous: true })
})

it('falla reintentable ⇒ FAILED con espera creciente; al 6º intento DEAD_LETTER conservando ambiguous y avisando', async () => {
  const e = await escenario()
  await venta(e.inventoryId)
  const caido = graphqlFalso(falla('HTTP_5XX', true, true))
  const esperasMin = [0.5, 2, 10, 60, 360]
  const resultados: string[] = []
  let ahora = new Date()
  for (let i = 0; i < SHOPIFY_OUTBOX_MAX_ATTEMPTS; i++) {
    const c = await reclamar(ahora)
    resultados.push(await runShopifyOutboxRow(c.id, c.claimToken, ahora, { graphql: caido, hasAccess: siAcceso }))
    if (i < esperasMin.length) {
      const f = await filaDe(e.productId)
      expect(f.scheduledAt.getTime() - ahora.getTime()).toBe(esperasMin[i] * 60_000)
      // Antes de su hora no sale (2 s antes: más que la holgura de reloj de 1 s).
      expect(await claimShopifyOutbox(new Date(f.scheduledAt.getTime() - 2_000))).toEqual({ kind: 'VACIO' })
      ahora = new Date(f.scheduledAt.getTime() + 1_000)
    }
  }
  expect(resultados).toEqual(['FAILED', 'FAILED', 'FAILED', 'FAILED', 'FAILED', 'DEAD_LETTER'])
  expect(await filaDe(e.productId)).toMatchObject({ status: 'DEAD_LETTER', ambiguous: true, attempts: 6 })
  expect(await espejo(e)).toBe(10)
  expect(await avisos(e, 'ATORADOS')).toBe(1)
  expect(await hueco(e)).toBe('0')
})

it('401 con el token vigente ⇒ tienda REVOKED (la sucursal conserva su fase), fila PENDING sin gastar intento, aviso', async () => {
  const e = await escenario()
  ;(logAction as jest.Mock).mockClear()
  await venta(e.inventoryId)
  const c = await reclamar()
  expect(
    await runShopifyOutboxRow(c.id, c.claimToken, new Date(), {
      graphql: graphqlFalso(falla('UNAUTHORIZED', false, false)),
      hasAccess: siAcceso,
    }),
  ).toBe('REVOKED')
  const store = await prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })
  expect(store.status).toBe('REVOKED')
  expect(store.revokedAt).not.toBeNull()
  expect((await prisma.shopifyLocationLink.findUniqueOrThrow({ where: { id: e.locationLinkId } })).status).toBe('ACTIVE')
  expect(await fila(c.id)).toMatchObject({ status: 'PENDING', attempts: 0, claimToken: null })
  expect(await avisos(e, 'REVOCADA')).toBe(1)
  expect(await hueco(e)).toBe('0')
  // M5: la revocación del mensajero deja rastro como cualquier otra (revocarTiendaSiVigente).
  expect(logAction).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'SHOPIFY_STORE_REVOKED',
      entity: 'ShopifyStore',
      entityId: e.storeId,
      organizationId: e.organizationId,
    }),
  )
})

describe('M6: lo que no gastó un intento de verdad no lo cuenta', () => {
  const clave = process.env.SHOPIFY_TOKEN_KEY
  afterEach(() => {
    process.env.SHOPIFY_TOKEN_KEY = clave
  })
  const errores = () => (logger.error as jest.Mock).mock.calls.map(c => String(c[0]))

  it('🔴 una SHOPIFY_TOKEN_KEY equivocada no manda filas a DEAD_LETTER: cada vez vuelven sin gastar intento, sin salir a la red, y queda en el log de errores', async () => {
    const e = await escenario()
    await venta(e.inventoryId)
    process.env.SHOPIFY_TOKEN_KEY = 'b'.repeat(64) // otra llave válida: el token guardado ya no se puede descifrar
    ;(logger.error as jest.Mock).mockClear()
    const graphql = graphqlFalso(exito)
    const t0 = Date.now()
    for (let i = 0; i < SHOPIFY_OUTBOX_MAX_ATTEMPTS + 2; i++) {
      const ahora = new Date(t0 + i * 61_000) // cada vuelta, pasada la espera de la anterior
      const c = await reclamar(ahora)
      expect(await runShopifyOutboxRow(c.id, c.claimToken, ahora, { graphql, hasAccess: siAcceso })).toBe('PAUSADO')
    }
    expect(await filaDe(e.productId)).toMatchObject({ status: 'PENDING', attempts: 0, claimToken: null, ambiguous: false })
    expect(graphql).not.toHaveBeenCalled()
    expect(errores().some(m => m.includes('SHOPIFY_TOKEN_KEY'))).toBe(true)
    expect(await avisos(e, 'ATORADOS')).toBe(0)
    process.env.SHOPIFY_TOKEN_KEY = clave // la llave correcta otra vez: sale a la primera
    const c = await reclamar(new Date(t0 + 20 * 61_000))
    expect(await runShopifyOutboxRow(c.id, c.claimToken, new Date(), { graphql, hasAccess: siAcceso })).toBe('SENT')
    expect(await hueco(e)).toBe('0')
  })

  it('🔴 THROTTLED (429 o THROTTLED en un 200) devuelve la fila sin gastar intento y sin tocar la duda; nunca llega a DEAD_LETTER por eso', async () => {
    const e = await escenario()
    await venta(e.inventoryId)
    const graphql = graphqlFalso(falla('THROTTLED', true, false))
    const t0 = Date.now()
    for (let i = 0; i < SHOPIFY_OUTBOX_MAX_ATTEMPTS + 2; i++) {
      const ahora = new Date(t0 + i * 61_000)
      const c = await reclamar(ahora)
      expect(await runShopifyOutboxRow(c.id, c.claimToken, ahora, { graphql, hasAccess: siAcceso })).toBe('PAUSADO')
    }
    expect(graphql).toHaveBeenCalledTimes(SHOPIFY_OUTBOX_MAX_ATTEMPTS + 2)
    expect(await filaDe(e.productId)).toMatchObject({ status: 'PENDING', attempts: 0, ambiguous: false, claimToken: null })
    expect(await avisos(e, 'ATORADOS')).toBe(0)
    expect(await hueco(e)).toBe('0')
  })

  it('THROTTLED sobre una fila que ya era ambigua la deja ambigua y con su ventana (se resuelve con la misma llave)', async () => {
    const e = await escenario()
    await venta(e.inventoryId)
    const ahora = new Date()
    const c = await reclamar(ahora)
    expect(
      await runShopifyOutboxRow(c.id, c.claimToken, ahora, { graphql: graphqlFalso(falla('TIMEOUT', true, true)), hasAccess: siAcceso }),
    ).toBe('FAILED')
    const ambigua = await filaDe(e.productId)
    expect(ambigua).toMatchObject({ ambiguous: true, attempts: 1 })
    const despues = new Date(ahora.getTime() + 61_000)
    const c2 = await reclamar(despues)
    expect(
      await runShopifyOutboxRow(c2.id, c2.claimToken, despues, {
        graphql: graphqlFalso(falla('THROTTLED', true, false)),
        hasAccess: siAcceso,
      }),
    ).toBe('PAUSADO')
    expect(await filaDe(e.productId)).toMatchObject({
      status: 'FAILED',
      ambiguous: true,
      attempts: 1,
      firstAttemptAt: ambigua.firstAttemptAt,
    })
  })
})

it('🔴 401 de un token viejo (se reautorizó mientras volaba la petición) NO revoca; la fila vuelve a PENDING (#13)', async () => {
  const e = await escenario()
  await venta(e.inventoryId)
  const c = await reclamar()
  const viejo = jest.fn(async () => {
    await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { tokenVersion: 2 } })
    return { ok: false as const, code: 'UNAUTHORIZED' as const, retryable: false, ambiguous: false, message: 'prueba' }
  })
  expect(await runShopifyOutboxRow(c.id, c.claimToken, new Date(), { graphql: viejo, hasAccess: siAcceso })).toBe('FAILED')
  expect(await prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })).toMatchObject({ status: 'ACTIVE', tokenVersion: 2 })
  expect(await fila(c.id)).toMatchObject({ status: 'PENDING', attempts: 0 })
  expect(await avisos(e, 'REVOCADA')).toBe(0)
  expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'SHOPIFY_STORE_REVOKED', entityId: e.storeId }))
})

it('HTTP 403 ⇒ DEAD_LETTER FALTA_PERMISO, sin revocar, con aviso', async () => {
  const e = await escenario()
  await venta(e.inventoryId)
  const c = await reclamar()
  expect(
    await runShopifyOutboxRow(c.id, c.claimToken, new Date(), {
      graphql: graphqlFalso(falla('FORBIDDEN', false, false)),
      hasAccess: siAcceso,
    }),
  ).toBe('DEAD_LETTER')
  expect((await fila(c.id)).lastError).toMatch(/^FALTA_PERMISO/)
  expect((await prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })).status).toBe('ACTIVE')
  expect(await avisos(e, 'FALTA_PERMISO')).toBe(1)
})

it('🔴 §11.3: 403 con la credencial vigente ⇒ la sucursal queda FALTA_PERMISO, un solo aviso, y no sale nada más de ella (las inciertas se conservan)', async () => {
  const e = await escenario()
  const otro = await agregarProductoShopify(e)
  await venta(e.inventoryId)
  await venta(otro.inventoryId)
  const deE = await filaDe(e.productId)
  await prisma.shopifyStockOutbox.update({ where: { id: deE.id }, data: { scheduledAt: new Date(Date.now() - 60_000) } })
  // La de `otro` quedó incierta de un intento anterior: es de las que se resuelven con su llave.
  await prisma.shopifyStockOutbox.updateMany({
    where: { productId: otro.productId },
    data: {
      status: 'FAILED',
      ambiguous: true,
      attempts: 1,
      firstAttemptAt: new Date(),
      sentInventoryItemId: 'gid://shopify/InventoryItem/otro',
      sentLocationId: UBICACION_PRUEBA,
      scheduledAt: new Date(Date.now() - 30_000),
    },
  })
  const c = await reclamar()
  expect(c.id).toBe(deE.id)
  expect(
    await runShopifyOutboxRow(c.id, c.claimToken, new Date(), {
      graphql: graphqlFalso(falla('FORBIDDEN', false, false)),
      hasAccess: siAcceso,
    }),
  ).toBe('DEAD_LETTER')
  expect((await sucursal(e)).importError).toBe('FALTA_PERMISO')
  expect(await avisos(e, 'FALTA_PERMISO')).toBe(1)
  expect(await claimShopifyOutbox(new Date())).toEqual({ kind: 'VACIO' }) // ni la incierta sale mientras falte el permiso
  expect(await filaDe(otro.productId)).toMatchObject({ status: 'FAILED', ambiguous: true, attempts: 1 })
  // Otro 403 de la misma credencial no vuelve a avisar.
  expect(await prisma.$transaction(tx => marcarFaltaPermiso(tx, { storeId: e.storeId, tokenVersion: 1 }))).toBe(true)
  expect(await avisos(e, 'FALTA_PERMISO')).toBe(1)
  // Reautorizar (plan B) limpia la marca: la incierta vuelve a salir para resolverse con su llave.
  await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { importError: null } })
  expect((await reclamar()).id).toBe((await filaDe(otro.productId)).id)
})

it('🔴 §11.3: 403 de una credencial vieja (se reautorizó mientras volaba) ⇒ ni marca ni avisa; la fila queda reintentable', async () => {
  const e = await escenario()
  await venta(e.inventoryId)
  const c = await reclamar()
  const viejo = jest.fn(async (..._args: any[]) => {
    await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { tokenVersion: 2 } })
    return { ok: false as const, code: 'FORBIDDEN' as const, retryable: false, ambiguous: false, message: 'prueba' }
  })
  expect(await runShopifyOutboxRow(c.id, c.claimToken, new Date(), { graphql: viejo, hasAccess: siAcceso })).toBe('FAILED')
  expect(await fila(c.id)).toMatchObject({ status: 'FAILED', ambiguous: false, attempts: 1, claimToken: null })
  expect((await fila(c.id)).lastError).toMatch(/^FALTA_PERMISO/)
  expect((await sucursal(e)).importError).toBeNull()
  expect(await avisos(e, 'FALTA_PERMISO')).toBe(0)
  expect(await avisos(e, 'ATORADOS')).toBe(0)
  expect(await hueco(e)).toBe('0')
})

it('🔴 N5: ACCESS_DENIED en un 200 (cuerpo real, cliente real) ⇒ DEAD_LETTER FALTA_PERMISO que conserva la duda; tienda ACTIVE; aviso', async () => {
  const e = await escenario()
  await venta(e.inventoryId)
  await prisma.shopifyStockOutbox.updateMany({
    where: { productId: e.productId },
    data: {
      status: 'FAILED',
      ambiguous: true,
      attempts: 1,
      firstAttemptAt: new Date(),
      sentInventoryItemId: 'gid://shopify/InventoryItem/1',
      sentLocationId: UBICACION_PRUEBA,
    },
  })
  const fetchOriginal = global.fetch
  global.fetch = jest.fn(async () => ({ status: 200, text: async () => JSON.stringify(CUERPO_ACCESS_DENIED) })) as unknown as typeof fetch
  let resultado = ''
  try {
    const c = await reclamar()
    resultado = await runShopifyOutboxRow(c.id, c.claimToken, new Date(), { graphql: shopifyGraphql, hasAccess: siAcceso })
  } finally {
    global.fetch = fetchOriginal
  }
  expect(resultado).toBe('DEAD_LETTER')
  const f = await filaDe(e.productId)
  expect(f).toMatchObject({ status: 'DEAD_LETTER', ambiguous: true, attempts: 2 })
  expect(f.lastError).toMatch(/^FALTA_PERMISO/)
  expect((await prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })).status).toBe('ACTIVE')
  expect(await avisos(e, 'FALTA_PERMISO')).toBe(1)
  expect(await hueco(e)).toBe('0')
})

it.each([false, true])('🔴 userErrors definitivos ⇒ DEAD_LETTER que conserva la duda previa (¿ambigua antes? %s) (N2)', async previa => {
  const e = await escenario()
  await venta(e.inventoryId)
  if (previa) {
    await prisma.shopifyStockOutbox.updateMany({
      where: { productId: e.productId },
      data: {
        ambiguous: true,
        attempts: 1,
        firstAttemptAt: new Date(),
        sentInventoryItemId: 'gid://shopify/InventoryItem/1',
        sentLocationId: UBICACION_PRUEBA,
      },
    })
  }
  const c = await reclamar()
  expect(
    await runShopifyOutboxRow(c.id, c.claimToken, new Date(), { graphql: graphqlFalso(conError('INVALID_LOCATION')), hasAccess: siAcceso }),
  ).toBe('DEAD_LETTER')
  const f = await fila(c.id)
  expect(f).toMatchObject({ status: 'DEAD_LETTER', ambiguous: previa })
  expect(f.lastError).toContain('INVALID_LOCATION')
  expect(await hueco(e)).toBe('0')
})

it('🔴 N2: IDEMPOTENCY_KEY_PARAMETER_MISMATCH sobre una fila ambigua ⇒ DEAD_LETTER que SIGUE ambigua y el jalón sigue bloqueado', async () => {
  const e = await escenario()
  await venta(e.inventoryId)
  const t0 = new Date()
  const c1 = await reclamar(t0)
  await runShopifyOutboxRow(c1.id, c1.claimToken, t0, { graphql: graphqlFalso(falla('TIMEOUT', true, true)), hasAccess: siAcceso })
  const t1 = new Date(t0.getTime() + 60_000)
  const c2 = await reclamar(t1)
  expect(
    await runShopifyOutboxRow(c2.id, c2.claimToken, t1, {
      graphql: graphqlFalso(conError('IDEMPOTENCY_KEY_PARAMETER_MISMATCH')),
      hasAccess: siAcceso,
    }),
  ).toBe('DEAD_LETTER')
  expect(await fila(c1.id)).toMatchObject({ status: 'DEAD_LETTER', ambiguous: true })
  expect(await aplicar(e, ok(9))).toBe('INCIERTO')
  expect(await hueco(e)).toBe('0')
})

it('IDEMPOTENCY_CONCURRENT_REQUEST ⇒ FAILED y ambiguo (el primero sigue en curso)', async () => {
  const e = await escenario()
  await venta(e.inventoryId)
  const c = await reclamar()
  expect(
    await runShopifyOutboxRow(c.id, c.claimToken, new Date(), {
      graphql: graphqlFalso(conError('IDEMPOTENCY_CONCURRENT_REQUEST')),
      hasAccess: siAcceso,
    }),
  ).toBe('FAILED')
  expect(await fila(c.id)).toMatchObject({ status: 'FAILED', ambiguous: true, attempts: 1 })
})

it('SERVICE_UNAVAILABLE en userErrors ⇒ FAILED reintentable que no inventa duda', async () => {
  const e = await escenario()
  await venta(e.inventoryId)
  const c = await reclamar()
  expect(
    await runShopifyOutboxRow(c.id, c.claimToken, new Date(), {
      graphql: graphqlFalso(conError('SERVICE_UNAVAILABLE')),
      hasAccess: siAcceso,
    }),
  ).toBe('FAILED')
  expect(await fila(c.id)).toMatchObject({ status: 'FAILED', ambiguous: false, attempts: 1 })
})

it.each([
  ['TIMEOUT', true, 'FAILED'],
  ['THROTTLED', false, 'PAUSADO'], // M6: vuelve sin gastar intento
] as const)(
  '🔴 tras %s el reintento manda EXACTAMENTE los parámetros del primer intento, aunque la pareja cambie (N2)',
  async (code, ambigua, salida) => {
    const e = await escenario()
    await venta(e.inventoryId)
    const t0 = new Date()
    const c1 = await reclamar(t0)
    const primero = graphqlFalso(falla(code, true, ambigua))
    expect(await runShopifyOutboxRow(c1.id, c1.claimToken, t0, { graphql: primero, hasAccess: siAcceso })).toBe(salida)
    expect(await fila(c1.id)).toMatchObject({
      ambiguous: ambigua,
      sentInventoryItemId: 'gid://shopify/InventoryItem/1',
      sentLocationId: UBICACION_PRUEBA,
    })
    await prisma.shopifyVariantLink.update({ where: { id: e.variantLinkId }, data: { inventoryItemId: 'gid://shopify/InventoryItem/999' } })
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { shopifyLocationId: 'gid://shopify/Location/9' } })
    const t1 = new Date(t0.getTime() + 60 * 60_000)
    const c2 = await reclamar(t1)
    const segundo = graphqlFalso(exito)
    expect(await runShopifyOutboxRow(c2.id, c2.claimToken, t1, { graphql: segundo, hasAccess: siAcceso })).toBe('SENT')
    expect(segundo.mock.calls[0][3].input.changes).toEqual(primero.mock.calls[0][3].input.changes)
    expect(segundo.mock.calls[0][3].key).toBe(c1.id)
    expect(await hueco(e)).toBe('0')
  },
)

it('delta con decimales ⇒ DEAD_LETTER DELTA_NO_ENTERO sin llamar a Shopify (y sigue en la cuenta)', async () => {
  const e = await escenario()
  await prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 0.5 WHERE id = ${e.inventoryId}`
  const graphql = graphqlFalso(exito)
  const c = await reclamar()
  expect(await runShopifyOutboxRow(c.id, c.claimToken, new Date(), { graphql, hasAccess: siAcceso })).toBe('DEAD_LETTER')
  expect(graphql).not.toHaveBeenCalled()
  expect(await fila(c.id)).toMatchObject({ lastError: 'DELTA_NO_ENTERO', attempts: 0, ambiguous: false })
  expect(await hueco(e)).toBe('0')
})

it('🔴 sin acceso al plan (el acceso real, sin inyectar) ⇒ PAUSADO: no llama a Shopify ni gasta intento ni abre ventana (#14)', async () => {
  const e = await escenario()
  await venta(e.inventoryId)
  const graphql = graphqlFalso(exito)
  const ahora = new Date()
  const c = await reclamar(ahora)
  expect(await runShopifyOutboxRow(c.id, c.claimToken, ahora, { graphql })).toBe('PAUSADO')
  expect(graphql).not.toHaveBeenCalled()
  const f = await fila(c.id)
  expect(f).toMatchObject({ status: 'PENDING', attempts: 0, firstAttemptAt: null, claimToken: null, sentInventoryItemId: null })
  expect(f.scheduledAt.getTime()).toBeGreaterThan(ahora.getTime())
})

it('la sucursal se pausó entre el reclamo y el envío ⇒ PAUSADO', async () => {
  const e = await escenario()
  await venta(e.inventoryId)
  const c = await reclamar()
  await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { status: 'PAUSED', pausedFrom: 'ACTIVE' } })
  const graphql = graphqlFalso(exito)
  expect(await runShopifyOutboxRow(c.id, c.claimToken, new Date(), { graphql, hasAccess: siAcceso })).toBe('PAUSADO')
  expect(graphql).not.toHaveBeenCalled()
  expect(await fila(c.id)).toMatchObject({ status: 'PENDING', claimToken: null, attempts: 0, sentInventoryItemId: null })
})

it('🔴 A7-5: se desconectó entre el reclamo y el envío: la fila nunca salió ⇒ DISCARDED GENERACION_VIEJA, sin llamar a Shopify', async () => {
  const e = await escenario()
  await venta(e.inventoryId)
  const c = await reclamar()
  // Lo que hace la desconexión de B: sube la generación y deja en paz lo que ya va en camino. Ésta todavía no salía.
  await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { status: 'DISCONNECTED', generation: 2 } })
  const graphql = graphqlFalso(exito)
  expect(await runShopifyOutboxRow(c.id, c.claimToken, new Date(), { graphql, hasAccess: siAcceso })).toBe('DISCARDED')
  expect(graphql).not.toHaveBeenCalled()
  expect(await fila(c.id)).toMatchObject({
    status: 'DISCARDED',
    lastError: 'GENERACION_VIEJA',
    claimToken: null,
    sentInventoryItemId: null,
  })
  expect(await espejo(e)).toBe(10)
})

it('🔴 A7-5 bajo candado: la desconexión llega DESPUÉS de leer y ANTES de congelar ⇒ DISCARDED; nunca sale con la generación vieja', async () => {
  const e = await escenario()
  await venta(e.inventoryId)
  const c = await reclamar()
  const graphql = graphqlFalso(exito)
  const accesoQueDesconecta = async () => {
    // Corre entre la lectura sin candado (generación 1, se ve enviable) y la tx previa al HTTP: sólo el candado lo ve.
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { status: 'DISCONNECTED', generation: 2 } })
    return true
  }
  expect(await runShopifyOutboxRow(c.id, c.claimToken, new Date(), { graphql, hasAccess: accesoQueDesconecta })).toBe('DISCARDED')
  expect(graphql).not.toHaveBeenCalled()
  expect(await fila(c.id)).toMatchObject({
    status: 'DISCARDED',
    lastError: 'GENERACION_VIEJA',
    sentInventoryItemId: null,
    firstAttemptAt: null,
  })
  expect(await espejo(e)).toBe(10)
})

it('🔴 §12.3 (con barreras): con la petición en el aire, desconectar toma la sucursal y las parejas → confirmar espera → desconectar sube a la generación 2 → confirmar sigue ⇒ SENT sin mover el espejo', async () => {
  const e = await escenario()
  await venta(e.inventoryId)
  const c = await reclamar()
  let tomada!: () => void
  const parejaTomada = new Promise<void>(r => (tomada = r))
  let soltar!: () => void
  const terminar = new Promise<void>(r => (soltar = r))
  let desconexion: Promise<void> = Promise.resolve()
  // Shopify ya aplicó el −1 y, mientras la respuesta viene en camino, empieza la desconexión de B (§11.7): sucursal y
  // parejas FOR UPDATE; la generación sube al final.
  const enElAire: jest.Mock = jest.fn(async (..._args: any[]) => {
    desconexion = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "ShopifyLocationLink" WHERE id = ${e.locationLinkId} FOR UPDATE`
        await tx.$queryRaw`SELECT id FROM "ShopifyVariantLink" WHERE "locationLinkId" = ${e.locationLinkId} ORDER BY id FOR UPDATE`
        tomada()
        await terminar
        await tx.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { status: 'DISCONNECTED', generation: 2 } })
      },
      { timeout: 20_000 },
    )
    await parejaTomada
    return exito()
  })
  const envio = runShopifyOutboxRow(c.id, c.claimToken, new Date(), { graphql: enElAire, hasAccess: siAcceso })
  try {
    // A7-1: confirmar pide la sucursal FOR SHARE ANTES que la pareja, así que espera ahí.
    await esperarCandado('ShopifyLocationLink')
  } finally {
    soltar() // aunque la barrera falle, la desconexión no se queda colgada
  }
  await desconexion
  expect(await envio).toBe('SENT')
  expect(await fila(c.id)).toMatchObject({ status: 'SENT', ambiguous: false })
  expect(await espejo(e)).toBe(10) // con la generación leída antes del candado lo dejaba en 9
}, 30_000)

it('🔴 un IN_PROGRESS abandonado se retoma aunque su pareja esté suspendida o su generación sea vieja: nada se queda atorado y lo que nunca salió no sale', async () => {
  const e = await escenario()
  const otro = await agregarProductoShopify(e)
  await venta(e.inventoryId)
  await venta(otro.inventoryId)
  const ahora = new Date()
  const abandonada = { status: 'IN_PROGRESS' as const, claimToken: 'muerto', leaseUntil: new Date(ahora.getTime() - 60_000) }
  await prisma.shopifyStockOutbox.updateMany({ where: { productId: { in: [e.productId, otro.productId] } }, data: abandonada })
  // La de `otro` nunca salió y su pareja se suspendió: se retoma y se descarta.
  await prisma.shopifyVariantLink.update({
    where: { id: otro.variantLinkId! },
    data: { suspendedReason: 'SIN_INVENTARIO', suspendedAt: new Date() },
  })
  const deOtro = await filaDe(otro.productId)
  await prisma.shopifyStockOutbox.update({ where: { id: deOtro.id }, data: { scheduledAt: new Date(ahora.getTime() - 3_600_000) } })
  const c1 = await reclamar(ahora)
  expect(c1.id).toBe(deOtro.id)
  expect(await runShopifyOutboxRow(c1.id, c1.claimToken, ahora, { graphql: graphqlFalso(exito), hasAccess: siAcceso })).toBe('DISCARDED')
  expect(await fila(deOtro.id)).toMatchObject({ status: 'DISCARDED', lastError: 'PAREJA_SUSPENDIDA' })
  // La de `e` tampoco salió y es de una generación vieja: se retoma y se descarta sin llamar a Shopify (A7-5).
  await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { generation: 2 } })
  const c2 = await reclamar(ahora)
  const graphql = graphqlFalso(exito)
  expect(await runShopifyOutboxRow(c2.id, c2.claimToken, ahora, { graphql, hasAccess: siAcceso })).toBe('DISCARDED')
  expect(graphql).not.toHaveBeenCalled()
  expect(await fila(c2.id)).toMatchObject({ status: 'DISCARDED', lastError: 'GENERACION_VIEJA' })
  expect(await espejo(e)).toBe(10)
  expect(await claimShopifyOutbox(ahora)).toEqual({ kind: 'VACIO' })
})

it('🔴 A7-1: el reclamo toma la pareja ANTES que la fila: mientras COMPARAR la tiene, espera y, al terminar, ya no hay qué reclamar', async () => {
  const e = await escenario()
  await venta(e.inventoryId)
  const f = await filaDe(e.productId)
  let tomada!: () => void
  const parejaTomada = new Promise<void>(r => (tomada = r))
  let soltar!: () => void
  const terminar = new Promise<void>(r => (soltar = r))
  // Lo que hace COMPARAR (A6): sucursal → tienda → pareja; ya revisó que el producto está LIBRE y luego descarta sus filas.
  const comparando = prisma.$transaction(
    async tx => {
      await tx.$queryRaw`SELECT id FROM "ShopifyLocationLink" WHERE id = ${e.locationLinkId} FOR SHARE`
      await tx.$queryRaw`SELECT id FROM "ShopifyStore" WHERE id = ${e.storeId} FOR SHARE`
      await tx.$queryRaw`SELECT id FROM "ShopifyVariantLink" WHERE id = ${e.variantLinkId} FOR UPDATE`
      tomada()
      await terminar
      await tx.shopifyStockOutbox.update({ where: { id: f.id }, data: { status: 'DISCARDED', lastError: 'PAREJA_REACTIVADA' } })
    },
    { timeout: 20_000 },
  )
  await parejaTomada
  const reclamo = claimShopifyOutbox(new Date())
  try {
    // Con la fila primero (o sin la pareja), el reclamo ya habría tomado la fila sin esperar a nadie.
    await esperarCandado('ShopifyVariantLink')
  } finally {
    soltar()
  }
  await comparando
  expect(await reclamo).toEqual({ kind: 'VACIO' })
  expect(await fila(f.id)).toMatchObject({ status: 'DISCARDED', claimToken: null, attempts: 0 })
}, 30_000)

const MALFORMADAS: Array<[string, unknown]> = [
  ['éxito sin grupo de ajuste', { inventoryAdjustQuantities: { inventoryAdjustmentGroup: null, userErrors: [] } }],
  ['un grupo con id vacío', { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id: '' }, userErrors: [] } }],
  ['un userError vacío', { inventoryAdjustQuantities: { inventoryAdjustmentGroup: null, userErrors: [{}] } }],
  ['un userError nulo', { inventoryAdjustQuantities: { inventoryAdjustmentGroup: null, userErrors: [null] } }],
]
it.each(MALFORMADAS)('🔴 una respuesta con %s ⇒ BAD_RESPONSE ambiguo: FAILED, nunca SENT ni DEAD_LETTER (N4)', async (_caso, data) => {
  const e = await escenario()
  await venta(e.inventoryId)
  const c = await reclamar()
  expect(
    await runShopifyOutboxRow(c.id, c.claimToken, new Date(), { graphql: graphqlFalso(() => ({ ok: true, data })), hasAccess: siAcceso }),
  ).toBe('FAILED')
  expect(await fila(c.id)).toMatchObject({ status: 'FAILED', ambiguous: true })
  expect(await espejo(e)).toBe(10)
  expect(await hueco(e)).toBe('0')
})

it('un claimToken ajeno ⇒ SKIPPED sin tocar la fila', async () => {
  const e = await escenario()
  await venta(e.inventoryId)
  const c = await reclamar()
  expect(await runShopifyOutboxRow(c.id, 'otro-token', new Date(), { graphql: graphqlFalso(exito), hasAccess: siAcceso })).toBe('SKIPPED')
  expect((await fila(c.id)).status).toBe('IN_PROGRESS')
})

it.each(CONTEXTOS_VIEJOS)(
  '🔴 §11.2 cerco: si %s antes de enviar ⇒ CONTEXTO_CAMBIO; no sale nada y la fila sigue reclamada',
  async (_caso, envejecer) => {
    const e = await escenario()
    await venta(e.inventoryId)
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { workToken: 'mio' } })
    const c = await reclamar()
    const cerco = await envejecer(e)
    const graphql = graphqlFalso(exito)
    expect(await runShopifyOutboxRow(c.id, c.claimToken, new Date(), { graphql, hasAccess: siAcceso, cerco })).toBe('CONTEXTO_CAMBIO')
    expect(graphql).not.toHaveBeenCalled()
    expect(await fila(c.id)).toMatchObject({
      status: 'IN_PROGRESS',
      claimToken: c.claimToken,
      attempts: 0,
      ambiguous: false,
      firstAttemptAt: null,
      sentInventoryItemId: null,
    })
    expect(await espejo(e)).toBe(10)
  },
)

it('🔴 §11.2 cerco: si el contexto cambia mientras vuela la petición ⇒ CONTEXTO_CAMBIO sin mover el espejo; al vencer el lease se confirma una sola vez con la misma llave', async () => {
  const e = await escenario()
  await venta(e.inventoryId)
  await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { workToken: 'mio' } })
  const c = await reclamar()
  // Shopify sí lo aplica, pero mientras volaba otro worker se quedó con la sucursal.
  const robado: jest.Mock = jest.fn(async (..._args: any[]) => {
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { workToken: 'de-otro' } })
    return exito()
  })
  expect(
    await runShopifyOutboxRow(c.id, c.claimToken, new Date(), {
      graphql: robado,
      hasAccess: siAcceso,
      cerco: cercoDe(e, { workToken: 'mio' }),
    }),
  ).toBe('CONTEXTO_CAMBIO')
  expect(await fila(c.id)).toMatchObject({ status: 'IN_PROGRESS', sentInventoryItemId: 'gid://shopify/InventoryItem/1' })
  expect(await espejo(e)).toBe(10)
  expect(await aplicar(e, ok(9))).toBe('REINTENTAR') // sigue en vuelo: el jalón espera
  const despues = new Date(Date.now() + 130_000)
  const c2 = await reclamar(despues)
  expect(c2.id).toBe(c.id)
  expect((await fila(c.id)).ambiguous).toBe(true)
  const graphql = graphqlFalso(exito)
  const cerco = cercoDe(e, { workToken: 'de-otro' })
  expect(await runShopifyOutboxRow(c2.id, c2.claimToken, despues, { graphql, hasAccess: siAcceso, cerco })).toBe('SENT')
  expect(graphql.mock.calls[0][3].key).toBe(c.id)
  expect(await espejo(e)).toBe(9)
  expect(await hueco(e)).toBe('0')
})

const ROMPER_DURANTE: Array<[string, (e: EscenarioShopify) => Promise<unknown>]> = [
  [
    'la tienda se revoca',
    e => prisma.shopifyStore.update({ where: { id: e.storeId }, data: { status: 'REVOKED', revokedAt: new Date() } }),
  ],
  [
    'la sucursal queda FALTA_PERMISO',
    e => prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { importError: 'FALTA_PERMISO' } }),
  ],
]
it.each(ROMPER_DURANTE)(
  '🔴 §12.2 cerco: si %s mientras se prepara el envío ⇒ CONTEXTO_CAMBIO sin enviar; tras reautorizar sale con su misma llave',
  async (_caso, romper) => {
    const e = await escenario()
    await venta(e.inventoryId)
    const c = await reclamar()
    const graphql = graphqlFalso(exito)
    const accesoQueRompe = async () => {
      await romper(e) // pasa después de la lectura inicial y antes de congelar: sólo el cerco lo ve
      return true
    }
    expect(await runShopifyOutboxRow(c.id, c.claimToken, new Date(), { graphql, hasAccess: accesoQueRompe, cerco: cercoDe(e) })).toBe(
      'CONTEXTO_CAMBIO',
    )
    expect(graphql).not.toHaveBeenCalled()
    expect(await fila(c.id)).toMatchObject({ status: 'IN_PROGRESS', claimToken: c.claimToken, sentInventoryItemId: null })
    // Reautorizar (plan B, §11.4): tienda ACTIVE, credencial nueva y marca limpia. Al vencer el lease, la misma fila sale.
    await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { status: 'ACTIVE', revokedAt: null, tokenVersion: 2 } })
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { importError: null } })
    const despues = new Date(Date.now() + 130_000)
    const c2 = await reclamar(despues)
    expect(c2.id).toBe(c.id)
    expect(
      await runShopifyOutboxRow(c2.id, c2.claimToken, despues, { graphql, hasAccess: siAcceso, cerco: cercoDe(e, { tokenVersion: 2 }) }),
    ).toBe('SENT')
    expect(graphql.mock.calls[0][3].key).toBe(c.id)
    expect(await espejo(e)).toBe(9)
    expect(await hueco(e)).toBe('0')
  },
)

it('🔴 §12.4: el plazo corre desde que entra: a la petición le llega lo que queda tras el trabajo previo, con piso de 1 s', async () => {
  const e = await escenario()
  const accesoLento = async () => {
    await dormir(400) // trabajo previo que se come parte del plazo
    return true
  }
  await venta(e.inventoryId)
  const c1 = await reclamar()
  const holgado = graphqlFalso(exito)
  expect(await runShopifyOutboxRow(c1.id, c1.claimToken, new Date(), { graphql: holgado, hasAccess: accesoLento, timeoutMs: 5_000 })).toBe(
    'SENT',
  )
  const plazo: number = holgado.mock.calls[0][4].timeoutMs
  expect(plazo).toBeLessThanOrEqual(4_600) // 5 s menos los 400 ms (y algo más) que ya se fueron
  expect(plazo).toBeGreaterThanOrEqual(1_000)
  await venta(e.inventoryId)
  const c2 = await reclamar()
  const justo = graphqlFalso(exito)
  expect(await runShopifyOutboxRow(c2.id, c2.claimToken, new Date(), { graphql: justo, hasAccess: accesoLento, timeoutMs: 300 })).toBe(
    'SENT',
  )
  expect(justo.mock.calls[0][4].timeoutMs).toBe(1_000) // ya no quedaba nada: sale con el piso, nunca vencida
  expect(await hueco(e)).toBe('0')
})

it('🔴 §12.4: con el cliente real, un fetch lento se corta con lo que quedaba del plazo, no con el plazo completo', async () => {
  const e = await escenario()
  await venta(e.inventoryId)
  let salio = 0
  let cortado = 0
  const fetchOriginal = global.fetch
  global.fetch = jest.fn((_url: unknown, init: { signal: AbortSignal }) => {
    salio = Date.now()
    return new Promise<never>((_ok, falla) =>
      init.signal.addEventListener('abort', () => {
        cortado = Date.now()
        falla(init.signal.reason)
      }),
    )
  }) as unknown as typeof fetch
  let resultado = ''
  try {
    const c = await reclamar()
    const accesoLento = async () => {
      await dormir(1_200)
      return true
    }
    resultado = await runShopifyOutboxRow(c.id, c.claimToken, new Date(), {
      graphql: shopifyGraphql,
      hasAccess: accesoLento,
      timeoutMs: 2_500,
    })
  } finally {
    global.fetch = fetchOriginal
  }
  expect(resultado).toBe('FAILED') // TIMEOUT: reintentable y ambiguo
  expect(await filaDe(e.productId)).toMatchObject({ status: 'FAILED', ambiguous: true })
  expect(cortado - salio).toBeGreaterThanOrEqual(950)
  expect(cortado - salio).toBeLessThan(2_400) // quedaban ≈1.3 s; con el plazo completo habrían sido 2.5 s (K5: holgura por la Mac compartida)
  expect(await hueco(e)).toBe('0')
}, 15_000)
