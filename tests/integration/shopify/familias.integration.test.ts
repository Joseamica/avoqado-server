// tests/integration/shopify/familias.integration.test.ts
/**
 * Bloque 5 — el conector de Shopify y las familias de variantes. La Tarea 0 fijó lo que HOY fallaba; la Tarea 3 invirtió dos de
 * esas pruebas (renombradas, no borradas) y suma lo de convivir: la familia es de Avoqado (V1, V2) y el conector sólo manda en
 * cada talla su stock, su SKU y su código. La tercera («hoy» 3, agrupar a mano un producto ligado) la invirtió la Tarea 4: ahora
 * el rechazo manda a la pestaña «Desde Shopify».
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import {
  ARCHIVADO_POR_SHOPIFY,
  archivarPareja,
  FAMILIA_NO_RECIBE,
  cercoDe,
  nivelDeVariante,
  syncShopifyProduct,
  upsertShopifyVariant,
  type VarianteShopify,
} from '@/services/commerce-channels/shopify/shopify.catalog.service'
import { initializePair } from '@/services/commerce-channels/shopify/shopify.mirror.service'
import { markProductGroupWriter, updateProductGroup } from '@/services/product-variants/productGroup.service'
import { attachProductsTx, createGroupTx, loadGroupContextTx } from '@/services/product-variants/groupWriterTx'
import { previewGroupExisting } from '@/services/product-variants/groupExisting.service'
import { applyShopifyProposal, previewShopifyProposal } from '@/services/product-variants/shopifyFamilies.service'
import {
  agregarProductoShopify,
  assertTestDatabase,
  crearEscenarioShopify,
  EscenarioShopify,
  graphqlFalso,
  limpiarEscenarioShopify,
} from './fixtures'
import { conPlan, contexto, paginaDeVariantes, variante } from './fixturesB'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: () => ({ broadcastMenuUpdated: jest.fn() }) },
}))

jest.setTimeout(120_000)

let escenarios: EscenarioShopify[] = []
async function escenario(o: Parameters<typeof crearEscenarioShopify>[0] = { linkStatus: 'CONNECTING', initialized: false }) {
  const e = await crearEscenarioShopify(o)
  escenarios.push(e)
  return e
}
const activa = () => escenario({ linkStatus: 'ACTIVE' })
beforeAll(() => assertTestDatabase())
afterEach(async () => {
  for (const e of escenarios) await limpiarEscenarioShopify(e)
  escenarios = []
})

/** Mete un producto a una familia como sólo lo hace el motor (el trigger de escritor único lo exige). */
async function meterEnFamilia(e: EscenarioShopify, productId: string): Promise<string> {
  return prisma.$transaction(async tx => {
    await markProductGroupWriter(tx)
    const p = await tx.product.findUniqueOrThrow({ where: { id: productId } })
    const g = await tx.productGroup.create({ data: { venueId: e.venueId, name: p.name, categoryId: p.categoryId } })
    await tx.product.update({ where: { id: productId }, data: { productGroupId: g.id } })
    return g.id
  })
}

let familias = 0
/** Una familia armada con los escritores del motor (createGroupTx + attachProductsTx), una talla por producto. */
async function familia(
  e: EscenarioShopify,
  productIds: string[],
  o: { source?: 'MANUAL' | 'SHOPIFY'; externalId?: string } = {},
): Promise<string> {
  const tallas = productIds.map((_p, i) => `T${i}`)
  return prisma.$transaction(async tx => {
    const { groupId } = await createGroupTx(tx, e.venueId, {
      name: `Playera ${++familias}-${Date.now()}`,
      categoryId: e.categoryId,
      type: 'REGULAR',
      imageUrl: 'https://img.test/familia.png',
      ivaTratamiento: 'IVA_16',
      source: o.source ?? 'MANUAL',
      externalId: o.externalId ?? null,
      options: [{ name: 'Talla', values: tallas.length ? tallas : ['T0'] }],
    })
    const ctx = await loadGroupContextTx(tx, groupId, { trackInventory: true, createdById: null })
    await attachProductsTx(
      tx,
      ctx,
      productIds.map((productId, i) => ({ productId, values: [tallas[i]], ownImage: null })),
    )
    return groupId
  })
}

