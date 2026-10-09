// tests/integration/shopify/resolucion.integration.test.ts
/**
 * Resolver «Por revisar» (B5): todo en UNA transacción con candados en orden, números revalidados contra lo que se vio,
 * lo guardado y lo vigente, acceso revalidado al escribir, nunca un cero por un nivel ausente, una sola resolución aunque
 * lleguen dos clics, y la sobreventa avisada. Postgres real.
 */
import { Prisma, type ShopifyReviewReason } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { marcarOrigenShopify, suspendPair, type NivelLeido } from '@/services/commerce-channels/shopify/shopify.mirror.service'
import { claimShopifyOutbox } from '@/services/commerce-channels/shopify/shopify.outbox.service'
import { pedirCuadre } from '@/services/commerce-channels/shopify/shopify.store.service'
import { reconcileVenue, resolveShopifyReview } from '@/services/commerce-channels/shopify/shopify.reconcile.service'
import { assertTestDatabase, crearEscenarioShopify, EscenarioShopify, huecoDelInvariante, limpiarEscenarioShopify } from './fixtures'
import { conPlan, falla, graphqlDelCatalogo, nivel, nivelesFalsos, variantesDeLaSucursal } from './fixturesB'

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

/** Deja Avoqado en `A` sin pasar por el guardia y abre la revisión con los números que vería el dueño. */
async function abrir(e: EscenarioShopify, A: string, reason: ShopifyReviewReason = 'DIFERENCIA', S = 10) {
  await prisma.$transaction(async tx => {
    await marcarOrigenShopify(tx)
    await tx.inventory.update({ where: { id: e.inventoryId }, data: { currentStock: new Prisma.Decimal(A) } })
  })
  return prisma.shopifyReviewItem.create({
    data: {
      venueId: e.venueId,
      productId: e.productId,
      reason,
      avoqadoQty: new Prisma.Decimal(A),
      shopifyQty: S,
      offset: new Prisma.Decimal(A).minus(10),
      suggestion: 'SHOPIFY',
    },
  })
}
const entrada = (
  e: EscenarioShopify,
  r: { id: string; avoqadoQty: Prisma.Decimal; shopifyQty: number },
  choice: 'AVOQADO' | 'SHOPIFY',
) => ({
  venueId: e.venueId,
  reviewId: r.id,
  choice,
  expectedAvoqadoQty: r.avoqadoQty.toString(),
  expectedShopifyQty: r.shopifyQty,
  staffId: e.staffId,
})
const deps = (n: NivelLeido = nivel(10)) => ({ fetchLevels: nivelesFalsos(() => n), hasAccess: conPlan })
const stock = async (e: EscenarioShopify) =>
  (await prisma.inventory.findUniqueOrThrow({ where: { id: e.inventoryId } })).currentStock.toString()
const revision = (id: string) => prisma.shopifyReviewItem.findUniqueOrThrow({ where: { id } })
const pareja = (e: EscenarioShopify) => prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: e.variantLinkId } })
const avisos = (e: EscenarioShopify, aviso: string) =>
  prisma.notification.count({ where: { venueId: e.venueId, entityType: 'ShopifyAviso', entityId: { startsWith: `${aviso}:` } } })
