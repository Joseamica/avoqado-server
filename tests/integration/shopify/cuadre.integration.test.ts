// tests/integration/shopify/cuadre.integration.test.ts
/**
 * La vuelta del cuadre (B4): barre el catálogo (recupera webhooks perdidos y archiva lo que ya no existe), aplica lo que
 * Shopify cambió, abre «Por revisar» para lo que nadie explica revalidando bajo candado, deja pendiente la tanda con un
 * envío en vuelo, no se da por buena con una duda viva y no se come un pedido que llega a media vuelta. Postgres real;
 * Shopify por deps.
 */
import { Prisma } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import emailService from '@/services/email.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { marcarOrigenShopify, type NivelLeido } from '@/services/commerce-channels/shopify/shopify.mirror.service'
import { notifyShopify } from '@/services/commerce-channels/shopify/shopify.notify.service'
import { MIN_HTTP_MS, pedirCuadre, TOKEN_ILEGIBLE } from '@/services/commerce-channels/shopify/shopify.store.service'
import {
  ARCHIVADO_POR_SHOPIFY,
  archivarPareja,
  upsertShopifyVariant,
  type VarianteShopify,
} from '@/services/commerce-channels/shopify/shopify.catalog.service'
import {
  avisarRetrasoDeSucursal,
  notifyShopifyReview,
  reconcileVenue,
  seguirAvisosPendientes,
} from '@/services/commerce-channels/shopify/shopify.reconcile.service'
import {
  agregarProductoShopify,
  assertTestDatabase,
  crearEscenarioShopify,
  EscenarioShopify,
  graphqlFalso,
  huecoDelInvariante,
  limpiarEscenarioShopify,
} from './fixtures'
import { conPlan, dormir, falla, graphqlDelCatalogo, nivel, nivelesFalsos, variante, variantesDeLaSucursal } from './fixturesB'

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
  jest.restoreAllMocks()
})

/** Pide una vuelta y la corre entera, unidad por unidad, con el catálogo de Shopify igual al de las parejas de hoy. */
async function vuelta(e: EscenarioShopify, n: (item: string) => NivelLeido, extra: { graphql?: jest.Mock; fetchLevels?: never } = {}) {
  await pedirCuadre(e.locationLinkId)
  const deps = {
    fetchLevels: extra.fetchLevels ?? nivelesFalsos(n),
    graphql: extra.graphql ?? graphqlDelCatalogo(await variantesDeLaSucursal(e.locationLinkId)),
    hasAccess: conPlan,
  }
  let aplicados = 0
  for (let i = 0; i < 40; i++) {
    const r = await reconcileVenue(e.venueId, deps)
    aplicados += r.aplicados
    if (r.terminado) return { aplicados, porRevisar: r.porRevisar, deps }
  }
  throw new Error('la vuelta no terminó')
}
const stock = async (e: EscenarioShopify) =>
  (await prisma.inventory.findUniqueOrThrow({ where: { id: e.inventoryId } })).currentStock.toString()
