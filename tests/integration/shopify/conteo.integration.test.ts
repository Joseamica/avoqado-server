// tests/integration/shopify/conteo.integration.test.ts
/**
 * El conteo (B6, 12 bis.14, §11.1, §12.1): se cuentan TODAS las piezas del estante y Avoqado guarda `contado − apartadas
 * DEL ESPEJO`, leídas bajo candado en la tx de la línea; con un envío en camino la línea NO se aplica. Cada recorrido
 * termina comparando las cantidades de los DOS lados: Avoqado y una Shopify falsa con estado (`tiendaFalsa`), después de
 * mandar lo encolado y de jalar lo que Shopify cambió. Shopify entra por el 5º parámetro de confirmStockCount y por
 * `deps.graphql` del mensajero: nunca sale a la red.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import * as avisos from '@/services/commerce-channels/shopify/shopify.notify.service'
import { confirmStockCount } from '@/services/mobile/inventory.mobile.service'
import {
  apartadasBajoCandado,
  ENVIO_EN_CAMINO,
  refrescarEspejoParaConteo,
} from '@/services/commerce-channels/shopify/shopify.count.service'
import { applyShopifyLevel, initializePair } from '@/services/commerce-channels/shopify/shopify.mirror.service'
import { claimShopifyOutbox, runShopifyOutboxRow } from '@/services/commerce-channels/shopify/shopify.outbox.service'
import {
  applyConnectPage,
  requestApplyShopifyConnect,
  resumeShopifyLink,
} from '@/services/commerce-channels/shopify/shopify.connect.service'
import {
  agregarProductoShopify,
  assertTestDatabase,
  crearEscenarioShopify,
  EscenarioShopify,
  huecoDelInvariante,
  limpiarEscenarioShopify,
} from './fixtures'
import { conPlan, dormir, falla, nivel, nivelesFalsos, tiendaFalsa } from './fixturesB'

jest.setTimeout(120_000)

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

/** La respuesta del último `contar`. */
let ultima: Awaited<ReturnType<typeof confirmStockCount>> | null = null
async function contar(e: EscenarioShopify, contado: string, deps: Parameters<typeof confirmStockCount>[4] = {}) {
  const c = await prisma.stockCount.create({
    data: {
      venueId: e.venueId,
      type: 'CYCLE',
      status: 'IN_PROGRESS',
      createdById: e.staffId,
      items: {
        create: { productId: e.productId, expected: new Prisma.Decimal(10), counted: new Prisma.Decimal(contado), countedAt: new Date() },
      },
    },
  })
  ultima = await confirmStockCount(c.id, e.venueId, e.staffId, 0, deps)
  return c.id
}
const stock = async (e: EscenarioShopify) =>
  (await prisma.inventory.findUniqueOrThrow({ where: { id: e.inventoryId } })).currentStock.toString()
const espejo = (e: EscenarioShopify) => prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })
const deltas = async (e: EscenarioShopify) =>
  (await prisma.shopifyStockOutbox.findMany({ where: { productId: e.productId }, orderBy: { createdAt: 'asc' }, take: 5 })).map(f =>
    f.delta.toString(),
  )
const razon = async (e: EscenarioShopify) =>
  (
    await prisma.inventoryMovement.findFirstOrThrow({
      where: { inventoryId: e.inventoryId, type: 'COUNT' },
      orderBy: { createdAt: 'desc' },
    })
  ).reason
const movimientosDeConteo = (e: EscenarioShopify) =>
  prisma.inventoryMovement.count({ where: { inventoryId: e.inventoryId, type: 'COUNT' } })
const avisosDeConteo = (e: EscenarioShopify) =>
  prisma.notification.count({ where: { venueId: e.venueId, entityType: 'ShopifyAviso', entityId: { startsWith: 'CONTEO_NO_APLICADO:' } } })
const avisoDeConteo = (e: EscenarioShopify) =>
  prisma.notification.findFirstOrThrow({
    where: { venueId: e.venueId, entityType: 'ShopifyAviso', entityId: { startsWith: 'CONTEO_NO_APLICADO:' } },
  })
/** El mensajero manda TODO lo que haya en el buzón a la Shopify falsa. */
async function enviar(t: ReturnType<typeof tiendaFalsa>) {
  for (let i = 0; i < 20; i++) {
    const c = await claimShopifyOutbox(new Date())
    if (c.kind === 'VACIO') return
    if (c.kind === 'FILA') await runShopifyOutboxRow(c.id, c.claimToken, new Date(), { graphql: t.graphql as never, hasAccess: conPlan })
  }
  throw new Error('el buzón no se vació')
}
/** El siguiente jalón: lo que Shopify tiene HOY entra al espejo y a Avoqado (lo hace un aviso o el cuadre). */
const jalar = (e: EscenarioShopify, t: ReturnType<typeof tiendaFalsa>) =>
  applyShopifyLevel(
    { variantLinkId: e.variantLinkId, nivel: nivel(t.s.available, t.s.committed), fetchedAt: new Date(), cause: 'prueba' },
    { hasAccess: conPlan },
  )