/** La variante de Shopify de una pareja que dejó `agregarProductoShopify` (mismos ids de variante, producto y artículo). */
async function varianteDeLaPareja(variantLinkId: string, sku: string): Promise<VarianteShopify> {
  const p = await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: variantLinkId } })
  const v = variante(1, { sku, barcode: null, producto: p.shopifyProductId, available: 10, committed: 0 })
  return { ...v, id: p.shopifyVariantId, inventoryItem: { ...v.inventoryItem, id: p.inventoryItemId } }
}

const aviso = (e: EscenarioShopify, shopifyVariantId: string) =>
  prisma.shopifyImportIssue.findUnique({ where: { venueId_shopifyVariantId: { venueId: e.venueId, shopifyVariantId } } })
const filaEnCamino = (e: EscenarioShopify, productId: string) =>
  prisma.shopifyStockOutbox.create({
    data: {
      venueId: e.venueId,
      locationLinkId: e.locationLinkId,
      generation: 1,
      productId,
      delta: -1,
      status: 'IN_PROGRESS',
      claimToken: 'm',
    },
  })
/** Stock, movimientos y buzón de un producto, para comparar antes y después. */
async function stockDe(productId: string) {
  const inv = await prisma.inventory.findUniqueOrThrow({ where: { productId } })
  return {
    stock: inv.currentStock.toString(),
    movimientos: await prisma.inventoryMovement.count({ where: { inventoryId: inv.id } }),
    buzon: await prisma.shopifyStockOutbox.findMany({ where: { productId }, orderBy: { id: 'asc' }, take: 50 }),
  }
}