const venta = (inventoryId: string, n = 1) =>
  prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - ${n} WHERE id = ${inventoryId}`
/** Una vuelta entera del cuadre (B4) con Shopify en `n` y su catálogo igual al de las parejas de hoy. */
async function cuadrar(e: EscenarioShopify, n: NivelLeido) {
  await pedirCuadre(e.locationLinkId)
  const d = {
    fetchLevels: nivelesFalsos(() => n),
    graphql: graphqlDelCatalogo(await variantesDeLaSucursal(e.locationLinkId)),
    hasAccess: conPlan,
  }
  for (let i = 0; i < 10; i++) if ((await reconcileVenue(e.venueId, d)).terminado) return
  throw new Error('la vuelta no terminó')
}

it('«usar Shopify»: Avoqado = S con su movimiento, espejo = S, atorados descartados, offset 0, sin fila nueva', async () => {
  const e = await escenario()
  const r = await abrir(e, '13')
  await prisma.shopifyStockOutbox.create({
    data: { venueId: e.venueId, locationLinkId: e.locationLinkId, generation: 1, productId: e.productId, delta: 3, status: 'DEAD_LETTER' },
  })
  expect(await resolveShopifyReview(entrada(e, r, 'SHOPIFY'), deps())).toEqual({ estado: 'RESUELTO' })
  expect(await stock(e)).toBe('10')
  expect(await prisma.inventoryMovement.findFirst({ where: { inventoryId: e.inventoryId }, orderBy: { createdAt: 'desc' } })).toMatchObject(
    {
      type: 'ADJUSTMENT',
      createdBy: e.staffId,
    },
  )
  expect((await pareja(e)).mirrorAvailable).toBe(10)
  expect(await prisma.shopifyStockOutbox.findMany({ where: { productId: e.productId }, select: { status: true }, take: 5 })).toEqual([
    { status: 'DISCARDED' },
  ])
  const res = await revision(r.id)
  expect(res).toMatchObject({ status: 'RESOLVED', choice: 'SHOPIFY', resolvedById: e.staffId, resolutionOutboxId: null })
  expect(res.offset.toString()).toBe('0')
  expect(await huecoDelInvariante(e.productId)).toBe('0') // 10 = 10 + 0 + 0
})

it('«usar Avoqado» con diferencia entera: fila NUEVA con A − S, espejo = S, ENVIO_PENDIENTE; el invariante se cumple y la fila sale', async () => {
  const e = await escenario()
  const r = await abrir(e, '13')
  expect(await resolveShopifyReview(entrada(e, r, 'AVOQADO'), deps())).toEqual({ estado: 'ENVIO_PENDIENTE' })
  const res = await revision(r.id)
  expect(res).toMatchObject({ status: 'RESOLVED', choice: 'AVOQADO' })
  const fila = await prisma.shopifyStockOutbox.findUniqueOrThrow({ where: { id: res.resolutionOutboxId! } })
  expect(fila).toMatchObject({ status: 'PENDING', generation: 1, locationLinkId: e.locationLinkId })
  expect(fila.delta.toString()).toBe('3')
  expect((await pareja(e)).mirrorAvailable).toBe(10)
  expect(await stock(e)).toBe('13')
  expect(await huecoDelInvariante(e.productId)).toBe('0') // 13 = 10 + 3 (la fila nueva) + 0
  const c = await claimShopifyOutbox(new Date())
  expect(c).toMatchObject({ kind: 'FILA', id: fila.id })
})

it('«usar Avoqado» con una diferencia que no es de piezas enteras ⇒ 422 y la revisión sigue abierta', async () => {
  const e = await escenario()
  const r = await abrir(e, '12.5')
  await expect(resolveShopifyReview(entrada(e, r, 'AVOQADO'), deps())).rejects.toMatchObject({
    statusCode: 422,
    code: 'SHOPIFY_DIFERENCIA_NO_ENTERA',
  })
  expect((await revision(r.id)).status).toBe('OPEN')
  expect(await prisma.shopifyStockOutbox.count({ where: { productId: e.productId } })).toBe(0)
})

it('Shopify cambió desde que se vio ⇒ 409 SHOPIFY_REVISION_CAMBIO y la revisión ya muestra los nuevos', async () => {
  const e = await escenario()
  const r = await abrir(e, '13')
  await expect(resolveShopifyReview(entrada(e, r, 'SHOPIFY'), deps(nivel(11)))).rejects.toMatchObject({
    statusCode: 409,
    code: 'SHOPIFY_REVISION_CAMBIO',
  })
  const ahora = await revision(r.id)
  expect(ahora).toMatchObject({ status: 'OPEN', shopifyQty: 11 })
  expect(ahora.avoqadoQty.toString()).toBe('13')
  expect(await stock(e)).toBe('13')
})

it('lo que vio el dueño ya no es lo guardado (la revisión se puso al día después de pintarse) ⇒ 409 y se reescribe con lo vigente', async () => {
  const e = await escenario()
  const r = await abrir(e, '13')
  await prisma.shopifyReviewItem.update({ where: { id: r.id }, data: { avoqadoQty: new Prisma.Decimal(12) } })
  await expect(resolveShopifyReview(entrada(e, r, 'SHOPIFY'), deps())).rejects.toMatchObject({
    statusCode: 409,
    code: 'SHOPIFY_REVISION_CAMBIO',
  })
  const ahora = await revision(r.id)
  expect(ahora.avoqadoQty.toString()).toBe('13') // lo vigente bajo candado
  expect(await stock(e)).toBe('13')
})

it('con cambios viajando a Shopify ⇒ 409 SHOPIFY_CAMBIOS_EN_CAMINO', async () => {
  const e = await escenario()
  const r = await abrir(e, '13')
  await venta(e.inventoryId) // una venta encolada
  await expect(resolveShopifyReview(entrada(e, r, 'SHOPIFY'), deps())).rejects.toMatchObject({
    statusCode: 409,
    code: 'SHOPIFY_CAMBIOS_EN_CAMINO',
  })
})

it('RF3: dos clics a la vez en «usar Shopify» ⇒ uno resuelve, el otro 409, y el ajuste se hace UNA vez', async () => {
  const e = await escenario()
  const r = await abrir(e, '13')
  const movimientosAntes = await prisma.inventoryMovement.count({ where: { inventoryId: e.inventoryId } })
  const resultados = await Promise.allSettled([
    resolveShopifyReview(entrada(e, r, 'SHOPIFY'), deps()),
    resolveShopifyReview(entrada(e, r, 'SHOPIFY'), deps()),
  ])
  expect(resultados.filter(x => x.status === 'fulfilled')).toHaveLength(1)
  const fallo = resultados.find(x => x.status === 'rejected') as PromiseRejectedResult
  expect(fallo.reason).toMatchObject({ statusCode: 409, code: 'SHOPIFY_REVISION_YA_RESUELTA' })
  expect(await prisma.inventoryMovement.count({ where: { inventoryId: e.inventoryId } })).toBe(movimientosAntes + 1)
  expect(await stock(e)).toBe('10')
})

it('RF3 (N16): el plan vence mientras se lee Shopify ⇒ 403 SHOPIFY_SIN_PLAN dentro de la transacción y nada cambia', async () => {
  const e = await escenario()
  const r = await abrir(e, '13')
  let llamadas = 0
  const hasAccess = async () => ++llamadas === 1 // sí antes del HTTP, no al escribir
  await expect(
    resolveShopifyReview(entrada(e, r, 'SHOPIFY'), { fetchLevels: nivelesFalsos(() => nivel(10)), hasAccess }),
  ).rejects.toMatchObject({
    statusCode: 403,
    code: 'SHOPIFY_SIN_PLAN',
  })
  expect(llamadas).toBe(2)
  expect(await stock(e)).toBe('13')
  expect((await revision(r.id)).status).toBe('OPEN')
})

it('Shopify sin nivel en la ubicación ⇒ 409 SHOPIFY_SIN_NIVEL; nunca se resuelve a cero', async () => {
  const e = await escenario()
  const r = await abrir(e, '13')
  await expect(resolveShopifyReview(entrada(e, r, 'SHOPIFY'), deps({ kind: 'SIN_NIVEL' }))).rejects.toMatchObject({
    statusCode: 409,
    code: 'SHOPIFY_SIN_NIVEL',
  })
  expect(await stock(e)).toBe('13')
})

it('sin plan ⇒ 403 SHOPIFY_SIN_PLAN; una revisión de otra sucursal ⇒ 404', async () => {
  const e = await escenario()
  const r = await abrir(e, '13')
  await expect(resolveShopifyReview(entrada(e, r, 'SHOPIFY'), { ...deps(), hasAccess: async () => false })).rejects.toMatchObject({
    statusCode: 403,
    code: 'SHOPIFY_SIN_PLAN',
  })
  const otra = await escenario()
  await expect(resolveShopifyReview({ ...entrada(e, r, 'SHOPIFY'), venueId: otra.venueId }, deps())).rejects.toMatchObject({
    statusCode: 404,
    code: 'SHOPIFY_REVISION_NO_EXISTE',
  })
})

it('N20: falta un permiso al leer ⇒ 403 SHOPIFY_FALTA_PERMISO y la sucursal queda marcada; después ⇒ 409 EN_PAUSA sin preguntar', async () => {
  const e = await escenario()
  const r = await abrir(e, '13')
  const sinPermiso = { fetchLevels: jest.fn(async () => falla('FORBIDDEN', false, false)) as never, hasAccess: conPlan }
  await expect(resolveShopifyReview(entrada(e, r, 'SHOPIFY'), sinPermiso)).rejects.toMatchObject({
    statusCode: 403,
    code: 'SHOPIFY_FALTA_PERMISO',
  })
  expect((await prisma.shopifyLocationLink.findUniqueOrThrow({ where: { id: e.locationLinkId } })).importError).toBe('FALTA_PERMISO')
  const otra = deps()
  await expect(resolveShopifyReview(entrada(e, r, 'SHOPIFY'), otra)).rejects.toMatchObject({ statusCode: 409, code: 'SHOPIFY_EN_PAUSA' })
  expect(otra.fetchLevels).not.toHaveBeenCalled()
  expect(await stock(e)).toBe('13')
  expect((await revision(r.id)).status).toBe('OPEN')
})

it('§12.2: la tienda se revoca entre la lectura de Shopify y la transacción ⇒ 409 SHOPIFY_EN_PAUSA y nada cambia', async () => {
  const e = await escenario()
  const r = await abrir(e, '13')
  const fetchLevels = jest.fn(async (s: unknown, items: Array<{ inventoryItemId: string; shopifyLocationId: string }>) => {
    await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { status: 'REVOKED', revokedAt: new Date() } })
    return nivelesFalsos(() => nivel(10))(s as never, items)
  })
  await expect(
    resolveShopifyReview(entrada(e, r, 'SHOPIFY'), { fetchLevels: fetchLevels as never, hasAccess: conPlan }),
  ).rejects.toMatchObject({
    statusCode: 409,
    code: 'SHOPIFY_EN_PAUSA',
  })
  expect(await stock(e)).toBe('13')
  expect((await revision(r.id)).status).toBe('OPEN')
  expect(await prisma.shopifyStockOutbox.count({ where: { productId: e.productId } })).toBe(0)
})

it('§12.2: un error terminal (CATALOGO_MAESTRO) que llega mientras se lee Shopify ⇒ 409 SHOPIFY_EN_PAUSA y nada cambia; después, ni se pregunta', async () => {
  const e = await escenario()
  const r = await abrir(e, '13')
  const fetchLevels = jest.fn(async (s: unknown, items: Array<{ inventoryItemId: string; shopifyLocationId: string }>) => {
    await prisma.shopifyLocationLink.update({ where: { id: e.locationLinkId }, data: { importError: 'CATALOGO_MAESTRO' } })
    return nivelesFalsos(() => nivel(10))(s as never, items)
  })
  await expect(
    resolveShopifyReview(entrada(e, r, 'SHOPIFY'), { fetchLevels: fetchLevels as never, hasAccess: conPlan }),
  ).rejects.toMatchObject({
    statusCode: 409,
    code: 'SHOPIFY_EN_PAUSA',
  })
  expect(await stock(e)).toBe('13')
  expect((await revision(r.id)).status).toBe('OPEN')
  const otra = deps()
  await expect(resolveShopifyReview(entrada(e, r, 'SHOPIFY'), otra)).rejects.toMatchObject({ statusCode: 409, code: 'SHOPIFY_EN_PAUSA' })
  expect(otra.fetchLevels).not.toHaveBeenCalled() // con la marca puesta no se pregunta a Shopify
})

it('N23: «usar Shopify» con Shopify en negativo avisa SOBREVENTA; un cuadre posterior sin cambios no lo pierde ni lo duplica', async () => {
  const e = await escenario()
  const r = await abrir(e, '2', 'DIFERENCIA', -1)
  expect(await resolveShopifyReview(entrada(e, r, 'SHOPIFY'), deps(nivel(-1)))).toEqual({ estado: 'RESUELTO' })
  expect(await stock(e)).toBe('-1')
  expect(await avisos(e, 'SOBREVENTA')).toBe(1)
  await cuadrar(e, nivel(-1))
  expect(await avisos(e, 'SOBREVENTA')).toBe(1)
})

describe('decisiones vinculantes de B5 (K12, T3, U2, bitácora)', () => {
  beforeEach(() => (logAction as jest.Mock).mockClear())

  it('K12 (B-7): un token que no se puede descifrar ⇒ 503 SHOPIFY_NO_RESPONDE, no un 500, y nada cambia', async () => {
    const e = await escenario()
    const r = await abrir(e, '13')
    await prisma.shopifyStore.update({ where: { id: e.storeId }, data: { accessTokenCiphertext: Buffer.from('cifrado-dañado') } })
    // Con el fetchLevels REAL de A, que lanza al no poder descifrar.
    await expect(resolveShopifyReview(entrada(e, r, 'SHOPIFY'), { hasAccess: conPlan })).rejects.toMatchObject({
      statusCode: 503,
      code: 'SHOPIFY_NO_RESPONDE',
    })
    expect(await stock(e)).toBe('13')
    expect((await revision(r.id)).status).toBe('OPEN')
  })

  it('K12: un error pasajero de la base (P2028) a media resolución ⇒ 503 SHOPIFY_NO_RESPONDE y la revisión sigue abierta', async () => {
    const e = await escenario()
    const r = await abrir(e, '13')
    let llamadas = 0
    const hasAccess = async () => {
      if (++llamadas === 2) throw Object.assign(new Error('Unable to start a transaction in the given time.'), { code: 'P2028' })
      return true
    }
    await expect(
      resolveShopifyReview(entrada(e, r, 'SHOPIFY'), { fetchLevels: nivelesFalsos(() => nivel(10)), hasAccess }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'SHOPIFY_NO_RESPONDE',
    })
    expect(await stock(e)).toBe('13')
    expect((await revision(r.id)).status).toBe('OPEN')
  })

  it('Shopify rechaza el token (401) ⇒ la tienda queda revocada y 409 SHOPIFY_EN_PAUSA (reconectar), no «intenta en un minuto»', async () => {
    const e = await escenario()
    const r = await abrir(e, '13')
    const d = { fetchLevels: jest.fn(async () => falla('UNAUTHORIZED', false, false)) as never, hasAccess: conPlan }
    await expect(resolveShopifyReview(entrada(e, r, 'SHOPIFY'), d)).rejects.toMatchObject({ statusCode: 409, code: 'SHOPIFY_EN_PAUSA' })
    expect((await prisma.shopifyStore.findUniqueOrThrow({ where: { id: e.storeId } })).status).toBe('REVOKED')
    expect((await revision(r.id)).status).toBe('OPEN')
  })

  it('400 SHOPIFY_CANTIDAD_INVALIDA: un número que no es número, uno infinito o un Shopify no entero; ni se pregunta a Shopify', async () => {
    const e = await escenario()
    const r = await abrir(e, '13')
    for (const mal of [{ expectedAvoqadoQty: 'trece' }, { expectedAvoqadoQty: 'NaN' }, { expectedShopifyQty: 10.5 }]) {
      const d = deps()
      await expect(resolveShopifyReview({ ...entrada(e, r, 'SHOPIFY'), ...mal }, d)).rejects.toMatchObject({
        statusCode: 400,
        code: 'SHOPIFY_CANTIDAD_INVALIDA',
      })
      expect(d.fetchLevels).not.toHaveBeenCalled()
    }
  })

  it('T3: sólo cuentan y se descartan las filas de la generación vigente; las de otra (también RELIGADA_A_OTRA_TIENDA) ni bloquean ni se tocan', async () => {
    const e = await escenario({ generation: 2 })
    const r = await abrir(e, '13')
    const fila = (generation: number, status: 'PENDING' | 'DEAD_LETTER', extra: { ambiguous?: boolean; lastError?: string } = {}) =>
      prisma.shopifyStockOutbox.create({
        data: { venueId: e.venueId, locationLinkId: e.locationLinkId, generation, productId: e.productId, delta: 1, status, ...extra },
      })
    const religada = await fila(1, 'DEAD_LETTER', { ambiguous: true, lastError: 'RELIGADA_A_OTRA_TIENDA' })
    const viejaViva = await fila(1, 'PENDING')
    const vigente = await fila(2, 'DEAD_LETTER')
    expect(await resolveShopifyReview(entrada(e, r, 'SHOPIFY'), deps())).toEqual({ estado: 'RESUELTO' })
    const estado = async (id: string) => (await prisma.shopifyStockOutbox.findUniqueOrThrow({ where: { id } })).status
    expect(await estado(religada.id)).toBe('DEAD_LETTER')
    expect(await estado(viejaViva.id)).toBe('PENDING')
    expect(await estado(vigente.id)).toBe('DISCARDED')
    expect(await huecoDelInvariante(e.productId)).toBe('0')
  })

  it('U2: una revisión ATORADO cuyas DEAD_LETTER ya se fueron se resuelve igual y queda con los atorados que de verdad descartó (0)', async () => {
    const e = await escenario()
    const r = await abrir(e, '13', 'ATORADO')
    await prisma.shopifyReviewItem.update({ where: { id: r.id }, data: { atorados: 2 } })
    expect(await resolveShopifyReview(entrada(e, r, 'AVOQADO'), deps())).toEqual({ estado: 'ENVIO_PENDIENTE' })
    expect(await revision(r.id)).toMatchObject({ status: 'RESOLVED', atorados: 0 })
    expect(await huecoDelInvariante(e.productId)).toBe('0')
  })

  /** Pareja suspendida (p. ej. cambió su artículo, K14) con una venta cuyo envío quedó ambiguo y luego muerto. */
  async function suspendidaConDudaMuerta(e: EscenarioShopify) {
    await venta(e.inventoryId) // A = 9, fila −1
    await prisma.shopifyStockOutbox.updateMany({
      where: { productId: e.productId },
      data: {
        status: 'DEAD_LETTER',
        ambiguous: true,
        sentInventoryItemId: 'gid://shopify/InventoryItem/1',
        sentLocationId: 'gid://shopify/Location/1',
        firstAttemptAt: new Date(),
        processedAt: new Date(),
        lastError: 'VENTANA_24H',
      },
    })
    await prisma.$transaction(tx => suspendPair(tx, e.variantLinkId, 'NIVEL_INEXISTENTE'))
  }

  it('U2: pareja suspendida con una duda muerta ⇒ el cuadre la manda a «Por revisar» INCIERTO; «usar Avoqado» la reactiva y el envío sale', async () => {
    const e = await escenario()
    await suspendidaConDudaMuerta(e)
    await cuadrar(e, nivel(10)) // no llegó: Shopify sigue en 10
    const r = await prisma.shopifyReviewItem.findFirstOrThrow({ where: { productId: e.productId, status: 'OPEN' } })
    expect(r).toMatchObject({ reason: 'INCIERTO', shopifyQty: 10, atorados: 1, suggestion: 'AVOQADO' })
    expect(r.avoqadoQty.toString()).toBe('9')
    expect(await resolveShopifyReview(entrada(e, r, 'AVOQADO'), deps(nivel(10)))).toEqual({ estado: 'ENVIO_PENDIENTE' })
    expect(await pareja(e)).toMatchObject({ suspendedReason: null, suspendedAt: null, mirrorAvailable: 10 })
    expect(await prisma.shopifyImportIssue.count({ where: { venueId: e.venueId } })).toBe(0)
    const res = await revision(r.id)
    expect(res).toMatchObject({ status: 'RESOLVED', atorados: 1 })
    const fila = await prisma.shopifyStockOutbox.findUniqueOrThrow({ where: { id: res.resolutionOutboxId! } })
    expect(fila.delta.toString()).toBe('-1')
    expect(await prisma.shopifyStockOutbox.count({ where: { productId: e.productId, status: 'DEAD_LETTER' } })).toBe(0)
    expect(await huecoDelInvariante(e.productId)).toBe('0') // 9 = 10 + (−1)
    expect(await claimShopifyOutbox(new Date())).toMatchObject({ kind: 'FILA', id: fila.id })
  })

  it('U2: la misma duda que SÍ llegó (Shopify en 9) sugiere Shopify; «usar Shopify» la reactiva sin mover Avoqado', async () => {
    const e = await escenario()
    await suspendidaConDudaMuerta(e)
    await cuadrar(e, nivel(9))
    const r = await prisma.shopifyReviewItem.findFirstOrThrow({ where: { productId: e.productId, status: 'OPEN' } })
    expect(r).toMatchObject({ reason: 'INCIERTO', shopifyQty: 9, suggestion: 'SHOPIFY' })
    expect(await resolveShopifyReview(entrada(e, r, 'SHOPIFY'), deps(nivel(9)))).toEqual({ estado: 'RESUELTO' })
    expect(await pareja(e)).toMatchObject({ suspendedReason: null, mirrorAvailable: 9 })
    expect(await stock(e)).toBe('9')
    expect(await huecoDelInvariante(e.productId)).toBe('0')
    await cuadrar(e, nivel(9)) // ya activa y cuadrada: nada nuevo por revisar
    expect(await prisma.shopifyReviewItem.count({ where: { productId: e.productId, status: 'OPEN' } })).toBe(0)
  })

  it('la pareja suspendida de un producto archivado nunca se reactiva al resolver ⇒ 409 SHOPIFY_PAREJA_SUSPENDIDA sin preguntar a Shopify', async () => {
    const e = await escenario()
    const r = await abrir(e, '13')
    await prisma.$transaction(tx => suspendPair(tx, e.variantLinkId, 'NIVEL_INEXISTENTE'))
    await prisma.product.update({ where: { id: e.productId }, data: { deletedAt: new Date(), deletedBy: 'SHOPIFY_SYNC' } })
    const d = deps()
    await expect(resolveShopifyReview(entrada(e, r, 'SHOPIFY'), d)).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHOPIFY_PAREJA_SUSPENDIDA',
    })
    expect(d.fetchLevels).not.toHaveBeenCalled()
    expect((await pareja(e)).suspendedReason).toBe('NIVEL_INEXISTENTE')
  })

  it('bitácora: resolver deja ActivityLog con quién, el negocio y la organización; un 409 no deja nada', async () => {
    const e = await escenario()
    const r = await abrir(e, '13')
    await expect(resolveShopifyReview(entrada(e, r, 'SHOPIFY'), deps(nivel(11)))).rejects.toMatchObject({ code: 'SHOPIFY_REVISION_CAMBIO' })
    expect(logAction).not.toHaveBeenCalled()
    const vista = await revision(r.id)
    expect(await resolveShopifyReview(entrada(e, vista, 'SHOPIFY'), deps(nivel(11)))).toEqual({ estado: 'RESUELTO' })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SHOPIFY_REVIEW_RESOLVED',
        staffId: e.staffId,
        venueId: e.venueId,
        organizationId: e.organizationId,
        entity: 'ShopifyReviewItem',
        entityId: r.id,
      }),
    )
  })
})