/** Una venta en caja de una pieza, ya tomada por el mensajero (en vuelo). */
async function ventaEnVuelo(e: EscenarioShopify) {
  await prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE id = ${e.inventoryId}`
  const c = await claimShopifyOutbox(new Date())
  if (c.kind !== 'FILA') throw new Error(`se esperaba FILA y llegó ${c.kind}`)
  return c
}

it('12 bis.14: 9 en el estante con 2 apartadas vigentes ⇒ Avoqado 7 y viaja −3; Shopify termina en 7', async () => {
  const e = await escenario({ mirrorCommitted: 2 })
  const t = tiendaFalsa(10, 2)
  const id = await contar(e, '9', { fetchLevels: t.fetchLevels, hasAccess: conPlan })
  expect(t.fetchLevels).toHaveBeenCalledTimes(1)
  // `leerNiveles` (B1) le pasa lo que queda de los 4 s de TODA la lectura.
  const plazo = (t.fetchLevels.mock.calls[0][2] as { timeoutMs: number }).timeoutMs
  expect(plazo).toBeGreaterThan(3_000)
  expect(plazo).toBeLessThanOrEqual(4_000)
  expect(await stock(e)).toBe('7')
  expect(await deltas(e)).toEqual(['-3'])
  expect(await razon(e)).toBe(`Conteo de inventario #${id} (menos 2 apartadas en línea)`)
  expect(ultima).toEqual({ success: true, revision: 1 }) // sin `noAplicados`: la respuesta de siempre
  await enviar(t)
  expect([await stock(e), t.s.available]).toEqual(['7', 7])
  expect(await huecoDelInvariante(e.productId)).toBe('0')
})

it('🔴 ronda 2 (P1-1): contar en la ventana de retención (pareja creada por el conector, sin iniciar) NO se aplica; al iniciar y recontar, 8 y 8', async () => {
  // Shopify tiene 10; el catálogo creó el producto con Inventory 0 y todavía no inicia la pareja. En el estante hay 8.
  const e = await escenario({ stock: 0, initialized: false })
  await prisma.shopifyVariantLink.update({ where: { id: e.variantLinkId }, data: { createdProduct: true } })
  const t = tiendaFalsa(10, 0)
  const id = await contar(e, '8', { fetchLevels: t.fetchLevels, hasAccess: conPlan })
  // Sin retenerla: objetivo = 8 ⇒ +8 retenido ⇒ TOMAR pone S + 8 = 18 y manda +8 a Shopify (18 en los dos lados).
  expect(ultima).toEqual({ success: true, revision: 1, noAplicados: [{ productId: e.productId, motivo: 'ENVIO_EN_CAMINO' }] })
  expect(await stock(e)).toBe('0')
  expect(await movimientosDeConteo(e)).toBe(0)
  expect(await deltas(e)).toEqual([])
  expect(await prisma.stockCountItem.findFirstOrThrow({ where: { stockCountId: id } })).toMatchObject({
    shopifyHeldAt: expect.any(Date),
    shopifyHeldReason: 'ENVIO_EN_CAMINO',
  })
  expect(await avisosDeConteo(e)).toBe(1)
  // La pareja se inicia (TOMAR) y se vuelve a contar: 8 en los dos lados.
  expect(
    await initializePair(
      { variantLinkId: e.variantLinkId, nivel: nivel(10), fetchedAt: new Date(), mode: 'TOMAR_SHOPIFY' },
      { hasAccess: conPlan },
    ),
  ).toBe('INICIADA')
  expect(await stock(e)).toBe('10')
  await contar(e, '8', { fetchLevels: t.fetchLevels, hasAccess: conPlan })
  expect(ultima).toEqual({ success: true, revision: 1 })
  expect(await deltas(e)).toEqual(['-2'])
  await enviar(t)
  expect([await stock(e), t.s.available]).toEqual(['8', 8])
  expect(await huecoDelInvariante(e.productId)).toBe('0')
})

it('🔴 ronda 3 (12 bis.2): contar mientras se REVISA la conexión (pareja emparejada, sin iniciar) no se aplica; al aplicar y recontar, 8 y 8', async () => {
  // Avoqado 5, Shopify 10, en el estante 8. Sin retenerla: el guardia encola +3 y TOMAR al aplicar pone 10 + 3 = 13 (y +3 viaja).
  const e = await escenario({ linkStatus: 'REVIEWING', stock: 5, initialized: false })
  const t = tiendaFalsa(10, 0)
  const id = await contar(e, '8', { fetchLevels: t.fetchLevels, hasAccess: conPlan })
  expect(ultima).toEqual({ success: true, revision: 1, noAplicados: [{ productId: e.productId, motivo: 'ENVIO_EN_CAMINO' }] })
  expect(await stock(e)).toBe('5')
  expect(await deltas(e)).toEqual([])
  expect(await prisma.stockCountItem.findFirstOrThrow({ where: { stockCountId: id } })).toMatchObject({
    shopifyHeldReason: 'ENVIO_EN_CAMINO',
  })
  // Con la sucursal en pausa desde REVIEWING (fase efectiva), igual.
  await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { status: 'PAUSED', pausedFrom: 'REVIEWING' } })
  await contar(e, '8', { fetchLevels: t.fetchLevels, hasAccess: conPlan })
  expect(ultima).toMatchObject({ noAplicados: [{ productId: e.productId, motivo: 'ENVIO_EN_CAMINO' }] })
  expect(await stock(e)).toBe('5')
  await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { status: 'REVIEWING', pausedFrom: null } })
  // Se aplica la conexión (TOMAR: Shopify gana) y se vuelve a contar: 8 en los dos lados.
  await requestApplyShopifyConnect({ venueId: e.venueId, staffId: e.staffId }, { hasAccess: conPlan })
  for (
    let i = 0;
    i < 5 && (await prisma.shopifyLocationLink.findUniqueOrThrow({ where: { id: e.locationLinkId } })).status !== 'ACTIVE';
    i++
  ) {
    await applyConnectPage(e.locationLinkId, { fetchLevels: t.fetchLevels, hasAccess: conPlan })
  }
  expect(await stock(e)).toBe('10')
  await contar(e, '8', { fetchLevels: t.fetchLevels, hasAccess: conPlan })
  expect(ultima).toEqual({ success: true, revision: 1 })
  await enviar(t)
  expect([await stock(e), t.s.available]).toEqual(['8', 8])
  expect(await huecoDelInvariante(e.productId)).toBe('0')
})