/** Una transacción que retiene un candado (`sql`) hasta `soltar()`; da su pid para reconocer quién la espera. */
async function retener(sql: Prisma.Sql) {
  let soltar!: () => void
  let listo!: (pid: number) => void
  const pid = new Promise<number>(r => (listo = r))
  const suelta = new Promise<void>(r => (soltar = r))
  const fin = prisma.$transaction(
    async tx => {
      const [fila] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
      await tx.$queryRaw(sql)
      listo(fila.pid)
      await suelta
    },
    { timeout: 60_000 },
  )
  return { pid: await pid, soltar, fin }
}
/** Espera (sin dormir a ciegas) a que una sesión quede detenida por un candado de `pid`; devuelve el pid de esa sesión. */
async function bloqueadaPor(pid: number): Promise<number> {
  for (let i = 0; i < 500; i++) {
    const [fila] = await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND ${pid}::int = ANY(pg_blocking_pids(pid)) LIMIT 1`
    if (fila) return fila.pid
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error(`Nadie quedó esperando a la sesión ${pid}`)
}
const desenlace = (x: PromiseSettledResult<unknown>) => (x.status === 'rejected' ? String((x.reason as Error)?.message ?? x.reason) : 'ok')

describe('bloque 5 · el conector convive con tallas agrupadas (E1-E6, E8)', () => {
  it('cada pareja guarda shopifyCatalog (título, opciones sin «Default Title» y las dos fotos) al ligar y al actualizar', async () => {
    const e = await escenario()
    const u = await upsertShopifyVariant(await contexto(e), variante(31, { sku: 'CAT-31' }))
    expect(u).toMatchObject({ kind: 'CREADO' })
    expect((await prisma.shopifyVariantLink.findFirstOrThrow({ where: { shopifyVariantId: variante(31).id } })).shopifyCatalog).toEqual({
      title: 'Camisa lino',
      options: [{ name: 'Talla', value: 'M31' }],
      productImage: 'https://cdn.test/p.jpg',
      variantImage: 'https://cdn.test/v31.jpg',
    })
    // Una actualización la pone al día; «Default Title» (producto sin tallas) no es una opción, y sin fotos quedan en null.
    const v = variante(31, { sku: 'CAT-31', titulo: 'Camisa de lino', opcion: 'Default Title', imagenVariante: null, imagenProducto: null })
    expect(await upsertShopifyVariant(await contexto(e), v)).toMatchObject({ kind: 'ACTUALIZADO' })
    expect((await prisma.shopifyVariantLink.findFirstOrThrow({ where: { shopifyVariantId: v.id } })).shopifyCatalog).toEqual({
      title: 'Camisa de lino',
      options: [],
      productImage: null,
      variantImage: null,
    })
  })

  it('🔴 D: un aviso idéntico de Shopify no reescribe la talla (ni su updatedAt) ⇒ la huella de «Desde Shopify» sigue sirviendo', async () => {
    const e = await escenario()
    const prod = 'gid://shopify/Product/9907'
    const vs = [variante(41, { sku: 'ID-41', producto: prod, opcion: 'S' }), variante(42, { sku: 'ID-42', producto: prod, opcion: 'M' })]
    for (const v of vs) expect(await upsertShopifyVariant(await contexto(e), v)).toMatchObject({ kind: 'CREADO' })
    const tallas = () =>
      prisma.product.findMany({ where: { venueId: e.venueId, sku: { in: ['ID-41', 'ID-42'] } }, orderBy: { sku: 'asc' }, take: 2 })
    const antes = await tallas()
    const pv = await previewShopifyProposal(e.venueId, prod, {})
    // El aviso (o el cuadre) vuelve a mandar lo mismo.
    for (const v of vs) expect(await upsertShopifyVariant(await contexto(e), v)).toMatchObject({ kind: 'ACTUALIZADO' })
    expect((await tallas()).map(p => p.updatedAt.toISOString())).toEqual(antes.map(p => p.updatedAt.toISOString()))
    const r = await applyShopifyProposal(e.venueId, { type: 'HUMAN', staffId: e.staffId, impersonating: false }, prod, {
      expectedFingerprint: pv.fingerprint,
    })
    expect(r).toMatchObject({ mode: 'CREATE', productIds: antes.map(p => p.id).sort() })
    // Un cambio de verdad (SKU nuevo) sí se escribe.
    expect(await upsertShopifyVariant(await contexto(e), { ...vs[0], sku: 'ID-41B' })).toMatchObject({ kind: 'ACTUALIZADO' })
    expect((await prisma.product.findUniqueOrThrow({ where: { id: antes[0].id } })).sku).toBe('ID-41B')
  })

  // Era «hoy: un producto agrupado no se liga y queda PRODUCTO_CON_VARIANTES» (Tarea 0, invertida en la Tarea 3: E8, V2).
  it('una talla agrupada se liga (de cualquier familia) y el conector no le toca nada al ligarla', async () => {
    const e = await escenario()
    const ex = await agregarProductoShopify(e, { sku: 'FAM-LIGA', pareja: false })
    await meterEnFamilia(e, ex.productId)
    const antes = await prisma.product.findUniqueOrThrow({ where: { id: ex.productId } })

    expect(await upsertShopifyVariant(await contexto(e), variante(21, { sku: 'FAM-LIGA', barcode: null }))).toMatchObject({
      kind: 'LIGADO',
      productId: ex.productId,
      iniciada: false,
      creadaPorConector: false,
    })
    expect(await prisma.product.findUniqueOrThrow({ where: { id: ex.productId } })).toEqual(antes)
    expect(await prisma.shopifyVariantLink.count({ where: { productId: ex.productId } })).toBe(1)
    expect(await aviso(e, variante(21).id)).toBeNull()
  })

  // Era «hoy: actualizarPareja sobre una talla agrupada ligada a mano choca con el trigger» (Tarea 0, invertida: E4, Review Focus 3).
  it('aviso con otro título y foto: el nombre y la foto de la talla agrupada no cambian, su SKU sí; pareja, Inventory y buzón intactos', async () => {
    const e = await escenario()
    // La pareja se escribe por SQL, como en la prueba de la Tarea 0 que esta invierte.
    const ex = await agregarProductoShopify(e, { sku: 'FAM-PAREJA', pareja: false })
    await meterEnFamilia(e, ex.productId)
    const n = 7001
    const parejaId = `cfam${String(n).padEnd(21, '0')}`
    await prisma.$executeRaw`
      INSERT INTO "ShopifyVariantLink"
        (id, "locationLinkId", "venueId", "productId", "shopifyProductId", "shopifyVariantId", "inventoryItemId", "mirrorAt", "updatedAt")
      VALUES
        (${parejaId}, ${e.locationLinkId}, ${e.venueId}, ${ex.productId},
         'gid://shopify/Product/77', ${`gid://shopify/ProductVariant/${n}`}, ${`gid://shopify/InventoryItem/${n}`}, now(), now())`
    const antes = await prisma.product.findUniqueOrThrow({ where: { id: ex.productId } })
    const stockAntes = await stockDe(ex.productId)
    const base = variante(1, { sku: 'FAM-NUEVO', titulo: 'Otro título', imagenVariante: 'https://cdn.test/otra.jpg' })
    const v = {
      ...base,
      id: `gid://shopify/ProductVariant/${n}`,
      inventoryItem: { ...base.inventoryItem, id: `gid://shopify/InventoryItem/${n}` },
    }

    expect(await upsertShopifyVariant(await contexto(e), v)).toMatchObject({ kind: 'ACTUALIZADO', variantLinkId: parejaId })
    const despues = await prisma.product.findUniqueOrThrow({ where: { id: ex.productId } })
    expect({ name: despues.name, imageUrl: despues.imageUrl }).toEqual({ name: antes.name, imageUrl: antes.imageUrl })
    expect(despues.sku).toBe('FAM-NUEVO')
    expect(await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: parejaId } })).toMatchObject({
      productId: ex.productId,
      shopifyVariantId: v.id,
      inventoryItemId: v.inventoryItem.id,
      shopifyCatalog: expect.objectContaining({ title: 'Otro título', variantImage: 'https://cdn.test/otra.jpg' }),
    })
    expect(await stockDe(ex.productId)).toEqual(stockAntes)
  })

  it('B8: talla de familia MANUAL con el mismo SKU se liga y su stock sincroniza: initializePair la inicia y una venta encola su salida', async () => {
    const e = await activa()
    const ex = await agregarProductoShopify(e, { sku: 'B8-M', stock: 10, pareja: false })
    await familia(e, [ex.productId])
    const ctx = await contexto(e)
    const v = variante(41, { sku: 'B8-M', barcode: null, available: 10, committed: 0 })
    const u = await upsertShopifyVariant(ctx, v)
    expect(u).toMatchObject({ kind: 'LIGADO', iniciada: false })
    if (u.kind !== 'LIGADO') throw new Error('no se ligó')
    expect(
      await initializePair(
        { variantLinkId: u.variantLinkId, nivel: nivelDeVariante(v), fetchedAt: new Date(), mode: 'COMPARAR' },
        { hasAccess: conPlan, cerco: cercoDe(ctx) },
      ),
    ).toBe('INICIADA')
    await prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE "productId" = ${ex.productId}`
    const buzon = await prisma.shopifyStockOutbox.findMany({
      where: { productId: ex.productId },
      select: { delta: true, status: true },
      take: 5,
    })
    expect(buzon.map(f => `${f.status} ${f.delta.toString()}`)).toEqual(['PENDING -1'])
  })

  it('🔴 borrar en Shopify mientras otra transacción edita la familia ⇒ ninguna aborta y la familia termina archivada (Review Focus 5)', async () => {
    const e = await activa()
    const ex = await agregarProductoShopify(e, { sku: 'CONC-M' })
    const groupId = await familia(e, [ex.productId])
    const nueva = await prisma.menuCategory.create({
      data: { venueId: e.venueId, name: `Nueva ${Date.now()}`, slug: `nueva-${Date.now()}` },
    })
    const pareja = await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: ex.variantLinkId! } })
    // La barrera detiene la edición con el negocio y la familia ya tomados, ANTES de tocar sus tallas: la familia apunta a la
    // categoría nueva (llave foránea) y esa fila está retenida.
    const barrera = await retener(Prisma.sql`SELECT id FROM "MenuCategory" WHERE id = ${nueva.id} FOR UPDATE`)
    const edicion = updateProductGroup(
      e.venueId,
      groupId,
      { categoryId: nueva.id },
      { type: 'HUMAN', staffId: e.staffId, impersonating: false },
    )
    const pidEdicion = await bloqueadaPor(barrera.pid)
    const baja = archivarPareja(pareja)
    await bloqueadaPor(pidEdicion) // la baja ya espera a la edición
    barrera.soltar()
    const [a, b] = await Promise.allSettled([edicion, baja])
    await barrera.fin
    expect([a, b].map(desenlace)).toEqual(['ok', 'ok'])
    expect((b as PromiseFulfilledResult<string>).value).toBe('ARCHIVADA')
    expect(await prisma.productGroup.findUniqueOrThrow({ where: { id: groupId } })).toMatchObject({
      categoryId: nueva.id,
      deletedBy: ARCHIVADO_POR_SHOPIFY,
      deletedAt: expect.any(Date),
    })
    expect(await prisma.product.findUniqueOrThrow({ where: { id: ex.productId } })).toMatchObject({
      categoryId: nueva.id,
      deletedBy: ARCHIVADO_POR_SHOPIFY,
    })
    expect(await prisma.shopifyVariantLink.count({ where: { id: pareja.id } })).toBe(0)
  })

  it('baja → envío en camino → terminado → segunda baja limpia la pareja con la familia archivada', async () => {
    const e = await activa()
    const ex = await agregarProductoShopify(e, { sku: 'DOS-BAJAS' })
    const groupId = await familia(e, [ex.productId])
    const fila = await filaEnCamino(e, ex.productId)
    const pareja = await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: ex.variantLinkId! } })

    expect(await archivarPareja(pareja)).toBe('SUSPENDIDA')
    expect(await prisma.productGroup.findUniqueOrThrow({ where: { id: groupId } })).toMatchObject({ deletedBy: ARCHIVADO_POR_SHOPIFY })
    expect(await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: pareja.id } })).toMatchObject({
      suspendedReason: 'NIVEL_INEXISTENTE',
    })

    await prisma.shopifyStockOutbox.update({ where: { id: fila.id }, data: { status: 'SENT', processedAt: new Date(), claimToken: null } })
    expect(await archivarPareja(pareja)).toBe('ARCHIVADA')
    expect(await prisma.shopifyVariantLink.count({ where: { id: pareja.id } })).toBe(0)
    expect(await prisma.productGroup.findUniqueOrThrow({ where: { id: groupId } })).toMatchObject({
      deletedBy: ARCHIVADO_POR_SHOPIFY,
      deletedAt: expect.any(Date),
    })
  })

  describe('la variante vuelve (V7)', () => {
    /** Una talla ligada, en su familia, que el conector archivó (la pareja queda borrada): lista para volver. */
    async function tallaArchivada(o: { otraViva?: boolean; source?: 'MANUAL' | 'SHOPIFY'; externalId?: string } = {}) {
      const e = await activa()
      const a = await agregarProductoShopify(e, { sku: `V7-A-${familias}` })
      const otra = o.otraViva ? await agregarProductoShopify(e, { sku: `V7-B-${familias}`, pareja: false }) : null
      const groupId = await familia(e, otra ? [a.productId, otra.productId] : [a.productId], o)
      const sku = (await prisma.product.findUniqueOrThrow({ where: { id: a.productId } })).sku!
      const v = await varianteDeLaPareja(a.variantLinkId!, sku)
      expect(await archivarPareja(await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: a.variantLinkId! } }))).toBe('ARCHIVADA')
      return { e, a, groupId, v }
    }

    it('familia viva ⇒ la talla vuelve y se liga', async () => {
      const { e, a, groupId, v } = await tallaArchivada({ otraViva: true })
      expect(await prisma.productGroup.findUniqueOrThrow({ where: { id: groupId } })).toMatchObject({ deletedAt: null })
      expect(await upsertShopifyVariant(await contexto(e), v)).toMatchObject({ kind: 'LIGADO', productId: a.productId })
      expect(await prisma.product.findUniqueOrThrow({ where: { id: a.productId } })).toMatchObject({
        deletedAt: null,
        productGroupId: groupId,
      })
    })

    it('familia archivada por el conector ⇒ revive con la talla', async () => {
      const { e, a, groupId, v } = await tallaArchivada()
      expect(await prisma.productGroup.findUniqueOrThrow({ where: { id: groupId } })).toMatchObject({ deletedBy: ARCHIVADO_POR_SHOPIFY })
      expect(await upsertShopifyVariant(await contexto(e), v)).toMatchObject({ kind: 'LIGADO', productId: a.productId })
      expect(await prisma.productGroup.findUniqueOrThrow({ where: { id: groupId } })).toMatchObject({ deletedAt: null, deletedBy: null })
      expect(await prisma.product.findUniqueOrThrow({ where: { id: a.productId } })).toMatchObject({ deletedAt: null, active: true })
    })

    it('familia archivada por el dueño ⇒ la talla se queda archivada con aviso', async () => {
      const { e, a, groupId, v } = await tallaArchivada()
      await prisma.productGroup.update({ where: { id: groupId }, data: { deletedBy: e.staffId } })
      expect(await upsertShopifyVariant(await contexto(e), v)).toEqual({ kind: 'PROBLEMA', reason: 'PRODUCTO_ARCHIVADO' })
      expect(await aviso(e, v.id)).toMatchObject({
        reason: 'PRODUCTO_ARCHIVADO',
        detail: 'Su familia está archivada o llena: restáurala en Avoqado.',
        productId: a.productId,
      })
      expect(await prisma.product.findUniqueOrThrow({ where: { id: a.productId } })).toMatchObject({ deletedBy: ARCHIVADO_POR_SHOPIFY })
      expect(await prisma.productGroup.findUniqueOrThrow({ where: { id: groupId } })).toMatchObject({ deletedBy: e.staffId })
      expect(await prisma.shopifyVariantLink.count({ where: { productId: a.productId } })).toBe(0)
    })

    it('familia viva pero llena (250 vivas) ⇒ la talla se queda archivada con aviso', async () => {
      const { e, a, groupId, v } = await tallaArchivada({ otraViva: true })
      // Hasta 250 vivas: 1 que ya tenía + 249 más (sólo el motor mete productos a una familia).
      await prisma.$transaction(async tx => {
        await markProductGroupWriter(tx)
        await tx.product.createMany({
          data: Array.from({ length: 249 }, (_x, i) => ({
            venueId: e.venueId,
            categoryId: e.categoryId,
            name: `Relleno ${i}`,
            sku: `RELLENO-${i}`,
            price: 1,
            productGroupId: groupId,
            variantKey: `relleno-${i}`,
          })),
        })
      })
      expect(await prisma.product.count({ where: { productGroupId: groupId, deletedAt: null } })).toBe(250)
      expect(await upsertShopifyVariant(await contexto(e), v)).toEqual({ kind: 'PROBLEMA', reason: 'PRODUCTO_ARCHIVADO' })
      expect(await aviso(e, v.id)).toMatchObject({ reason: 'PRODUCTO_ARCHIVADO' })
      expect(await prisma.product.findUniqueOrThrow({ where: { id: a.productId } })).toMatchObject({ deletedBy: ARCHIVADO_POR_SHOPIFY })
    })

    it('con otra familia viva con la misma llave ⇒ la talla se queda archivada con aviso', async () => {
      const llave = `gid://shopify/Product/9${Date.now()}`
      const { e, a, groupId, v } = await tallaArchivada({ source: 'SHOPIFY', externalId: llave })
      const otraFamilia = await familia(e, [], { source: 'SHOPIFY', externalId: llave }) // el índice parcial la deja: la otra está archivada
      expect(await upsertShopifyVariant(await contexto(e), v)).toEqual({ kind: 'PROBLEMA', reason: 'PRODUCTO_ARCHIVADO' })
      expect(await aviso(e, v.id)).toMatchObject({ reason: 'PRODUCTO_ARCHIVADO' })
      expect(await prisma.productGroup.findUniqueOrThrow({ where: { id: groupId } })).toMatchObject({ deletedBy: ARCHIVADO_POR_SHOPIFY })
      expect(await prisma.productGroup.findUniqueOrThrow({ where: { id: otraFamilia } })).toMatchObject({ deletedAt: null })
      expect(await prisma.product.findUniqueOrThrow({ where: { id: a.productId } })).toMatchObject({ deletedBy: ARCHIVADO_POR_SHOPIFY })
    })
  })

  it('al agrupar, stock, movimientos y buzón no cambian (ni la pareja)', async () => {
    const e = await activa()
    const ex = await agregarProductoShopify(e, { sku: 'AGRUPA-1', stock: 8 })
    // Una venta deja su fila en el buzón: agrupar no la toca.
    await prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE "productId" = ${ex.productId}`
    const antes = await stockDe(ex.productId)
    expect(antes.buzon).toHaveLength(1)
    const pareja = await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: ex.variantLinkId! } })
    await familia(e, [ex.productId])
    expect(await stockDe(ex.productId)).toEqual(antes)
    expect(await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: pareja.id } })).toEqual(pareja)
  })

  it('baja → envío pendiente → regreso rechazado → termina el envío ⇒ el aviso PRODUCTO_ARCHIVADO sigue (y los demás avisos se limpian)', async () => {
    const e = await activa()
    const ex = await agregarProductoShopify(e, { sku: 'RECH-FIN' })
    const groupId = await familia(e, [ex.productId])
    const v = await varianteDeLaPareja(ex.variantLinkId!, 'RECH-FIN')
    const fila = await filaEnCamino(e, ex.productId)
    const pareja = await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: ex.variantLinkId! } })
    expect(await archivarPareja(pareja)).toBe('SUSPENDIDA')
    await prisma.productGroup.update({ where: { id: groupId }, data: { deletedBy: e.staffId } }) // el dueño archivó la familia
    expect(await upsertShopifyVariant(await contexto(e), v)).toEqual({ kind: 'PROBLEMA', reason: 'PRODUCTO_ARCHIVADO' })
    // Termina el envío: la segunda baja borra la pareja (como el cuadre al reintentar).
    await prisma.shopifyStockOutbox.update({ where: { id: fila.id }, data: { status: 'SENT', processedAt: new Date(), claimToken: null } })
    expect(await archivarPareja(pareja)).toBe('ARCHIVADA')
    expect(await prisma.shopifyVariantLink.count({ where: { id: pareja.id } })).toBe(0)
    expect(await aviso(e, v.id)).toMatchObject({ reason: 'PRODUCTO_ARCHIVADO', detail: FAMILIA_NO_RECIBE, productId: ex.productId })

    // Regresión: cualquier otro aviso de una variante (aquí, uno PRODUCTO_ARCHIVADO sin detalle) sí se limpia con la baja.
    const otra = await agregarProductoShopify(e, { sku: 'OTRO-AVISO' })
    const p2 = await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: otra.variantLinkId! } })
    await prisma.shopifyImportIssue.create({
      data: {
        venueId: e.venueId,
        shopifyVariantId: p2.shopifyVariantId,
        shopifyProductId: p2.shopifyProductId,
        title: 'x',
        reason: 'PRODUCTO_ARCHIVADO',
      },
    })
    expect(await archivarPareja(p2)).toBe('ARCHIVADA')
    expect(await aviso(e, p2.shopifyVariantId)).toBeNull()
  })

  it('pareja retenida, rechazada por familia llena; se libera lugar y vuelve a sincronizar ⇒ se restaura y el aviso se va', async () => {
    const e = await activa()
    const a = await agregarProductoShopify(e, { sku: 'LLENA-A' })
    const b = await agregarProductoShopify(e, { sku: 'LLENA-B', pareja: false })
    const groupId = await familia(e, [a.productId, b.productId])
    const v = await varianteDeLaPareja(a.variantLinkId!, 'LLENA-A')
    await filaEnCamino(e, a.productId)
    const pareja = await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: a.variantLinkId! } })
    expect(await archivarPareja(pareja)).toBe('SUSPENDIDA') // la pareja queda retenida por el envío
    // La familia se llena con la talla fuera: B + 249 = 250 vivas.
    await prisma.$transaction(async tx => {
      await markProductGroupWriter(tx)
      await tx.product.createMany({
        data: Array.from({ length: 249 }, (_x, i) => ({
          venueId: e.venueId,
          categoryId: e.categoryId,
          name: `Relleno ${i}`,
          sku: `LLENO-${i}`,
          price: 1,
          productGroupId: groupId,
          variantKey: `lleno-${i}`,
        })),
      })
    })
    expect(await upsertShopifyVariant(await contexto(e), v)).toEqual({ kind: 'PROBLEMA', reason: 'PRODUCTO_ARCHIVADO' })
    expect(await aviso(e, v.id)).toMatchObject({ detail: FAMILIA_NO_RECIBE })

    // El dueño archiva otra talla: ya hay lugar.
    await prisma.product.update({ where: { id: b.productId }, data: { deletedAt: new Date(), deletedBy: e.staffId, active: false } })
    expect(await upsertShopifyVariant(await contexto(e), v)).toMatchObject({ kind: 'ACTUALIZADO', variantLinkId: pareja.id })
    expect(await prisma.product.findUniqueOrThrow({ where: { id: a.productId } })).toMatchObject({ deletedAt: null, deletedBy: null })
    expect(await aviso(e, v.id)).toBeNull()
  })

  it('restauración rechazada con la pareja borrada y con la pareja retenida por un envío pendiente ⇒ el aviso persiste y no se inicia la pareja (R5-4)', async () => {
    const e = await activa()
    // 1) Pareja borrada: la talla volvió, su familia la archivó el dueño.
    const borrada = await agregarProductoShopify(e, { sku: 'RECH-BORRADA' })
    const g1 = await familia(e, [borrada.productId])
    const v1 = await varianteDeLaPareja(borrada.variantLinkId!, 'RECH-BORRADA')
    expect(await archivarPareja(await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: borrada.variantLinkId! } }))).toBe(
      'ARCHIVADA',
    )
    await prisma.productGroup.update({ where: { id: g1 }, data: { deletedBy: e.staffId } })
    // 2) Pareja retenida: el conector archivó con un envío en camino (queda suspendida); el envío terminó y el dueño archivó la familia.
    const retenida = await agregarProductoShopify(e, { sku: 'RECH-RETENIDA' })
    const g2 = await familia(e, [retenida.productId])
    const v2 = await varianteDeLaPareja(retenida.variantLinkId!, 'RECH-RETENIDA')
    const fila = await filaEnCamino(e, retenida.productId)
    expect(await archivarPareja(await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: retenida.variantLinkId! } }))).toBe(
      'SUSPENDIDA',
    )
    await prisma.shopifyStockOutbox.update({ where: { id: fila.id }, data: { status: 'SENT', processedAt: new Date(), claimToken: null } })
    await prisma.productGroup.update({ where: { id: g2 }, data: { deletedBy: e.staffId } })
    const parejaRetenida = await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: retenida.variantLinkId! } })

    for (const [v, productId] of [
      [v1, borrada.productId],
      [v2, retenida.productId],
    ] as const) {
      const graphql = graphqlFalso(() => paginaDeVariantes([v], null))
      expect(await syncShopifyProduct(e.storeId, v.product.id, { hasAccess: conPlan, graphql })).toEqual({ ok: true })
      expect(await aviso(e, v.id)).toMatchObject({
        reason: 'PRODUCTO_ARCHIVADO',
        detail: 'Su familia está archivada o llena: restáurala en Avoqado.',
      })
      expect(await prisma.product.findUniqueOrThrow({ where: { id: productId } })).toMatchObject({ deletedBy: ARCHIVADO_POR_SHOPIFY })
    }
    expect(await prisma.shopifyVariantLink.count({ where: { productId: borrada.productId } })).toBe(0)
    // La retenida no se reactivó (sigue suspendida, como la dejó el archivo) ni se pidió nada sobre ella.
    expect(await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { id: parejaRetenida.id } })).toEqual(parejaRetenida)
  })
})

describe('hoy (invertida por la Tarea 4)', () => {
  it('agrupar a mano un producto ligado ⇒ 409 «se agrupa desde la pestaña Desde Shopify» (la «hoy» 3 invertida)', async () => {
    const e = await escenario()
    const otro = await agregarProductoShopify(e, { sku: 'FAM-SUELTO', pareja: false })
    // `e.productId` ya trae su pareja de Shopify.
    const input = {
      name: 'Camisa',
      options: [{ name: 'Talla', values: ['M', 'L'] }],
      members: [
        { productId: e.productId, values: ['M'] },
        { productId: otro.productId, values: ['L'] },
      ],
    }
    await expect(previewGroupExisting(e.venueId, input)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PRODUCT_GROUP_SHOPIFY_LINKED',
      message: expect.stringContaining('se agrupa desde la pestaña Desde Shopify'),
    })
  })
})