const pareja = (e: EscenarioShopify) => prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })
const sucursal = (e: EscenarioShopify) => prisma.shopifyLocationLink.findUniqueOrThrow({ where: { id: e.locationLinkId } })
const abiertas = (e: EscenarioShopify) => prisma.shopifyReviewItem.findMany({ where: { venueId: e.venueId, status: 'OPEN' }, take: 10 })
const venta = (inventoryId: string, n = 1) =>
  prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - ${n} WHERE id = ${inventoryId}`
const fijarSinGuardia = (e: EscenarioShopify, valor: number) =>
  prisma.$transaction(async tx => {
    await marcarOrigenShopify(tx)
    await tx.inventory.update({ where: { id: e.inventoryId }, data: { currentStock: new Prisma.Decimal(valor) } })
  })
const avisos = (e: EscenarioShopify, aviso: string) =>
  prisma.notification.count({ where: { venueId: e.venueId, entityType: 'ShopifyAviso', entityId: { startsWith: `${aviso}:` } } })
/** Corre unidades (barrido y bajas) hasta que la vuelta llega a la etapa de stock, sin entrar a ella. */
async function hastaElStock(e: EscenarioShopify, deps: Parameters<typeof reconcileVenue>[1]) {
  await pedirCuadre(e.locationLinkId)
  for (let i = 0; i < 10; i++) {
    const l = await sucursal(e)
    if (l.catalogSweepCursor === null && l.reconcileCursor !== null) return
    await reconcileVenue(e.venueId, deps)
  }
  throw new Error('la vuelta no llegó al stock')
}

describe('stock', () => {
  it('Shopify cambió y no nos enteramos ⇒ se aplica; la vuelta cierra con su hora, su versión y la bandera abajo', async () => {
    const e = await escenario()
    expect(await vuelta(e, () => nivel(8))).toMatchObject({ aplicados: 1, porRevisar: 0 })
    expect(await stock(e)).toBe('8')
    const l = await sucursal(e)
    expect(l).toMatchObject({ needsReconcile: false, reconcileCursor: null, catalogSweepCursor: null })
    expect(l.reconcileDoneVersion).toBe(l.reconcileVersion)
    expect(l.lastReconciledAt).toBeInstanceOf(Date)
    expect(await huecoDelInvariante(e.productId)).toBe('0')
  })

  it('una venta de caja todavía sin mandar cuadra (Avoqado = espejo + pendientes): nada por revisar', async () => {
    const e = await escenario()
    await venta(e.inventoryId)
    expect(await vuelta(e, () => nivel(10))).toMatchObject({ aplicados: 0, porRevisar: 0 })
    expect(await huecoDelInvariante(e.productId)).toBe('0')
  })

  it('Avoqado no cuadra y nadie lo explica ⇒ DIFERENCIA con su offset, sin pisar nada; otra vuelta no la duplica (§9.3)', async () => {
    const e = await escenario()
    await fijarSinGuardia(e, 13)
    expect(await vuelta(e, () => nivel(10))).toMatchObject({ aplicados: 0, porRevisar: 1 })
    const r = await abiertas(e)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ reason: 'DIFERENCIA', shopifyQty: 10, suggestion: 'SHOPIFY' })
    expect([r[0].avoqadoQty.toString(), r[0].offset.toString()]).toEqual(['13', '3'])
    expect(await huecoDelInvariante(e.productId)).toBe('0') // 13 = 10 + 0 + 0 + 3
    // Shopify vende una: se aplica en los dos lados y la MISMA revisión sigue explicando la diferencia.
    expect(await vuelta(e, () => nivel(9))).toMatchObject({ aplicados: 1, porRevisar: 1 })
    expect(await stock(e)).toBe('12')
    expect((await abiertas(e)).map(x => x.offset.toString())).toEqual(['3'])
    expect(await huecoDelInvariante(e.productId)).toBe('0') // 12 = 9 + 0 + 0 + 3
  })

  it('N17 (§12.8): sin tiempo después de leer los niveles, la tanda no escribe nada ni avanza; la siguiente la repite y aplica', async () => {
    const e = await escenario()
    await pedirCuadre(e.locationLinkId)
    const deps = {
      graphql: graphqlDelCatalogo(await variantesDeLaSucursal(e.locationLinkId)),
      hasAccess: conPlan,
      fetchLevels: nivelesFalsos(() => nivel(8)),
    }
    // Barrido y bajas, sin prisa, hasta llegar a la tanda de stock.
    for (let i = 0; i < 10; i++) {
      const l = await sucursal(e)
      if (l.catalogSweepCursor === null && l.reconcileCursor !== null) break
      await reconcileVenue(e.venueId, deps)
    }
    expect((await sucursal(e)).reconcileCursor).toBe('')
    const lento = jest.fn(async (s: unknown, items: Array<{ inventoryItemId: string; shopifyLocationId: string }>) => {
      await dormir(2_000)
      return nivelesFalsos(() => nivel(8))(s as never, items)
    })
    // La lectura arranca con ~2.5 s y vuelve con ~0.5 s: menos que MIN_ESCRITURA_MS.
    const r = await reconcileVenue(e.venueId, { ...deps, fetchLevels: lento as never, vence: Date.now() + MIN_HTTP_MS + 500 })
    expect(lento).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ error: 'SIN_TIEMPO', aplicados: 0, terminado: false, etapa: 'STOCK' })
    expect(await stock(e)).toBe('10')
    expect((await sucursal(e)).reconcileCursor).toBe('')
    let fin = await reconcileVenue(e.venueId, deps)
    for (let i = 0; i < 5 && !fin.terminado; i++) fin = await reconcileVenue(e.venueId, deps)
    expect(fin.terminado).toBe(true)
    expect(await stock(e)).toBe('8')
    expect(await huecoDelInvariante(e.productId)).toBe('0')
  })

  it('sólo cambiaron las apartadas ⇒ el espejo de apartadas se pone al día (#10)', async () => {
    const e = await escenario()
    expect(await vuelta(e, () => nivel(10, 3))).toMatchObject({ aplicados: 0, porRevisar: 0 })
    expect((await pareja(e)).mirrorCommitted).toBe(3)
  })

  it('DEAD_LETTER ⇒ ATORADO que sugiere Avoqado; DEAD_LETTER ambiguo ⇒ INCIERTO, sin aplicar nada', async () => {
    const e = await escenario()
    await venta(e.inventoryId, 2)
    await prisma.shopifyStockOutbox.updateMany({
      where: { productId: e.productId },
      data: { status: 'DEAD_LETTER', processedAt: new Date() },
    })
    await vuelta(e, () => nivel(10))
    expect((await abiertas(e))[0]).toMatchObject({ reason: 'ATORADO', atorados: 1, shopifyQty: 10, suggestion: 'AVOQADO' })
    expect(await huecoDelInvariante(e.productId)).toBe('0') // 8 = 10 + (−2 atorado) + 0

    const e2 = await escenario()
    await venta(e2.inventoryId)
    await prisma.shopifyStockOutbox.updateMany({
      where: { productId: e2.productId },
      data: { status: 'DEAD_LETTER', ambiguous: true, processedAt: new Date() },
    })
    await vuelta(e2, () => nivel(9)) // sí llegó: Shopify ya tiene 9
    expect((await abiertas(e2))[0]).toMatchObject({ reason: 'INCIERTO', shopifyQty: 9, suggestion: 'SHOPIFY' })
    expect(await stock(e2)).toBe('9')
    expect((await pareja(e2)).mirrorAvailable).toBe(10)
    expect(await huecoDelInvariante(e2.productId)).toBe('0') // 9 = 10 + (−1 incierto) + 0
  })

  it('N14: una fila VIVA y ambigua no aplica nada ni abre DIFERENCIA, y la vuelta NO se da por buena: se repite más tarde', async () => {
    const e = await escenario()
    await venta(e.inventoryId)
    await prisma.shopifyStockOutbox.updateMany({
      where: { productId: e.productId },
      data: { status: 'FAILED', ambiguous: true, attempts: 1 },
    })
    await pedirCuadre(e.locationLinkId)
    const deps = {
      fetchLevels: nivelesFalsos(() => nivel(9)),
      graphql: graphqlDelCatalogo(await variantesDeLaSucursal(e.locationLinkId)),
      hasAccess: conPlan,
    }
    const rs = []
    for (let i = 0; i < 3; i++) rs.push(await reconcileVenue(e.venueId, deps))
    expect(rs.map(r => r.etapa)).toEqual(['BARRIDO', 'BAJAS', 'STOCK'])
    expect(rs[2]).toMatchObject({ terminado: false, esperaMs: 600_000 })
    const l = await sucursal(e)
    expect(l.lastReconciledAt).toBeNull()
    expect(l.reconcileDoneVersion).toBeLessThan(l.reconcileVersion)
    expect(await stock(e)).toBe('9') // sin el candado contaría doble: 8
    expect((await pareja(e)).mirrorAvailable).toBe(10)
    expect(await abiertas(e)).toHaveLength(0)
  })

  it('N14: un envío EN VUELO deja la tanda pendiente (el cursor no avanza); cuando el envío llega, la vuelta sigue y cierra', async () => {
    const e = await escenario()
    await venta(e.inventoryId)
    await prisma.shopifyStockOutbox.updateMany({
      where: { productId: e.productId },
      data: { status: 'IN_PROGRESS', claimToken: 'm', leaseUntil: new Date(Date.now() + 60_000) },
    })
    await pedirCuadre(e.locationLinkId)
    const deps = {
      fetchLevels: nivelesFalsos(() => nivel(8)),
      graphql: graphqlDelCatalogo(await variantesDeLaSucursal(e.locationLinkId)),
      hasAccess: conPlan,
    }
    await reconcileVenue(e.venueId, deps) // barrido
    await reconcileVenue(e.venueId, deps) // bajas
    expect(await reconcileVenue(e.venueId, deps)).toMatchObject({ etapa: 'STOCK', terminado: false, esperaMs: 60_000 })
    expect((await sucursal(e)).reconcileCursor).toBe('')
    expect(await stock(e)).toBe('9')
    // El mensajero confirma el envío: la fila queda SENT y el espejo baja a 9.
    await prisma.shopifyStockOutbox.updateMany({
      where: { productId: e.productId },
      data: { status: 'SENT', processedAt: new Date(), claimToken: null },
    })
    await prisma.shopifyVariantLink.update({ where: { id: e.variantLinkId }, data: { mirrorAvailable: 9 } })
    expect(await reconcileVenue(e.venueId, deps)).toMatchObject({ etapa: 'STOCK', terminado: true, aplicados: 1 })
    expect(await stock(e)).toBe('8')
    expect(await huecoDelInvariante(e.productId)).toBe('0')
  })

  it('N14: sin nivel con un envío EN VUELO, la suspensión espera: la tanda no avanza ni cierra; al llegar el envío, se suspende y cierra', async () => {
    const e = await escenario()
    await venta(e.inventoryId)
    await prisma.shopifyStockOutbox.updateMany({
      where: { productId: e.productId },
      data: { status: 'IN_PROGRESS', claimToken: 'm', leaseUntil: new Date(Date.now() + 60_000) },
    })
    await pedirCuadre(e.locationLinkId)
    const deps = {
      fetchLevels: nivelesFalsos(() => ({ kind: 'SIN_NIVEL' })),
      graphql: graphqlDelCatalogo(await variantesDeLaSucursal(e.locationLinkId)),
      hasAccess: conPlan,
    }
    await reconcileVenue(e.venueId, deps) // barrido
    await reconcileVenue(e.venueId, deps) // bajas
    expect(await reconcileVenue(e.venueId, deps)).toMatchObject({ etapa: 'STOCK', terminado: false, esperaMs: 60_000 })
    const l = await sucursal(e)
    expect(l.reconcileCursor).toBe('')
    expect(l.reconcileDoneVersion).toBeLessThan(l.reconcileVersion)
    expect((await pareja(e)).suspendedReason).toBeNull()
    // El mensajero confirma el envío; la siguiente unidad ya puede suspender (nunca cero) y la vuelta cierra.
    await prisma.shopifyStockOutbox.updateMany({
      where: { productId: e.productId },
      data: { status: 'SENT', processedAt: new Date(), claimToken: null },
    })
    await prisma.shopifyVariantLink.update({ where: { id: e.variantLinkId }, data: { mirrorAvailable: 9 } })
    expect(await reconcileVenue(e.venueId, deps)).toMatchObject({ etapa: 'STOCK', terminado: true })
    expect((await pareja(e)).suspendedReason).toBe('NIVEL_INEXISTENTE')
    expect(await stock(e)).toBe('9')
  })

  it('N15: la foto vio un atorado, pero el dueño lo resolvió antes del candado ⇒ no se abre otra revisión', async () => {
    const e = await escenario()
    await venta(e.inventoryId, 2)
    await prisma.shopifyStockOutbox.updateMany({
      where: { productId: e.productId },
      data: { status: 'DEAD_LETTER', processedAt: new Date() },
    })
    await prisma.shopifyReviewItem.create({
      data: {
        venueId: e.venueId,
        productId: e.productId,
        reason: 'ATORADO',
        avoqadoQty: 8,
        shopifyQty: 10,
        atorados: 1,
        suggestion: 'AVOQADO',
      },
    })
    // Mientras se lee Shopify (después de la foto), el dueño elige «usar Shopify»: descarta la fila y deja A = espejo.
    const fetchLevels = jest.fn(async (_s: unknown, items: Array<{ inventoryItemId: string; shopifyLocationId: string }>) => {
      await prisma.shopifyStockOutbox.updateMany({
        where: { productId: e.productId, status: 'DEAD_LETTER' },
        data: { status: 'DISCARDED' },
      })
      await fijarSinGuardia(e, 10)
      await prisma.shopifyReviewItem.updateMany({
        where: { productId: e.productId, status: 'OPEN' },
        data: { status: 'RESOLVED', resolvedAt: new Date(), offset: 0 },
      })
      return nivelesFalsos(() => nivel(10))(_s as never, items)
    })
    expect(await vuelta(e, () => nivel(10), { fetchLevels: fetchLevels as never })).toMatchObject({ porRevisar: 0 })
    expect(await abiertas(e)).toHaveLength(0)
    expect(await huecoDelInvariante(e.productId)).toBe('0')
  })

  it('N14: un pedido de cuadre que llega a media vuelta no se pierde: esa vuelta no se marca hecha y empieza otra', async () => {
    const e = await escenario()
    await pedirCuadre(e.locationLinkId)
    const deps = {
      fetchLevels: nivelesFalsos(() => nivel(10)),
      graphql: graphqlDelCatalogo(await variantesDeLaSucursal(e.locationLinkId)),
      hasAccess: conPlan,
    }
    await reconcileVenue(e.venueId, deps) // barrido de la vuelta 1
    await pedirCuadre(e.locationLinkId) // C pide otro cuadre
    const rs = []
    for (let i = 0; i < 10; i++) {
      const r = await reconcileVenue(e.venueId, deps)
      rs.push(r)
      if (r.terminado) break
    }
    expect(rs.filter(r => r.terminado)).toHaveLength(1)
    const l = await sucursal(e)
    expect(l.catalogSweepId).toBe(2) // dos vueltas
    expect(l.needsReconcile).toBe(false)
    expect(l.reconcileDoneVersion).toBe(l.reconcileVersion)
  })

  it('una pareja suspendida con nivel e Inventory se reactiva COMPARANDO: REACTIVADA con su offset; otra vuelta no abre DIFERENCIA encima', async () => {
    const e = await escenario()
    await prisma.shopifyVariantLink.update({
      where: { id: e.variantLinkId },
      data: { suspendedReason: 'NIVEL_INEXISTENTE', suspendedAt: new Date() },
    })
    await vuelta(e, () => nivel(12))
    expect((await pareja(e)).suspendedReason).toBeNull()
    const [reactivada] = await abiertas(e)
    expect(reactivada).toMatchObject({ reason: 'REACTIVADA', shopifyQty: 12 })
    expect(reactivada.offset.toString()).toBe('-2') // A6, §9.3: Inventory − S
    expect(await stock(e)).toBe('10')
    expect(await huecoDelInvariante(e.productId)).toBe('0')
    expect(await vuelta(e, () => nivel(12))).toMatchObject({ aplicados: 0, porRevisar: 1 })
    expect((await abiertas(e)).map(x => x.reason)).toEqual(['REACTIVADA'])
  })

  it('sin nivel en la ubicación ⇒ pareja suspendida y stock intacto (nunca cero)', async () => {
    const e = await escenario()
    await vuelta(e, () => ({ kind: 'SIN_NIVEL' }))
    expect((await pareja(e)).suspendedReason).toBe('NIVEL_INEXISTENTE')
    expect(await stock(e)).toBe('10')
    expect(await prisma.shopifyImportIssue.findFirst({ where: { venueId: e.venueId } })).toMatchObject({ reason: 'NIVEL_INEXISTENTE' })
  })

  it('una pareja sin iniciar en ACTIVE la inicia el cuadre: TOMAR_SHOPIFY si el producto lo creó el conector', async () => {
    const e = await escenario()
    const p = await agregarProductoShopify(e, { stock: 0, initialized: false, createdProduct: true })
    await vuelta(e, item => (item === 'gid://shopify/InventoryItem/1' ? nivel(10) : nivel(5)))
    expect((await prisma.inventory.findUniqueOrThrow({ where: { id: p.inventoryId } })).currentStock.toString()).toBe('5')
    expect((await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: p.variantLinkId! } })).initializedAt).not.toBeNull()
  })

  it('va por tandas de 50 con cursor y lastReconciledAt sólo al cerrar', async () => {
    const e = await escenario()
    for (let i = 0; i < 119; i++) await agregarProductoShopify(e)
    await pedirCuadre(e.locationLinkId)
    const fetchLevels = nivelesFalsos(() => nivel(10))
    const deps = { fetchLevels, graphql: graphqlDelCatalogo(await variantesDeLaSucursal(e.locationLinkId)), hasAccess: conPlan }
    let terminado = false
    for (let i = 0; i < 20 && !terminado; i++) {
      terminado = (await reconcileVenue(e.venueId, deps)).terminado
      if (!terminado) expect((await sucursal(e)).lastReconciledAt).toBeNull()
    }
    expect(terminado).toBe(true)
    expect(fetchLevels.mock.calls.map(c => c[1].length)).toEqual([50, 50, 20])
    expect(deps.graphql).toHaveBeenCalledTimes(3) // 120 variantes en 3 páginas del barrido
  })

  it('una sucursal que no está ACTIVE ⇒ omitido, sin tocar nada', async () => {
    const e = await escenario({ linkStatus: 'PAUSED', pausedFrom: 'ACTIVE' })
    const fetchLevels = nivelesFalsos()
    expect(await reconcileVenue(e.venueId, { fetchLevels, hasAccess: conPlan })).toMatchObject({ omitido: true, terminado: false })
    expect(fetchLevels).not.toHaveBeenCalled()
  })

  it('SIN_PRECIO desaparece cuando el producto ya tiene precio; una revisión que ya cuadra se cierra sola con offset 0', async () => {
    const e = await escenario()
    await prisma.shopifyImportIssue.create({
      data: {
        venueId: e.venueId,
        shopifyVariantId: 'gid://shopify/ProductVariant/1',
        shopifyProductId: 'gid://shopify/Product/1',
        title: 'Camisa · M',
        reason: 'SIN_PRECIO',
        productId: e.productId,
      },
    })
    const r = await prisma.shopifyReviewItem.create({
      data: {
        venueId: e.venueId,
        productId: e.productId,
        reason: 'DIFERENCIA',
        avoqadoQty: 13,
        shopifyQty: 10,
        offset: 3,
        suggestion: 'SHOPIFY',
      },
    })
    await vuelta(e, () => nivel(10))
    expect(await prisma.shopifyImportIssue.count({ where: { venueId: e.venueId, reason: 'SIN_PRECIO' } })).toBe(0)
    const cerrada = await prisma.shopifyReviewItem.findUniqueOrThrow({ where: { id: r.id } })
    expect([cerrada.status, cerrada.offset.toString()]).toEqual(['RESOLVED', '0'])
  })

  it('N20: falta un permiso al leer los niveles ⇒ FALTA_PERMISO en la sucursal y el cuadre ya no la toca', async () => {
    const e = await escenario()
    await pedirCuadre(e.locationLinkId)
    const deps = {
      fetchLevels: jest.fn(async () => falla('FORBIDDEN', false, false)) as never,
      graphql: graphqlDelCatalogo(await variantesDeLaSucursal(e.locationLinkId)),
      hasAccess: conPlan,
    }
    let ultimo
    for (let i = 0; i < 4; i++) ultimo = await reconcileVenue(e.venueId, deps)
    expect((await sucursal(e)).importError).toBe('FALTA_PERMISO')
    expect(ultimo).toMatchObject({ omitido: true, error: 'FALTA_PERMISO' })
  })
})

describe('barrido de catálogo (§10.10, N21)', () => {
  it('trae una variante cuyo webhook se perdió (pareja nueva, iniciada en la misma vuelta) y archiva la que ya no existe', async () => {
    const e = await escenario()
    const vieja = await agregarProductoShopify(e)
    const parejaVieja = await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: vieja.variantLinkId! } })
    const catalogo = (await variantesDeLaSucursal(e.locationLinkId)).filter(v => v.id !== parejaVieja.shopifyVariantId)
    catalogo.push(variante(301, { sku: 'PERDIDA-1', producto: 'gid://shopify/Product/301' }))
    expect(await vuelta(e, () => nivel(10), { graphql: graphqlDelCatalogo(catalogo) })).toMatchObject({ porRevisar: 0 })
    const nueva = await prisma.product.findUniqueOrThrow({
      where: { venueId_sku: { venueId: e.venueId, sku: 'PERDIDA-1' } },
      include: { inventory: true, shopifyVariantLink: true },
    })
    expect(nueva.shopifyVariantLink).toMatchObject({ createdProduct: true })
    expect(nueva.shopifyVariantLink!.initializedAt).not.toBeNull()
    expect(nueva.inventory!.currentStock.toString()).toBe('10')
    expect(await prisma.product.findUniqueOrThrow({ where: { id: vieja.productId } })).toMatchObject({
      deletedBy: ARCHIVADO_POR_SHOPIFY,
      active: false,
    })
    expect(await prisma.shopifyVariantLink.count({ where: { id: vieja.variantLinkId! } })).toBe(0)
    expect((await pareja(e)).lastSeenSweepId).toBe((await sucursal(e)).catalogSweepId)
  })

  it('N17 (§12.8, ronda 4): con cada variante lenta, el barrido avanza DENTRO de la página por vueltas, no repite lo hecho y llega al stock', async () => {
    const e = await escenario()
    for (let i = 0; i < 20; i++) await agregarProductoShopify(e) // 21 variantes: una sola página que no cabe en una vuelta
    await pedirCuadre(e.locationLinkId)
    const hechas: string[] = []
    const lento = async (ctx: Parameters<typeof upsertShopifyVariant>[0], v: VarianteShopify) => {
      hechas.push(v.id)
      await dormir(200) // la misma latencia en cada vuelta
      return upsertShopifyVariant(ctx, v)
    }
    const deps = {
      graphql: graphqlDelCatalogo(await variantesDeLaSucursal(e.locationLinkId)),
      fetchLevels: nivelesFalsos(() => nivel(10)),
      hasAccess: conPlan,
      upsert: lento,
    }
    let vueltas = 0
    for (; vueltas < 10; vueltas++) {
      const l = await sucursal(e)
      if (l.catalogSweepCursor === null && l.reconcileCursor !== null) break
      await reconcileVenue(e.venueId, { ...deps, vence: Date.now() + MIN_HTTP_MS + 600 }) // ~8 variantes por vuelta
    }
    expect(vueltas).toBeGreaterThan(2) // la página no cupo en una vuelta…
    expect((await sucursal(e)).reconcileCursor).toBe('') // …y aun así el barrido terminó y pasó al stock
    expect(hechas).toHaveLength(21)
    expect(new Set(hechas).size).toBe(21) // ninguna se repitió
    expect(await prisma.shopifyVariantLink.count({ where: { locationLinkId: e.locationLinkId } })).toBe(21) // ninguna baja de más
  })

  it('si una página del barrido falla 5 veces, esa vuelta abandona el barrido SIN archivar nada y sigue con el stock', async () => {
    const e = await escenario()
    const vieja = await agregarProductoShopify(e)
    await pedirCuadre(e.locationLinkId)
    const deps = {
      fetchLevels: nivelesFalsos(() => nivel(10)),
      graphql: graphqlFalso(() => falla('HTTP_5XX', true, true)),
      hasAccess: conPlan,
    }
    const rs = []
    for (let i = 0; i < 10; i++) {
      const r = await reconcileVenue(e.venueId, deps)
      rs.push(r)
      if (r.terminado) break
    }
    expect(rs.slice(0, 5).every(r => r.etapa === 'BARRIDO' && r.error === 'HTTP_5XX')).toBe(true)
    expect(rs[rs.length - 1]).toMatchObject({ terminado: true })
    expect(await prisma.shopifyVariantLink.count({ where: { id: vieja.variantLinkId! } })).toBe(1)
    expect(await prisma.product.findUniqueOrThrow({ where: { id: vieja.productId } })).toMatchObject({ deletedAt: null })
  })
})

describe('avisos (N22)', () => {
  it('RETRASO por sucursal: avisa por una fila viva de más de 15 min; no por una de 5 ni con la sucursal en pausa', async () => {
    const viejo = new Date(Date.now() - 20 * 60_000)
    const a = await escenario()
    await venta(a.inventoryId)
    await prisma.shopifyStockOutbox.updateMany({ where: { productId: a.productId }, data: { createdAt: viejo } })
    const b = await escenario()
    await venta(b.inventoryId)
    await prisma.shopifyStockOutbox.updateMany({
      where: { productId: b.productId },
      data: { createdAt: new Date(Date.now() - 5 * 60_000) },
    })
    const c = await escenario({ linkStatus: 'PAUSED', pausedFrom: 'ACTIVE' })
    await venta(c.inventoryId)
    await prisma.shopifyStockOutbox.updateMany({ where: { productId: c.productId }, data: { createdAt: viejo } })
    const ahora = new Date()
    expect([
      await avisarRetrasoDeSucursal(a.locationLinkId, ahora),
      await avisarRetrasoDeSucursal(b.locationLinkId, ahora),
      await avisarRetrasoDeSucursal(c.locationLinkId, ahora),
    ]).toEqual([true, false, false])
    expect([await avisos(a, 'RETRASO'), await avisos(b, 'RETRASO'), await avisos(c, 'RETRASO')]).toEqual([1, 0, 0])
  })

  it('POR_REVISAR: campanita y un correo por persona con la llave del día, recorriendo TODOS los destinatarios por cursor; con 0 no hace nada', async () => {
    const e = await escenario()
    await prisma.shopifyReviewItem.create({
      data: { venueId: e.venueId, productId: e.productId, reason: 'DIFERENCIA', avoqadoQty: 13, shopifyQty: 10, suggestion: 'SHOPIFY' },
    })
    const extra = Array.from({ length: 55 }, (_, i) => ({
      email: `extra-${i}-${e.venueId}@example.test`,
      firstName: 'Extra',
      lastName: String(i),
    }))
    await prisma.staff.createMany({ data: extra })
    const creados = await prisma.staff.findMany({ where: { email: { in: extra.map(x => x.email) } }, select: { id: true }, take: 55 })
    await prisma.staffVenue.createMany({
      data: creados.map(s => ({ staffId: s.id, venueId: e.venueId, role: 'ADMIN' as const, active: true })),
    })
    const correo = jest.spyOn(emailService, 'sendShopifyPorRevisarEmail').mockResolvedValue(true)
    await notifyShopifyReview(e.venueId, 0)
    expect(correo).not.toHaveBeenCalled()
    await notifyShopifyReview(e.venueId, 1)
    expect(correo).toHaveBeenCalledTimes(56) // el del escenario y los 55: ninguno se queda fuera por un tope
    const staff = await prisma.staff.findUniqueOrThrow({ where: { id: e.staffId } })
    expect(correo).toHaveBeenCalledWith(
      staff.email,
      expect.objectContaining({
        total: 1,
        items: [{ name: 'Camisa · M', avoqado: '13', shopify: 10, motivo: 'No cuadra' }],
        idempotencyKey: expect.stringMatching(new RegExp(`^shopify-por-revisar:${e.venueId}:\\d{4}-\\d{2}-\\d{2}:`)),
      }),
    )
    await prisma.staffVenue.deleteMany({ where: { staffId: { in: creados.map(s => s.id) } } })
    await prisma.staff.deleteMany({ where: { id: { in: creados.map(s => s.id) } } })
  })

  it('N17 (§12.8): un correo que no contesta no detiene la fase: se espera a lo más lo que queda y ese destinatario sigue después con la MISMA llave', async () => {
    const e = await escenario()
    await prisma.shopifyReviewItem.create({
      data: { venueId: e.venueId, productId: e.productId, reason: 'DIFERENCIA', avoqadoQty: 13, shopifyQty: 10, suggestion: 'SHOPIFY' },
    })
    const correo = jest
      .spyOn(emailService, 'sendShopifyPorRevisarEmail')
      .mockImplementationOnce(() => new Promise<boolean>(() => undefined)) // el proveedor nunca contesta
      .mockResolvedValue(true)
    const t0 = Date.now()
    expect(await notifyShopifyReview(e.venueId, 1, { vence: Date.now() + MIN_HTTP_MS + 1_000 })).toBe(false)
    expect(Date.now() - t0).toBeLessThan(MIN_HTTP_MS + 2_000) // no se quedó esperando al proveedor
    expect(correo).toHaveBeenCalledTimes(1)
    await seguirAvisosPendientes(Date.now() + 60_000)
    expect(correo).toHaveBeenCalledTimes(2)
    expect(correo.mock.calls[1][1].idempotencyKey).toBe(correo.mock.calls[0][1].idempotencyKey) // el proveedor no lo duplica
    await seguirAvisosPendientes(Date.now() + 60_000)
    expect(correo).toHaveBeenCalledTimes(2)
  })

  it('N17 (§11.6): los correos respetan el vencimiento y la fase de avisos sigue donde se quedaron, sin repetir a nadie', async () => {
    const e = await escenario()
    await prisma.shopifyReviewItem.create({
      data: { venueId: e.venueId, productId: e.productId, reason: 'DIFERENCIA', avoqadoQty: 13, shopifyQty: 10, suggestion: 'SHOPIFY' },
    })
    const extra = Array.from({ length: 55 }, (_, i) => ({
      email: `lento-${i}-${e.venueId}@example.test`,
      firstName: 'Lento',
      lastName: String(i),
    }))
    await prisma.staff.createMany({ data: extra })
    const creados = await prisma.staff.findMany({ where: { email: { in: extra.map(x => x.email) } }, select: { id: true }, take: 55 })
    await prisma.staffVenue.createMany({
      data: creados.map(s => ({ staffId: s.id, venueId: e.venueId, role: 'ADMIN' as const, active: true })),
    })
    const correo = jest.spyOn(emailService, 'sendShopifyPorRevisarEmail').mockImplementation(async () => {
      await dormir(20)
      return true
    })
    // La campanita de hoy ya salió (otra vuelta): la deduplicada es barata y el plazo queda para los correos. Mandar la
    // primera a 56 personas tarda más que los 200 ms de margen de esta prueba.
    await notifyShopify(e.venueId, 'POR_REVISAR', { count: 1 })
    expect(await notifyShopifyReview(e.venueId, 1, { vence: Date.now() + MIN_HTTP_MS + 200 })).toBe(false)
    const primeros = correo.mock.calls.length
    expect(primeros).toBeGreaterThan(0)
    expect(primeros).toBeLessThan(56)
    await seguirAvisosPendientes(Date.now() + 60_000)
    expect(correo).toHaveBeenCalledTimes(56)
    expect(new Set(correo.mock.calls.map(c => c[0])).size).toBe(56)
    await seguirAvisosPendientes(Date.now() + 60_000) // ya no queda nada pendiente
    expect(correo).toHaveBeenCalledTimes(56)
    await prisma.staffVenue.deleteMany({ where: { staffId: { in: creados.map(s => s.id) } } })
    await prisma.staff.deleteMany({ where: { id: { in: creados.map(s => s.id) } } })
  })
})

describe('decisiones vinculantes de B4 (T1, K17, R3, T2, B-7, R5, K22, bitácora)', () => {
  beforeEach(() => (logAction as jest.Mock).mockClear())

  it('T1: un pedido que sólo sube reconcileVersion (como renovarCredencial) empieza una vuelta, y si llega a media vuelta no se pierde', async () => {
    const e = await escenario()
    const deps = {
      fetchLevels: nivelesFalsos(() => nivel(10)),
      graphql: graphqlDelCatalogo(await variantesDeLaSucursal(e.locationLinkId)),
      hasAccess: conPlan,
    }
    const versionMas = () =>
      prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { reconcileVersion: { increment: 1 } } })
    await versionMas() // sin needsReconcile: con la versión basta para pedir
    expect(await reconcileVenue(e.venueId, deps)).toMatchObject({ etapa: 'BARRIDO' })
    await versionMas() // renovarCredencial a media vuelta (connect.service: sólo reconcileVersion++)
    const rs = []
    for (let i = 0; i < 10; i++) {
      const r = await reconcileVenue(e.venueId, deps)
      rs.push(r)
      if (r.terminado) break
    }
    expect(rs.filter(r => r.terminado)).toHaveLength(1)
    const l = await sucursal(e)
    expect(l.catalogSweepId).toBe(2) // la primera vuelta no se dio por buena: hubo otra
    expect(l.needsReconcile).toBe(false)
    expect(l.reconcileDoneVersion).toBe(l.reconcileVersion)
  })

  it('K17: si la sucursal se pausa mientras se lee Shopify, A contesta PAUSADO y la unidad se detiene sin abrir «Por revisar»', async () => {
    const e = await escenario()
    await fijarSinGuardia(e, 13)
    const deps = {
      fetchLevels: nivelesFalsos(() => nivel(11)),
      graphql: graphqlDelCatalogo(await variantesDeLaSucursal(e.locationLinkId)),
      hasAccess: conPlan,
    }
    await hastaElStock(e, deps)
    const pausa = jest.fn(async (s: unknown, items: Array<{ inventoryItemId: string; shopifyLocationId: string }>) => {
      await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { status: 'PAUSED', pausedFrom: 'ACTIVE' } })
      return nivelesFalsos(() => nivel(11))(s as never, items)
    })
    const r = await reconcileVenue(e.venueId, { ...deps, fetchLevels: pausa as never })
    expect(pausa).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ etapa: 'STOCK', terminado: false, error: 'CONTEXTO_CAMBIO', porRevisar: 0 })
    expect(await abiertas(e)).toHaveLength(0)
    expect(await stock(e)).toBe('13')
    expect((await sucursal(e)).reconcileCursor).toBe('')
  })

  it('§9.7: sin plan, una diferencia que no pasa por A tampoco abre «Por revisar»: la unidad se detiene', async () => {
    const e = await escenario()
    await fijarSinGuardia(e, 13)
    const deps = {
      fetchLevels: nivelesFalsos(() => nivel(10)), // igual al espejo: no se llama a A
      graphql: graphqlDelCatalogo(await variantesDeLaSucursal(e.locationLinkId)),
      hasAccess: conPlan,
    }
    await hastaElStock(e, deps)
    const r = await reconcileVenue(e.venueId, { ...deps, hasAccess: async () => false })
    expect(r).toMatchObject({ etapa: 'STOCK', terminado: false, error: 'CONTEXTO_CAMBIO', porRevisar: 0 })
    expect(await abiertas(e)).toHaveLength(0)
    expect((await sucursal(e)).reconcileCursor).toBe('')
  })

  it('R3: el plan se pregunta UNA vez por unidad, por muchas variantes y parejas que toque', async () => {
    const e = await escenario()
    for (let i = 0; i < 3; i++) await agregarProductoShopify(e)
    await pedirCuadre(e.locationLinkId)
    const hasAccess = jest.fn(conPlan)
    const deps = {
      fetchLevels: nivelesFalsos(() => nivel(8)),
      graphql: graphqlDelCatalogo(await variantesDeLaSucursal(e.locationLinkId)),
      hasAccess,
    }
    const porUnidad: number[] = []
    let terminado = false
    for (let i = 0; i < 10 && !terminado; i++) {
      const antes = hasAccess.mock.calls.length
      const r = await reconcileVenue(e.venueId, deps)
      porUnidad.push(hasAccess.mock.calls.length - antes)
      terminado = r.terminado
    }
    expect(terminado).toBe(true)
    expect(Math.max(...porUnidad)).toBe(1) // barrido de 4 variantes y tanda de 4 parejas que se aplican: una pregunta cada una
    expect(await stock(e)).toBe('8')
  })

  it('T2: el catálogo maestro ENFORCED durante el barrido no deja ningún error terminal en la sucursal: esa vuelta sigue sin barrido y no archiva nada', async () => {
    const e = await escenario()
    const vieja = await agregarProductoShopify(e)
    const parejaVieja = await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: vieja.variantLinkId! } })
    // Sin la vieja en el catálogo: si se llegara a las bajas, se archivaría.
    const catalogo = (await variantesDeLaSucursal(e.locationLinkId)).filter(v => v.id !== parejaVieja.shopifyVariantId)
    const gobierno = jest.fn(async () => {
      throw Object.assign(new Error('El catálogo lo administra el catálogo maestro'), { code: 'CATALOG_GOVERNANCE_REQUIRED' })
    })
    await pedirCuadre(e.locationLinkId)
    const deps = {
      fetchLevels: nivelesFalsos(() => nivel(10)),
      graphql: graphqlDelCatalogo(catalogo),
      hasAccess: conPlan,
      upsert: gobierno as never,
    }
    const rs = []
    for (let i = 0; i < 10; i++) {
      const r = await reconcileVenue(e.venueId, deps)
      rs.push(r)
      if (r.terminado) break
    }
    expect(rs[0]).toMatchObject({ etapa: 'BARRIDO', error: 'CATALOGO_MAESTRO' })
    expect(rs[rs.length - 1]).toMatchObject({ terminado: true })
    expect((await sucursal(e)).importError).toBeNull() // nada que el reclamo ni la renovación tengan que limpiar
    expect(await prisma.shopifyVariantLink.count({ where: { id: vieja.variantLinkId! } })).toBe(1)
    expect(await prisma.product.findUniqueOrThrow({ where: { id: vieja.productId } })).toMatchObject({ deletedAt: null })
  })

  it('B-7: un token que no se puede descifrar no tumba la unidad: ni el barrido ni la lectura de niveles lanzan', async () => {
    const e = await escenario()
    await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { accessTokenCiphertext: Buffer.from('cifrado-dañado') } })
    await pedirCuadre(e.locationLinkId)
    const graphql = graphqlDelCatalogo(await variantesDeLaSucursal(e.locationLinkId))
    expect(await reconcileVenue(e.venueId, { graphql, hasAccess: conPlan })).toMatchObject({
      etapa: 'BARRIDO',
      error: TOKEN_ILEGIBLE,
      terminado: false,
    })
    expect(graphql).not.toHaveBeenCalled()
    // Ya en el stock, con el fetchLevels REAL de A (lanza al descifrar): sale como falla reintentable, sin escribir nada.
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { catalogSweepCursor: null, reconcileCursor: '' } })
    expect(await reconcileVenue(e.venueId, { hasAccess: conPlan })).toMatchObject({ etapa: 'STOCK', terminado: false, error: 'NETWORK' })
    expect(await stock(e)).toBe('10')
    expect((await sucursal(e)).reconcileCursor).toBe('')
  })

  it('R5: la pareja que el conector archivó con un envío en camino se borra en la vuelta en cuanto el envío cierra; antes, se queda suspendida', async () => {
    const e = await escenario()
    await venta(e.inventoryId)
    await prisma.shopifyStockOutbox.updateMany({
      where: { productId: e.productId },
      data: { status: 'IN_PROGRESS', claimToken: 'm', leaseUntil: new Date(Date.now() + 60_000) },
    })
    const l0 = await prisma.shopifyLocationLink.findUniqueOrThrow({ where: { id: e.locationLinkId }, include: { store: true } })
    const p0 = await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })
    const cerco = {
      generation: l0.generation,
      storeId: l0.storeId,
      shopifyLocationId: l0.shopifyLocationId,
      tokenVersion: l0.store.tokenVersion,
    }
    expect(await archivarPareja(p0, cerco)).toBe('SUSPENDIDA')
    expect(await pareja(e)).toMatchObject({ suspendedReason: 'NIVEL_INEXISTENTE' })
    // Sin barrido (falla 5 veces): sólo la tanda de stock puede reintentar el archivo. Con el envío vivo, sigue suspendida.
    const deps = {
      fetchLevels: nivelesFalsos(() => nivel(10)),
      graphql: graphqlFalso(() => falla('HTTP_5XX', true, true)),
      hasAccess: conPlan,
    }
    const correr = async () => {
      await pedirCuadre(e.locationLinkId)
      for (let i = 0; i < 10; i++) if ((await reconcileVenue(e.venueId, deps)).terminado) return
      throw new Error('la vuelta no terminó')
    }
    await correr()
    expect(await prisma.shopifyVariantLink.count({ where: { id: e.variantLinkId } })).toBe(1)
    // El mensajero confirma el envío: la siguiente vuelta ya puede borrar la pareja; el producto sigue archivado.
    await prisma.shopifyStockOutbox.updateMany({
      where: { productId: e.productId },
      data: { status: 'SENT', processedAt: new Date(), claimToken: null },
    })
    await correr()
    expect(await prisma.shopifyVariantLink.count({ where: { id: e.variantLinkId } })).toBe(0)
    expect(await prisma.product.findUniqueOrThrow({ where: { id: e.productId } })).toMatchObject({ deletedBy: ARCHIVADO_POR_SHOPIFY })
  })

  it('bitácora: abrir «Por revisar» y cerrarla sola dejan ActivityLog con el negocio y la organización', async () => {
    const e = await escenario()
    await fijarSinGuardia(e, 13)
    await vuelta(e, () => nivel(10))
    const [r] = await abiertas(e)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SHOPIFY_REVIEW_OPENED',
        venueId: e.venueId,
        organizationId: e.organizationId,
        entity: 'ShopifyReviewItem',
        entityId: r.id,
      }),
    )
    // Avoqado vuelve a cuadrar con Shopify (sin pasar por el guardia): la revisión se cierra sola y también deja rastro.
    await fijarSinGuardia(e, 10)
    await vuelta(e, () => nivel(10))
    expect(await abiertas(e)).toHaveLength(0)
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SHOPIFY_REVIEW_CLOSED',
        venueId: e.venueId,
        organizationId: e.organizationId,
        entityId: r.id,
      }),
    )
  })

  it('K22: la llave del correo lleva el día del NEGOCIO, no el de UTC', async () => {
    const e = await escenario()
    // Una zona donde el día local nunca es el de UTC en este momento: −12 h por la mañana UTC, +14 h por la tarde.
    const tz = new Date().getUTCHours() < 12 ? 'Etc/GMT+12' : 'Pacific/Kiritimati'
    await prisma.venue.update({ where: { id: e.venueId }, data: { timezone: tz } })
    await prisma.shopifyReviewItem.create({
      data: { venueId: e.venueId, productId: e.productId, reason: 'DIFERENCIA', avoqadoQty: 13, shopifyQty: 10, suggestion: 'SHOPIFY' },
    })
    const correo = jest.spyOn(emailService, 'sendShopifyPorRevisarEmail').mockResolvedValue(true)
    await notifyShopifyReview(e.venueId, 1)
    const llave = correo.mock.calls[0][1].idempotencyKey as string
    const dia = formatInTimeZone(new Date(), tz, 'yyyy-MM-dd')
    expect(dia).not.toBe(new Date().toISOString().slice(0, 10))
    expect(llave.startsWith(`shopify-por-revisar:${e.venueId}:${dia}:`)).toBe(true)
  })
})