it('ronda 3: lo mismo mientras se CONECTA, con la pareja que la importación ya ligó', async () => {
  const e = await escenario({ linkStatus: 'CONNECTING', stock: 5, initialized: false })
  await contar(e, '8', { hasAccess: conPlan })
  expect(ultima).toMatchObject({ noAplicados: [{ productId: e.productId, motivo: 'ENVIO_EN_CAMINO' }] })
  expect(await stock(e)).toBe('5')
})

it('ronda 3 (regresión): en ACTIVE, una pareja iniciada cuenta como siempre: 12 bis.14, 7 y 7', async () => {
  const e = await escenario({ mirrorCommitted: 2 })
  const t = tiendaFalsa(10, 2)
  await contar(e, '9', { fetchLevels: t.fetchLevels, hasAccess: conPlan })
  expect(ultima).toEqual({ success: true, revision: 1 })
  expect(await stock(e)).toBe('7')
  await enviar(t)
  expect([await stock(e), t.s.available]).toEqual(['7', 7])
})

it('ronda 2 (regresión): una pareja sin iniciar que NO creó el conector cuenta como siempre (no hay nada retenido que proteger)', async () => {
  const e = await escenario({ stock: 0, initialized: false })
  await contar(e, '8', { hasAccess: conPlan })
  expect(ultima).toEqual({ success: true, revision: 1 })
  expect(await stock(e)).toBe('8')
  expect(await deltas(e)).toEqual([])
})

it('N02 (ej. 1): un pedido entra y se jala ENTRE el refresco y la línea ⇒ la línea usa el espejo vigente: 7 y 7', async () => {
  // 10 piezas físicas, 1 apartada: A = espejo = 9. Un pedido ya está en Shopify (8 disponibles, 2 apartadas).
  const e = await escenario({ stock: 9, mirrorAvailable: 9, mirrorCommitted: 1 })
  const t = tiendaFalsa(8, 2)
  await refrescarEspejoParaConteo(e.venueId, [e.productId], { fetchLevels: t.fetchLevels, hasAccess: conPlan }) // A = espejo = 8
  expect(await stock(e)).toBe('8')
  t.s.available = 7 // otro pedido…
  t.s.committed = 3
  await jalar(e, t) // …y su aviso se procesa antes de la tx de la línea: A = espejo = 7, apartadas 3
  await contar(e, '10', { fetchLevels: jest.fn(async () => falla('HTTP_5XX', true, false)) as never, hasAccess: conPlan })
  expect(await stock(e)).toBe('7') // 10 − 3, no 10 − 2
  expect(await deltas(e)).toEqual([])
  await enviar(t)
  await jalar(e, t)
  expect([await stock(e), t.s.available]).toEqual(['7', 7])
  expect(await huecoDelInvariante(e.productId)).toBe('0')
})

it('N02 (ej. 1, aún sin jalar): el conteo deja 8 con el espejo de entonces y el siguiente jalón lo corrige: 7 y 7', async () => {
  const e = await escenario({ stock: 9, mirrorAvailable: 9, mirrorCommitted: 1 })
  const t = tiendaFalsa(8, 2)
  await refrescarEspejoParaConteo(e.venueId, [e.productId], { fetchLevels: t.fetchLevels, hasAccess: conPlan })
  t.s.available = 7 // el segundo pedido existe en Shopify pero su aviso todavía no llega
  t.s.committed = 3
  await contar(e, '10', { fetchLevels: jest.fn(async () => falla('HTTP_5XX', true, false)) as never, hasAccess: conPlan })
  expect(await stock(e)).toBe('8') // 10 − 2 apartadas que el espejo conocía
  expect(await deltas(e)).toEqual([])
  await jalar(e, t) // llega el aviso: disponible 7 − espejo 8 = −1
  await enviar(t)
  expect([await stock(e), t.s.available]).toEqual(['7', 7])
  expect(await huecoDelInvariante(e.productId)).toBe('0')
})

it('N02 (ej. 2, §12.1): con una venta local EN VUELO la línea no se aplica, ni se pregunta a Shopify; al recontar, 7 y 7', async () => {
  // 10 en el estante, 1 apartada: A = espejo = 9. Venta en caja (−1, A = 8) que el mensajero ya tomó.
  const e = await escenario({ stock: 9, mirrorAvailable: 9, mirrorCommitted: 1 })
  const enVuelo = await ventaEnVuelo(e)
  const t = tiendaFalsa(8, 2) // entra un pedido en línea: 9 − 1 = 8 disponibles, 2 apartadas (la venta aún no llega)
  const id = await contar(e, '9', { fetchLevels: t.fetchLevels, hasAccess: conPlan }) // 9 en el estante
  expect(t.fetchLevels).not.toHaveBeenCalled() // todo bloqueado ⇒ cero HTTP
  expect(await stock(e)).toBe('8') // el stock no cambió
  expect(await movimientosDeConteo(e)).toBe(0)
  expect(await deltas(e)).toEqual(['-1']) // sólo la venta en vuelo
  expect(ultima).toEqual({ success: true, revision: 1, noAplicados: [{ productId: e.productId, motivo: 'ENVIO_EN_CAMINO' }] })
  expect(await prisma.stockCountItem.findFirstOrThrow({ where: { stockCountId: id } })).toMatchObject({
    appliedAt: expect.any(Date), // sellada: un reintento no la aplica con un número viejo
    shopifyHeldAt: expect.any(Date),
    shopifyHeldReason: 'ENVIO_EN_CAMINO',
  })
  expect(await avisosDeConteo(e)).toBe(1)
  expect((await avisoDeConteo(e)).message).toContain(
    'el producto se estaba sincronizando con Shopify cuando confirmaste el conteo. Vuelve a contarlo cuando termine.',
  )
  // Llega la venta a Shopify y después el aviso del pedido; se vuelve a contar.
  expect(await runShopifyOutboxRow(enVuelo.id, enVuelo.claimToken, new Date(), { graphql: t.graphql as never, hasAccess: conPlan })).toBe(
    'SENT',
  )
  await jalar(e, t)
  await contar(e, '9', { fetchLevels: t.fetchLevels, hasAccess: conPlan })
  expect(ultima).toEqual({ success: true, revision: 1 })
  await enviar(t)
  expect([await stock(e), t.s.available]).toEqual(['7', 7])
  expect(await huecoDelInvariante(e.productId)).toBe('0')
})

it('R05 (§12.1): Shopify despacha las 2 apartadas durante la barrera ⇒ la línea no se aplica; tras el envío y recontar, 7 y 7', async () => {
  // Inicio: físico 10; A = espejo = Shopify = 8; 2 apartadas.
  const e = await escenario({ stock: 8, mirrorAvailable: 8, mirrorCommitted: 2 })
  const t = tiendaFalsa(8, 2)
  const enVuelo = await ventaEnVuelo(e) // físico 9; A = 7; espejo y Shopify siguen en 8
  t.s.committed = 0 // Shopify despacha las dos reservadas: físico 7; disponible sigue en 8
  await contar(e, '7', { fetchLevels: t.fetchLevels, hasAccess: conPlan }) // antes: 7 − 2 = 5 y dos piezas perdidas
  expect(t.fetchLevels).not.toHaveBeenCalled()
  expect(await stock(e)).toBe('7')
  expect(await deltas(e)).toEqual(['-1'])
  expect(ultima).toMatchObject({ noAplicados: [{ productId: e.productId, motivo: 'ENVIO_EN_CAMINO' }] })
  expect(await runShopifyOutboxRow(enVuelo.id, enVuelo.claimToken, new Date(), { graphql: t.graphql as never, hasAccess: conPlan })).toBe(
    'SENT',
  )
  await jalar(e, t) // apartadas 2 → 0, disponible sin cambio
  await contar(e, '7', { fetchLevels: t.fetchLevels, hasAccess: conPlan })
  await enviar(t)
  expect([await stock(e), t.s.available, t.s.committed]).toEqual(['7', 7, 0])
  expect((await espejo(e)).mirrorCommitted).toBe(0)
  expect(await huecoDelInvariante(e.productId)).toBe('0')
})

it('§12.1: bloqueado en el refresco y ya libre bajo candado ⇒ igual se retiene (su espejo no se puso al día)', async () => {
  const e = await escenario({ stock: 8, mirrorAvailable: 8, mirrorCommitted: 2 })
  const t = tiendaFalsa(8, 2)
  const enVuelo = await ventaEnVuelo(e)
  const refresco = await refrescarEspejoParaConteo(e.venueId, [e.productId], { fetchLevels: t.fetchLevels, hasAccess: conPlan })
  expect([...refresco.bloqueados]).toEqual([e.productId])
  expect(t.fetchLevels).not.toHaveBeenCalled()
  expect(await runShopifyOutboxRow(enVuelo.id, enVuelo.claimToken, new Date(), { graphql: t.graphql as never, hasAccess: conPlan })).toBe(
    'SENT',
  )
  // Bajo candado ya no hay nada en camino, pero el refresco no pudo leer: la línea se retiene.
  expect(await prisma.$transaction(tx => apartadasBajoCandado(tx, e.productId, refresco))).toBe(ENVIO_EN_CAMINO)
  // Con un refresco nuevo (ya libre) sí se aplica.
  const nuevo = await refrescarEspejoParaConteo(e.venueId, [e.productId], { fetchLevels: t.fetchLevels, hasAccess: conPlan })
  expect(nuevo.bloqueados.size).toBe(0)
  expect(await prisma.$transaction(tx => apartadasBajoCandado(tx, e.productId, nuevo))).toMatchObject({ apartadas: new Prisma.Decimal(2) })
})

it('§12.1: libre en el refresco y con un envío en camino bajo candado ⇒ también se retiene', async () => {
  const e = await escenario({ stock: 8, mirrorAvailable: 8, mirrorCommitted: 2 })
  const refresco = await refrescarEspejoParaConteo(e.venueId, [e.productId], {
    fetchLevels: tiendaFalsa(8, 2).fetchLevels,
    hasAccess: conPlan,
  })
  expect(refresco.bloqueados.size).toBe(0)
  await ventaEnVuelo(e) // el mensajero la toma entre el refresco y la línea
  expect(await prisma.$transaction(tx => apartadasBajoCandado(tx, e.productId, refresco))).toBe(ENVIO_EN_CAMINO)
})

it('T3: una fila en vuelo de una generación anterior no bloquea la línea', async () => {
  const e = await escenario({ mirrorCommitted: 2, generation: 2 })
  await prisma.shopifyStockOutbox.create({
    data: {
      venueId: e.venueId,
      locationLinkId: e.locationLinkId,
      generation: 1,
      productId: e.productId,
      delta: -1,
      status: 'IN_PROGRESS',
      claimToken: 'vieja',
      leaseUntil: new Date(Date.now() + 60_000),
    },
  })
  const t = tiendaFalsa(10, 2)
  await contar(e, '9', { fetchLevels: t.fetchLevels, hasAccess: conPlan })
  expect(t.fetchLevels).toHaveBeenCalledTimes(1)
  expect(ultima).toEqual({ success: true, revision: 1 })
  expect(await stock(e)).toBe('7')
})

it('R01: pausa → conteo → reanudar → enviar: con la sucursal en pausa se restan las apartadas del espejo; sin piezas fantasma', async () => {
  // 10 en el estante, 2 apartadas: A = espejo = 8. Se pausa, se encuentra UNA pieza más y se cuenta 11.
  const e = await escenario({ stock: 8, mirrorAvailable: 8, mirrorCommitted: 2, linkStatus: 'PAUSED', pausedFrom: 'ACTIVE' })
  const t = tiendaFalsa(8, 2)
  const id = await contar(e, '11', { fetchLevels: t.fetchLevels, hasAccess: conPlan })
  expect(t.fetchLevels).not.toHaveBeenCalled() // en pausa no se habla con Shopify
  expect(await stock(e)).toBe('9') // 11 − 2, nunca 11 − 0
  expect(await razon(e)).toBe(`Conteo de inventario #${id} (menos 2 apartadas según Shopify a las ${await horaDe(e)}; Shopify en pausa)`)
  const l = await prisma.shopifyLocationLink.findUniqueOrThrow({ where: { id: e.locationLinkId } })
  expect(await resumeShopifyLink(e.locationLinkId, { generation: l.generation }, { hasAccess: conPlan })).toBe('ACTIVE')
  await enviar(t)
  await jalar(e, t)
  expect([await stock(e), t.s.available, t.s.committed]).toEqual(['9', 9, 2]) // 9 + 2 = las 11 del estante
  expect(await huecoDelInvariante(e.productId)).toBe('0')
})

it('#10: el espejo decía 2 apartadas pero ya se surtieron (Shopify dice 0) ⇒ el refresco las quita y no resta nada', async () => {
  const e = await escenario({ mirrorCommitted: 2 })
  await contar(e, '9', { fetchLevels: nivelesFalsos(() => nivel(10, 0)), hasAccess: conPlan })
  expect(await stock(e)).toBe('9')
  expect((await espejo(e)).mirrorCommitted).toBe(0)
})

it('N26: cantidades con decimales se restan exactas (Decimal, no Number)', async () => {
  const e = await escenario({ mirrorCommitted: 2 })
  await contar(e, '9.125', { fetchLevels: nivelesFalsos(() => nivel(10, 2)), hasAccess: conPlan })
  expect(await stock(e)).toBe('7.125')
  expect(await deltas(e)).toEqual(['-2.875'])
})

it('N20 (§11.3): sin permiso, el primer conteo marca FALTA_PERMISO y el segundo ya no pregunta; los dos restan las del espejo', async () => {
  const e = await escenario({ mirrorCommitted: 1 })
  const sinPermiso = jest.fn(async () => falla('FORBIDDEN', false, false))
  await contar(e, '9', { fetchLevels: sinPermiso as never, hasAccess: conPlan })
  expect(await stock(e)).toBe('8')
  expect((await prisma.shopifyLocationLink.findUniqueOrThrow({ where: { id: e.locationLinkId } })).importError).toBe('FALTA_PERMISO')
  const id = await contar(e, '7', { fetchLevels: sinPermiso as never, hasAccess: conPlan })
  expect(sinPermiso).toHaveBeenCalledTimes(1) // mientras dure la marca, no se vuelve a llamar a Shopify
  expect(await stock(e)).toBe('6')
  expect(await razon(e)).toBe(
    `Conteo de inventario #${id} (menos 1 apartada según Shopify a las ${await horaDe(e)}; falta un permiso en Shopify)`,
  )
  expect(
    await prisma.notification.count({
      where: { venueId: e.venueId, entityType: 'ShopifyAviso', entityId: { startsWith: 'FALTA_PERMISO:' } },
    }),
  ).toBe(1)
})

it('12 bis.14: Shopify no contesta en su presupuesto ⇒ resta las del espejo y lo dice con la hora', async () => {
  const e = await escenario({ mirrorCommitted: 1 })
  await prisma.shopifyVariantLink.update({ where: { id: e.variantLinkId }, data: { committedAt: new Date('2026-10-08T16:05:00Z') } })
  const lento = jest.fn(async () => falla('TIMEOUT', true, true))
  await contar(e, '9', { fetchLevels: lento as never, esperaMs: 2_500, hasAccess: conPlan })
  const plazo = ((lento.mock.calls[0] as unknown[])[2] as { timeoutMs: number }).timeoutMs
  expect(plazo).toBeGreaterThan(2_000) // lo que queda de los 2.5 s; sin el mínimo de B1 (2 s) no se habría llamado
  expect(plazo).toBeLessThanOrEqual(2_500)
  expect(await stock(e)).toBe('8')
  expect(await razon(e)).toContain('menos 1 apartada según Shopify a las 10:05; Shopify no respondió')
})

it('sin plan (el escenario del guardia de A) ⇒ nada sale a la red y se restan las del espejo; sin pareja o sin apartadas, la razón de siempre', async () => {
  const sinPlan = await escenario({ mirrorCommitted: 2 })
  await contar(sinPlan, '8') // sin deps: acceso real (sin plan), como la prueba del guardia
  expect(await stock(sinPlan)).toBe('6') // 8 − 2 del espejo (R01: nunca cero)
  expect(await deltas(sinPlan)).toEqual(['-4'])

  const fetchLevels = nivelesFalsos(() => nivel(10, 0))
  const sinPareja = await escenario({ mirrorCommitted: 3 })
  await prisma.shopifyVariantLink.delete({ where: { id: sinPareja.variantLinkId } })
  await contar(sinPareja, '9', { fetchLevels, hasAccess: conPlan })
  expect(await stock(sinPareja)).toBe('9')
  expect(fetchLevels).not.toHaveBeenCalled()

  const normal = await escenario()
  const id = await contar(normal, '9', { fetchLevels, hasAccess: conPlan })
  expect(await razon(normal)).toBe(`Conteo de inventario #${id}`)
})

it('K12 (B-7): un token que no se puede descifrar no tumba el conteo: resta las del espejo y dice que Shopify no respondió', async () => {
  const e = await escenario({ mirrorCommitted: 2 })
  await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { accessTokenCiphertext: Buffer.from('cifrado-dañado') } })
  // Con el fetchLevels REAL de A, que lanza al no poder descifrar.
  const id = await contar(e, '9', { hasAccess: conPlan })
  expect(ultima).toEqual({ success: true, revision: 1 })
  expect(await stock(e)).toBe('7')
  expect(await razon(e)).toBe(
    `Conteo de inventario #${id} (menos 2 apartadas según Shopify a las ${await horaDe(e)}; Shopify no respondió)`,
  )
})

it('K12: un error pasajero de la base (P2028) al refrescar no tumba el conteo: usa el espejo', async () => {
  const e = await escenario({ mirrorCommitted: 2 })
  const fetchLevels = nivelesFalsos(() => nivel(10, 0))
  const hasAccess = async () => {
    throw Object.assign(new Error('Unable to start a transaction in the given time.'), { code: 'P2028' })
  }
  await contar(e, '9', { fetchLevels, hasAccess })
  expect(ultima).toEqual({ success: true, revision: 1 })
  expect(await stock(e)).toBe('7')
  expect(await razon(e)).toContain('; Shopify no respondió')
})

it('K18: las líneas retenidas quedan en la bitácora del conteo (STOCK_COUNT_CONFIRMED); sin retenidas, la bitácora de siempre', async () => {
  const e = await escenario({ stock: 9, mirrorAvailable: 9, mirrorCommitted: 1 })
  await ventaEnVuelo(e)
  ;(logAction as jest.Mock).mockClear()
  const id = await contar(e, '9', { fetchLevels: tiendaFalsa(8, 2).fetchLevels, hasAccess: conPlan })
  expect(logAction).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'STOCK_COUNT_CONFIRMED',
      entityId: id,
      data: expect.objectContaining({ adjustmentsCount: 0, noAplicados: [{ productId: e.productId, motivo: 'ENVIO_EN_CAMINO' }] }),
    }),
  )

  const libre = await escenario()
  ;(logAction as jest.Mock).mockClear()
  await contar(libre, '9', { fetchLevels: nivelesFalsos(() => nivel(10, 0)), hasAccess: conPlan })
  const confirmado = (logAction as jest.Mock).mock.calls.find(c => c[0].action === 'STOCK_COUNT_CONFIRMED')![0]
  expect(confirmado.data).not.toHaveProperty('noAplicados')
})

it('Fix 1: una línea retenida sigue en noAplicados y en la bitácora después de un reintento (sin otro aviso)', async () => {
  const e = await escenario({ stock: 9, mirrorAvailable: 9, mirrorCommitted: 1 })
  const otro = await agregarProductoShopify(e) // libre, 10 en Avoqado y en el espejo
  await ventaEnVuelo(e)
  const c = await prisma.stockCount.create({
    data: {
      venueId: e.venueId,
      type: 'CYCLE',
      status: 'IN_PROGRESS',
      createdById: e.staffId,
      items: {
        create: [
          { productId: e.productId, expected: new Prisma.Decimal(9), counted: new Prisma.Decimal(9), countedAt: new Date() },
          { productId: otro.productId, expected: new Prisma.Decimal(10), counted: new Prisma.Decimal(9), countedAt: new Date() },
        ],
      },
    },
  })
  const deps = { fetchLevels: jest.fn(async () => falla('HTTP_5XX', true, false)) as never, hasAccess: conPlan }
  // 1.ª tx: el claim del conteo · 2.ª: la línea retenida · 3.ª: la del otro producto, que truena una vez.
  const real = prisma.$transaction.bind(prisma) as (...a: unknown[]) => unknown
  let n = 0
  const tx = jest
    .spyOn(prisma, '$transaction')
    .mockImplementation(((...a: unknown[]) => (++n === 3 ? Promise.reject(new Error('la segunda línea truena')) : real(...a))) as never)
  await expect(confirmStockCount(c.id, e.venueId, e.staffId, 0, deps)).rejects.toThrow('la segunda línea truena')
  tx.mockRestore()
  const items = await prisma.stockCountItem.findMany({ where: { stockCountId: c.id }, take: 2 })
  expect(items.find(i => i.productId === e.productId)).toMatchObject({ appliedAt: expect.any(Date), shopifyHeldReason: 'ENVIO_EN_CAMINO' })
  expect(items.find(i => i.productId === otro.productId)).toMatchObject({ appliedAt: null })

  const avisar = jest.spyOn(avisos, 'notifyShopify')
  ;(logAction as jest.Mock).mockClear()
  const r = await confirmStockCount(c.id, e.venueId, e.staffId, 0, deps)
  const noAplicados = [{ productId: e.productId, motivo: 'ENVIO_EN_CAMINO' }]
  expect(r).toEqual({ success: true, revision: 1, noAplicados })
  expect(logAction).toHaveBeenCalledWith(
    expect.objectContaining({ action: 'STOCK_COUNT_CONFIRMED', data: expect.objectContaining({ adjustmentsCount: 1, noAplicados }) }),
  )
  expect(avisar).not.toHaveBeenCalled() // el aviso salió en el primer intento
  avisar.mockRestore()
  expect((await prisma.inventory.findUniqueOrThrow({ where: { id: otro.inventoryId } })).currentStock.toString()).toBe('9')
  expect(await stock(e)).toBe('8')
})

it('Fix 2: una duda muerta (DEAD_LETTER ambigua) retiene la línea con DUDA_POR_REVISAR y el aviso manda a «Por revisar»', async () => {
  const e = await escenario({ mirrorCommitted: 1 })
  await prisma.shopifyStockOutbox.create({
    data: {
      venueId: e.venueId,
      locationLinkId: e.locationLinkId,
      generation: 1,
      productId: e.productId,
      delta: -1,
      status: 'DEAD_LETTER',
      ambiguous: true,
      lastError: 'prueba',
    },
  })
  const t = tiendaFalsa(10, 1)
  const id = await contar(e, '9', { fetchLevels: t.fetchLevels, hasAccess: conPlan })
  expect(t.fetchLevels).not.toHaveBeenCalled()
  expect(await stock(e)).toBe('10')
  expect(ultima).toEqual({ success: true, revision: 1, noAplicados: [{ productId: e.productId, motivo: 'DUDA_POR_REVISAR' }] })
  expect(await prisma.stockCountItem.findFirstOrThrow({ where: { stockCountId: id } })).toMatchObject({
    shopifyHeldAt: expect.any(Date),
    shopifyHeldReason: 'DUDA_POR_REVISAR',
  })
  const aviso = await avisoDeConteo(e)
  expect(aviso.entityId).toContain(`:${e.productId}:DUDA_POR_REVISAR:`)
  expect(aviso.message).toBe(
    'El conteo de Camisa · M no se aplicó: Shopify tiene una revisión pendiente de este producto. Resuélvela en Integraciones → Shopify → Por revisar y después vuelve a contarlo.',
  )
  expect(aviso.message).not.toContain('unos minutos')
})

it('Fix 2: un envío en camino con una revisión abierta del producto también es DUDA_POR_REVISAR', async () => {
  const e = await escenario({ stock: 9, mirrorAvailable: 9, mirrorCommitted: 1 })
  await ventaEnVuelo(e)
  await prisma.shopifyReviewItem.create({
    data: {
      venueId: e.venueId,
      productId: e.productId,
      reason: 'INCIERTO',
      avoqadoQty: new Prisma.Decimal(8),
      shopifyQty: 9,
      suggestion: 'SHOPIFY',
    },
  })
  await contar(e, '9', { fetchLevels: tiendaFalsa(8, 1).fetchLevels, hasAccess: conPlan })
  expect(ultima).toMatchObject({ noAplicados: [{ productId: e.productId, motivo: 'DUDA_POR_REVISAR' }] })
})

it('Minor 1 (§12.8): sin tiempo para aplicar lo leído, la línea usa el espejo y lo dice', async () => {
  const e = await escenario({ mirrorCommitted: 2 })
  const rapida = nivelesFalsos(() => nivel(10, 0))
  const lenta = jest.fn(async (store: unknown, items: unknown) => {
    await dormir(1_800) // de 2.5 s quedan ~0.7: menos que una escritura
    return rapida(store as never, items as never)
  })
  await contar(e, '9', { fetchLevels: lenta as never, esperaMs: 2_500, hasAccess: conPlan })
  expect(lenta).toHaveBeenCalledTimes(1)
  expect(await stock(e)).toBe('7') // 9 − 2 del espejo: lo leído (0 apartadas) no alcanzó a aplicarse
  expect((await espejo(e)).mirrorCommitted).toBe(2)
  expect(await razon(e)).toContain('; Shopify tardó en responder')
})

it('Minor 6: un error pasajero de la base al leer las parejas de la tanda no tumba el conteo: usa el espejo', async () => {
  const e = await escenario({ mirrorCommitted: 2 })
  const fetchLevels = nivelesFalsos(() => nivel(10, 0))
  const lectura = jest
    .spyOn(prisma.shopifyVariantLink, 'findMany')
    .mockRejectedValueOnce(Object.assign(new Error('Timed out fetching a new connection from the connection pool.'), { code: 'P2024' }))
  await contar(e, '9', { fetchLevels, hasAccess: conPlan })
  lectura.mockRestore()
  expect(ultima).toEqual({ success: true, revision: 1 })
  expect(fetchLevels).not.toHaveBeenCalled()
  expect(await stock(e)).toBe('7')
  expect(await razon(e)).toContain('menos 2 apartadas según Shopify a las')
  expect(await razon(e)).toContain('; Shopify no respondió')
})

it('Minor 8: contado menor que lo apartado ⇒ objetivo negativo (sobreventa real); al enviar, los dos lados en −2 y SOBREVENTA', async () => {
  // 3 piezas en el estante pero 5 apartadas en línea: faltan 2 para surtir. Avoqado no inventa piezas ni las esconde.
  const e = await escenario({ mirrorCommitted: 5 })
  const t = tiendaFalsa(10, 5)
  await contar(e, '3', { fetchLevels: t.fetchLevels, hasAccess: conPlan })
  expect(await stock(e)).toBe('-2')
  expect(await deltas(e)).toEqual(['-12'])
  const sobreventas = () =>
    prisma.notification.count({ where: { venueId: e.venueId, entityType: 'ShopifyAviso', entityId: { startsWith: 'SOBREVENTA:' } } })
  expect(await sobreventas()).toBe(0) // el conteo no avisa; avisa el mensajero cuando Shopify ya lo tiene
  await enviar(t)
  expect([await stock(e), t.s.available]).toEqual(['-2', -2])
  expect(await sobreventas()).toBe(1)
  expect(await huecoDelInvariante(e.productId)).toBe('0')
})

it('N22: más de 200 productos van en tandas de 200 (dos lecturas) y todos se aplican', async () => {
  const e = await escenario()
  const ids = [e.productId]
  for (let i = 0; i < 200; i++) ids.push((await agregarProductoShopify(e)).productId)
  const c = await prisma.stockCount.create({
    data: {
      venueId: e.venueId,
      type: 'CYCLE',
      status: 'IN_PROGRESS',
      createdById: e.staffId,
      items: {
        create: ids.map(productId => ({
          productId,
          expected: new Prisma.Decimal(10),
          counted: new Prisma.Decimal(10),
          countedAt: new Date(),
        })),
      },
    },
  })
  const fetchLevels = nivelesFalsos(() => nivel(10, 1))
  expect(await confirmStockCount(c.id, e.venueId, e.staffId, 0, { fetchLevels, hasAccess: conPlan, esperaMs: 120_000 })).toEqual({
    success: true,
    revision: 1,
  })
  expect(fetchLevels.mock.calls.map(x => x[1].length).sort((a, b) => a - b)).toEqual([1, 200])
  expect(await prisma.inventory.count({ where: { venueId: e.venueId, currentStock: 9 } })).toBe(201) // 10 − 1 apartada
})

/** La hora local (CDMX) del `committedAt` del espejo, o de `mirrorAt` si no hay, como la escribe el conteo. */
async function horaDe(e: EscenarioShopify): Promise<string> {
  const p = await espejo(e)
  return new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Mexico_City' }).format(
    p.committedAt ?? p.mirrorAt,
  )
}
