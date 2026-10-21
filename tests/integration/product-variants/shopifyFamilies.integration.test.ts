// tests/integration/product-variants/shopifyFamilies.integration.test.ts
/**
 * Bloque 5, Tarea 4 — «Desde Shopify»: el dueño agrupa las tallas sueltas ligadas a Shopify con una propuesta que arma el servidor
 * con lo que guardó cada pareja (`shopifyCatalog`), una por una o «Agrupar todas», siempre con vista previa y huella (V3, V4, V6,
 * B7, B14). Contra Postgres REAL (base desechable).
 *
 * TEST_DATABASE_URL=… DATABASE_URL=… npx jest --selectProjects=integration --runInBand --runTestsByPath <este archivo> --ci
 */
import type { Server } from 'http'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import type { CatalogActor } from '@/types/master-catalog'
import {
  applyShopifyProposal,
  applyShopifyProposalsBatch,
  buildShopifyProposal,
  listShopifyFamilyProposals,
  previewAllShopifyProposals,
  previewShopifyProposal,
} from '@/services/product-variants/shopifyFamilies.service'
import { applyGroupExisting, previewGroupExisting } from '@/services/product-variants/groupExisting.service'
import {
  createProductWithVariants,
  markProductGroupWriter,
  ungroupProductGroup,
  updateProductGroup,
} from '@/services/product-variants/productGroup.service'
import { attachProductsTx, createGroupTx, loadGroupContextTx } from '@/services/product-variants/groupWriterTx'
import { deductInventoryForProduct } from '@/services/dashboard/productInventoryIntegration.service'
import { encenderIvaPorProducto } from '@tests/__helpers__/iva-por-producto'
import {
  agregarProductoShopify,
  assertTestDatabase,
  crearEscenarioShopify,
  EscenarioShopify,
  limpiarEscenarioShopify,
} from '../shopify/fixtures'
import { limpiarOtraSucursal, otraSucursalDeLaTienda } from '../shopify/fixturesB'

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: () => ({ broadcastMenuUpdated: jest.fn() }) },
}))

jest.setTimeout(180_000)

const BUSY = 'Alguno de estos productos se está usando en este momento (una venta o una edición); intenta de nuevo en unos segundos.'
/** Mismo largo: el orden de texto es el orden numérico. */
const spid = (k: number) => `gid://shopify/Product/${700000 + k}`

let escenarios: EscenarioShopify[] = []
let sucursales: EscenarioShopify[] = []
/** Una sucursal ligada a Shopify; la pareja de base (un producto sin tallas en Shopify) no es propuesta. */
async function escenario(): Promise<EscenarioShopify> {
  const e = await crearEscenarioShopify({ linkStatus: 'ACTIVE' })
  escenarios.push(e)
  await sinTallas(e)
  return e
}
async function sinTallas(e: EscenarioShopify) {
  await prisma.shopifyVariantLink.update({
    where: { id: e.variantLinkId },
    data: { shopifyCatalog: { title: 'Camisa', options: [], productImage: null, variantImage: null } },
  })
}
beforeAll(() => assertTestDatabase())
afterEach(async () => {
  for (const s of sucursales) await limpiarOtraSucursal(s)
  for (const e of escenarios) await limpiarEscenarioShopify(e)
  escenarios = []
  sucursales = []
})

const actor = (e: EscenarioShopify): CatalogActor => ({ type: 'HUMAN', staffId: e.staffId, impersonating: false })

let n = 0
/** Una talla suelta ligada a `id` de Shopify, con lo que Shopify dijo de ella. Devuelve el id del producto. */
async function talla(
  e: EscenarioShopify,
  id: string,
  opciones: Array<[string, string]>,
  o: { title?: string; sinCatalogo?: boolean; stock?: number } = {},
): Promise<string> {
  const t = await agregarProductoShopify(e, { sku: `SF-${++n}-${Date.now()}`, stock: o.stock })
  const options = opciones.map(([name, value]) => ({ name, value }))
  const title = o.title ?? 'Playera'
  await prisma.product.update({ where: { id: t.productId }, data: { name: [title, ...options.map(x => x.value)].join(' · ') } })
  await prisma.shopifyVariantLink.update({
    where: { id: t.variantLinkId! },
    data: {
      shopifyProductId: id,
      shopifyCatalog: o.sinCatalogo ? Prisma.DbNull : { title, options, productImage: 'https://img.test/p.png', variantImage: null },
    },
  })
  return t.productId
}

async function aplicar(e: EscenarioShopify, id: string) {
  const pv = await previewShopifyProposal(e.venueId, id, {})
  return applyShopifyProposal(e.venueId, actor(e), id, { expectedFingerprint: pv.fingerprint })
}
const otraCategoria = (e: EscenarioShopify) =>
  prisma.menuCategory.create({ data: { venueId: e.venueId, name: `Otra ${++n}`, slug: `otra-${n}-${Date.now()}` } })

/** Stock, movimientos, buzón y pareja de un producto: lo que agrupar NUNCA toca. */
async function intocable(productId: string) {
  const inv = await prisma.inventory.findUniqueOrThrow({ where: { productId } })
  return {
    stock: inv.currentStock.toString(),
    movimientos: await prisma.inventoryMovement.count({ where: { inventoryId: inv.id } }),
    buzon: await prisma.shopifyStockOutbox.findMany({ where: { productId }, orderBy: { id: 'asc' }, take: 50 }),
    pareja: await prisma.shopifyVariantLink.findUniqueOrThrow({ where: { productId } }),
  }
}

/** Una transacción que retiene un candado (`sql`) hasta `soltar()`. */
async function retener(sql: Prisma.Sql) {
  let soltar!: () => void
  let listo!: () => void
  const tomado = new Promise<void>(r => (listo = r))
  const suelta = new Promise<void>(r => (soltar = r))
  const fin = prisma.$transaction(
    async tx => {
      await tx.$queryRaw(sql)
      listo()
      await suelta
    },
    { timeout: 60_000 },
  )
  await tomado
  return { soltar, fin }
}

/** Una familia MANUAL hecha en Avoqado con esas tallas (ya ligadas a Shopify: B8, ligadas por SKU), con los escritores del motor. */
async function familiaManual(e: EscenarioShopify, name: string, tallas: Array<[string, string]>): Promise<string> {
  return prisma.$transaction(async tx => {
    const { groupId } = await createGroupTx(tx, e.venueId, {
      name,
      categoryId: e.categoryId,
      type: 'REGULAR',
      imageUrl: null,
      ivaTratamiento: 'IVA_16',
      source: 'MANUAL',
      externalId: null,
      options: [{ name: 'Talla', values: tallas.map(([, v]) => v) }],
    })
    const ctx = await loadGroupContextTx(tx, groupId, { trackInventory: true, createdById: null })
    await attachProductsTx(
      tx,
      ctx,
      tallas.map(([productId, v]) => ({ productId, values: [v], ownImage: null })),
    )
    return groupId
  })
}

describe('«Desde Shopify»: propuestas', () => {
  it('lista CREATE y ADD con total y cursor; ready=false sin shopifyCatalog; blockedReason con 4 opciones', async () => {
    const e = await escenario()
    await talla(e, spid(1), [['Talla', 'S']])
    const familia = await aplicar(e, spid(1))
    await talla(e, spid(1), [['Talla', 'M']]) // talla nueva de una familia que ya existe ⇒ ADD
    await talla(e, spid(2), [['Talla', 'S']])
    await talla(e, spid(2), [['Talla', 'M']])
    await talla(e, spid(3), [['Talla', 'S']], { sinCatalogo: true })
    await talla(e, spid(4), [
      ['A', '1'],
      ['B', '1'],
      ['C', '1'],
      ['D', '1'],
    ])

    const p1 = await listShopifyFamilyProposals(e.venueId, { limit: 2 })
    expect(p1.total).toBe(4)
    expect(p1.items.map(i => [i.shopifyProductId, i.mode])).toEqual([
      [spid(1), 'ADD'],
      [spid(2), 'CREATE'],
    ])
    expect(p1.items[0]).toMatchObject({
      groupId: familia.groupId,
      groupName: 'Playera',
      title: 'Playera',
      ready: true,
      blockedReason: null,
    })
    expect(p1.items[0].members).toHaveLength(1)
    expect(p1.items[1]).toMatchObject({ groupId: null, groupName: null, ready: true, blockedReason: null })
    expect(p1.items[1].members.map(m => m.name)).toEqual(['Playera · S', 'Playera · M'])
    expect(p1.nextCursor).toBe(spid(2))

    const p2 = await listShopifyFamilyProposals(e.venueId, { cursor: p1.nextCursor!, limit: 2 })
    expect(p2.total).toBe(4)
    expect(p2.items.map(i => i.shopifyProductId)).toEqual([spid(3), spid(4)])
    expect(p2.items[0]).toMatchObject({ mode: 'CREATE', ready: false, blockedReason: null, title: null })
    expect(p2.items[1]).toMatchObject({ ready: true, blockedReason: 'No se puede agrupar: Shopify trae más de 3 opciones.' })
    expect(p2.nextCursor).toBeNull()

    // El servidor pone el tope: pedir 500 da a lo más 50.
    expect((await listShopifyFamilyProposals(e.venueId, { limit: 500 })).items).toHaveLength(4)
  })

  it('CREATE: la vista previa trae nombre y opciones de Shopify y qué cambia', async () => {
    const e = await escenario()
    const otra = await otraCategoria(e)
    await talla(e, spid(1), [['Talla', 'S']], { title: 'Playera Lino' })
    const m = await talla(e, spid(1), [['Talla', 'M']], { title: 'Playera Lino' })
    await prisma.product.update({ where: { id: m }, data: { categoryId: otra.id, name: 'Lino M' } })
    const pv = await previewShopifyProposal(e.venueId, spid(1), {})
    expect(pv.mode).toBe('CREATE')
    expect(pv.groupId).toBeNull()
    expect(pv.parent.name).toBe('Playera Lino')
    expect(pv.parent.imageUrl).toBe('https://img.test/p.png') // la foto del producto de Shopify
    expect(pv.options).toEqual([{ name: 'Talla', values: ['S', 'M'] }])
    expect(pv.skipped).toEqual([])
    const mm = pv.members.find(x => x.productId === m)!
    expect(mm.newName).toBe('Playera Lino · M')
    expect(mm.changes).toEqual(expect.arrayContaining(['Nombre: «Lino M» → «Playera Lino · M»', 'Categoría: toma la del producto padre']))
    expect(pv.fingerprint).toEqual(expect.any(String))
  })

  it('un cuerpo con nombre u opciones inventados se ignora', async () => {
    const e = await escenario()
    await talla(e, spid(1), [['Talla', 'S']])
    await talla(e, spid(1), [['Talla', 'M']])
    const inventado = { name: 'Inventado', options: [{ name: 'Color', values: ['Rojo'] }], members: [] } as any
    const pv = await previewShopifyProposal(e.venueId, spid(1), inventado)
    expect(pv.parent.name).toBe('Playera')
    expect(pv.options).toEqual([{ name: 'Talla', values: ['S', 'M'] }])
    const r = await applyShopifyProposal(e.venueId, actor(e), spid(1), { ...inventado, expectedFingerprint: pv.fingerprint })
    const g = await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId }, include: { options: { include: { values: true } } } })
    expect(g.name).toBe('Playera')
    expect(g.options.map(o => o.name)).toEqual(['Talla'])
  })

  it('CREATE aplica conservando ids, SKU, precio; stock, movimientos y buzón sin cambio', async () => {
    const e = await escenario()
    const s = await talla(e, spid(1), [['Talla', 'S']], { stock: 7 })
    const m = await talla(e, spid(1), [['Talla', 'M']], { stock: 3 })
    // Una venta deja su fila en el buzón: agrupar no la toca.
    await prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE "productId" = ${s}`
    const antes = await Promise.all([s, m].map(intocable))
    expect(antes[0].buzon).toHaveLength(1)
    const productosAntes = await prisma.product.findMany({ where: { id: { in: [s, m] } }, orderBy: { id: 'asc' }, take: 2 })

    const r = await aplicar(e, spid(1))
    expect(r.mode).toBe('CREATE')
    expect(await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })).toMatchObject({
      source: 'SHOPIFY',
      externalId: spid(1),
      name: 'Playera',
      deletedAt: null,
    })
    const despues = await prisma.product.findMany({ where: { id: { in: [s, m] } }, orderBy: { id: 'asc' }, take: 2 })
    expect(despues.map(p => [p.id, p.sku, p.price.toString(), p.productGroupId])).toEqual(
      productosAntes.map(p => [p.id, p.sku, p.price.toString(), r.groupId]),
    )
    expect(await Promise.all([s, m].map(intocable))).toEqual(antes)
  })

  it('ADD suma la talla nueva y la familia conserva su categoría e IVA', async () => {
    const e = await escenario()
    await encenderIvaPorProducto(e.venueId)
    const otra = await otraCategoria(e)
    await talla(e, spid(1), [['Talla', 'S']])
    const r = await aplicar(e, spid(1))
    await updateProductGroup(e.venueId, r.groupId, { categoryId: otra.id }, actor(e))
    const m = await talla(e, spid(1), [['Talla', 'M']])
    await prisma.product.update({ where: { id: m }, data: { ivaTratamiento: 'IVA_8' } as any })

    const pv = await previewShopifyProposal(e.venueId, spid(1), {})
    expect(pv).toMatchObject({ mode: 'ADD', groupId: r.groupId, skipped: [] })
    expect(pv.parent).toMatchObject({ name: 'Playera', categoryId: otra.id, ivaTratamiento: 'IVA_16' })
    expect(pv.options).toEqual([{ name: 'Talla', values: ['S', 'M'] }])
    expect(pv.members).toEqual([
      expect.objectContaining({
        productId: m,
        newName: 'Playera · M',
        values: ['M'],
        changes: expect.arrayContaining(['Categoría: toma la del producto padre', expect.stringMatching(/^IVA: /)]),
      }),
    ])
    const r2 = await applyShopifyProposal(e.venueId, actor(e), spid(1), { expectedFingerprint: pv.fingerprint })
    expect(r2).toMatchObject({ mode: 'ADD', groupId: r.groupId, productIds: [m] })
    expect(await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })).toMatchObject({
      categoryId: otra.id,
      ivaTratamiento: 'IVA_16',
    })
    expect(await prisma.product.findUniqueOrThrow({ where: { id: m } })).toMatchObject({
      productGroupId: r.groupId,
      categoryId: otra.id,
      ivaTratamiento: 'IVA_16',
      name: 'Playera · M',
    })
  })

  it('ADD conserva Inventory, movimientos, buzón y parejas', async () => {
    const e = await escenario()
    await talla(e, spid(1), [['Talla', 'S']])
    await aplicar(e, spid(1))
    const m = await talla(e, spid(1), [['Talla', 'M']], { stock: 4 })
    await prisma.$executeRaw`UPDATE "Inventory" SET "currentStock" = "currentStock" - 1 WHERE "productId" = ${m}`
    const antes = await intocable(m)
    expect(antes.buzon).toHaveLength(1)
    expect((await aplicar(e, spid(1))).mode).toBe('ADD')
    expect(await intocable(m)).toEqual(antes)
  })

  it('ADD con M válida y S archivada ⇒ M entra, S sale en skipped con su motivo', async () => {
    const e = await escenario()
    const s = await talla(e, spid(1), [['Talla', 'S']])
    await talla(e, spid(1), [['Talla', 'XL']])
    const r = await aplicar(e, spid(1))
    await prisma.product.update({ where: { id: s }, data: { deletedAt: new Date(), active: false } })
    const s2 = await talla(e, spid(1), [['Talla', 'S']])
    const m = await talla(e, spid(1), [['Talla', 'M']])

    expect(await buildShopifyProposal(prisma, e.venueId, spid(1))).toMatchObject({
      mode: 'ADD',
      groupId: r.groupId,
      members: [{ productId: m, values: ['M'], ownImage: null }],
      skipped: [{ productId: s2, name: 'Playera · S', motivo: 'La combinación «S» ya existe, archivada.' }],
    })
    const pv = await previewShopifyProposal(e.venueId, spid(1), {})
    expect(pv.skipped).toEqual([{ productId: s2, name: 'Playera · S', motivo: 'La combinación «S» ya existe, archivada.' }])
    expect(pv.members.map(x => x.productId)).toEqual([m])
    await applyShopifyProposal(e.venueId, actor(e), spid(1), { expectedFingerprint: pv.fingerprint })
    expect((await prisma.product.findUniqueOrThrow({ where: { id: m } })).productGroupId).toBe(r.groupId)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: s2 } })).productGroupId).toBeNull()
  })

  it('🔴 agrupar mientras otra transacción tiene un producto con FOR KEY SHARE (como una venta) ⇒ la agrupación no se queda esperando: reintenta y responde PRODUCT_GROUP_BUSY, y la otra transacción termina sin abortar', async () => {
    const e = await escenario()
    // ADD de «Desde Shopify» (su propia transacción) ...
    await talla(e, spid(1), [['Talla', 'S']])
    await aplicar(e, spid(1))
    const m = await talla(e, spid(1), [['Talla', 'M']])
    // ... CREATE de «Desde Shopify» y el agrupar a mano del bloque 2 (los dos por applyGroupExisting).
    const c = await talla(e, spid(2), [['Talla', 'S']])
    const x = await agregarProductoShopify(e, { sku: `MANO-X-${Date.now()}`, pareja: false })
    const y = await agregarProductoShopify(e, { sku: `MANO-Y-${Date.now()}`, pareja: false })
    const manual = {
      name: `Mano ${Date.now()}`,
      options: [{ name: 'Talla', values: ['X', 'Y'] }],
      members: [
        { productId: x.productId, values: ['X'] },
        { productId: y.productId, values: ['Y'] },
      ],
    }
    const casos: Array<[string, () => Promise<unknown>]> = [
      [m, async () => aplicar(e, spid(1))],
      [c, async () => aplicar(e, spid(2))],
      [
        y.productId,
        async () =>
          applyGroupExisting(
            e.venueId,
            { ...manual, expectedFingerprint: (await previewGroupExisting(e.venueId, manual)).fingerprint },
            actor(e),
          ),
      ],
    ]
    for (const [productId, agrupar] of casos) {
      const venta = await retener(Prisma.sql`SELECT id FROM "Product" WHERE id = ${productId} FOR KEY SHARE`)
      const t0 = Date.now()
      await expect(agrupar()).rejects.toMatchObject({ statusCode: 409, code: 'PRODUCT_GROUP_BUSY', message: BUSY })
      expect(Date.now() - t0).toBeLessThan(10_000) // reintentó 3 veces y se rindió: nunca esperó a la venta
      venta.soltar()
      await expect(venta.fin).resolves.toBeUndefined() // la «venta» termina sin 40P01
      expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).productGroupId).toBeNull()
      // Sin la venta, la misma agrupación sí entra.
      await expect(agrupar()).resolves.toBeTruthy()
    }
  })

  it('renombrar una familia SHOPIFY al nombre de una MANUAL ⇒ permitido; crear una MANUAL con el nombre de otra MANUAL ⇒ 409', async () => {
    const e = await escenario()
    const una = { options: [{ name: 'Talla', values: ['U'] }], variants: [{ values: ['U'], price: 10 }] }
    await createProductWithVariants(e.venueId, { name: 'Gorra Uno', categoryId: e.categoryId, ...una }, actor(e))
    await talla(e, spid(1), [['Talla', 'S']], { title: 'Gorra Dos' })
    const r = await aplicar(e, spid(1))
    await updateProductGroup(e.venueId, r.groupId, { name: 'Gorra Uno' }, actor(e))
    expect((await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId } })).name).toBe('Gorra Uno')
    await expect(
      createProductWithVariants(e.venueId, { name: ' gorra uno ', categoryId: e.categoryId, ...una }, actor(e)),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PRODUCT_GROUP_NAME_TAKEN' })
    // Una familia SHOPIFY sólo aparta su llave: otra viva con el mismo producto de Shopify se rechaza.
    await expect(
      prisma.$transaction(tx =>
        createGroupTx(tx, e.venueId, {
          name: 'Cualquiera',
          categoryId: e.categoryId,
          type: 'REGULAR',
          imageUrl: null,
          ivaTratamiento: 'IVA_16',
          source: 'SHOPIFY',
          externalId: spid(1),
          options: [{ name: 'Talla', values: ['S'] }],
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PRODUCT_GROUP_IDENTITY_TAKEN' })
  })

  it('🔴 doble clic: la segunda confirmación con la misma huella ⇒ PRODUCT_GROUP_PREVIEW_STALE y sigue habiendo una familia (Review Focus 2)', async () => {
    const e = await escenario()
    await talla(e, spid(1), [['Talla', 'S']])
    await talla(e, spid(1), [['Talla', 'M']])
    const pv = await previewShopifyProposal(e.venueId, spid(1), {})
    const body = { expectedFingerprint: pv.fingerprint }
    await applyShopifyProposal(e.venueId, actor(e), spid(1), body)
    await expect(applyShopifyProposal(e.venueId, actor(e), spid(1), body)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PRODUCT_GROUP_PREVIEW_STALE',
    })
    expect(await prisma.productGroup.count({ where: { venueId: e.venueId, externalId: spid(1) } })).toBe(1)

    // A la vez: una gana, la otra recibe 409, y hay UNA familia.
    await talla(e, spid(2), [['Talla', 'S']])
    await talla(e, spid(2), [['Talla', 'M']])
    const pv2 = await previewShopifyProposal(e.venueId, spid(2), {})
    const dos = await Promise.allSettled(
      [1, 2].map(() => applyShopifyProposal(e.venueId, actor(e), spid(2), { expectedFingerprint: pv2.fingerprint })),
    )
    expect(dos.filter(d => d.status === 'fulfilled')).toHaveLength(1)
    expect(dos.find((d): d is PromiseRejectedResult => d.status === 'rejected')!.reason).toMatchObject({ statusCode: 409 })
    expect(await prisma.productGroup.count({ where: { venueId: e.venueId, externalId: spid(2) } })).toBe(1)
  })
})

describe('ronda final (A, B, H, I)', () => {
  it('🔴 A (caso IQ): familia MANUAL de S/M ligada por SKU + talla L nueva de Shopify ⇒ «Agregar a X» y al aplicar la familia queda de 3', async () => {
    const e = await escenario()
    const s = await talla(e, spid(1), [['Talla', 'S']])
    const m = await talla(e, spid(1), [['Talla', 'M']])
    const g = await familiaManual(e, 'Body Harbor', [
      [s, 'S'],
      [m, 'M'],
    ])
    const l = await talla(e, spid(1), [['Talla', 'L']])

    expect((await listShopifyFamilyProposals(e.venueId, {})).items).toEqual([
      expect.objectContaining({
        shopifyProductId: spid(1),
        mode: 'ADD',
        groupId: g,
        groupName: 'Body Harbor',
        ready: true,
        blockedReason: null,
      }),
    ])
    const pv = await previewShopifyProposal(e.venueId, spid(1), {})
    expect(pv).toMatchObject({ mode: 'ADD', groupId: g, skipped: [] })
    expect(pv.members.map(x => [x.productId, x.newName])).toEqual([[l, 'Body Harbor · L']])
    expect(await applyShopifyProposal(e.venueId, actor(e), spid(1), { expectedFingerprint: pv.fingerprint })).toMatchObject({
      mode: 'ADD',
      groupId: g,
      productIds: [l],
    })
    expect(await prisma.product.count({ where: { productGroupId: g, deletedAt: null } })).toBe(3)
    expect(await prisma.productGroup.count({ where: { venueId: e.venueId, deletedAt: null } })).toBe(1)
    expect(await prisma.productGroup.findUniqueOrThrow({ where: { id: g } })).toMatchObject({ source: 'MANUAL', externalId: null })
    // Repetir tras una respuesta perdida ⇒ «Ya estaba agrupada» con SU familia, no un error.
    expect(await applyShopifyProposalsBatch(e.venueId, actor(e), [{ shopifyProductId: spid(1), fingerprint: pv.fingerprint }])).toEqual({
      applied: [],
      skipped: [{ shopifyProductId: spid(1), motivo: 'Ya estaba agrupada', groupId: g }],
    })
  })

  it('A: las tallas de ese producto de Shopify en dos familias ⇒ bloqueada «…varias familias…»', async () => {
    const e = await escenario()
    const s = await talla(e, spid(1), [['Talla', 'S']])
    const m = await talla(e, spid(1), [['Talla', 'M']])
    await familiaManual(e, 'Una', [[s, 'S']])
    await familiaManual(e, 'Otra', [[m, 'M']])
    await talla(e, spid(1), [['Talla', 'L']])
    const motivo = 'Las tallas de este producto están en varias familias: agrúpalas a mano.'
    expect((await listShopifyFamilyProposals(e.venueId, {})).items).toEqual([
      expect.objectContaining({ shopifyProductId: spid(1), ready: true, blockedReason: motivo }),
    ])
    await expect(previewShopifyProposal(e.venueId, spid(1), {})).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHOPIFY_NO_AGRUPABLE',
      message: motivo,
    })
  })

  it('🔴 B: CREATE re-arma la propuesta dentro del candado: una talla que Shopify liga entre la vista previa y el candado ⇒ PRODUCT_GROUP_PREVIEW_STALE y nada se agrupa', async () => {
    const e = await escenario()
    const s = await talla(e, spid(1), [['Talla', 'S']])
    const m = await talla(e, spid(1), [['Talla', 'M']])
    const pv = await previewShopifyProposal(e.venueId, spid(1), {})
    const { organizationId } = await prisma.venue.findUniqueOrThrow({ where: { id: e.venueId }, select: { organizationId: true } })
    // El candado de IVA de la organización (el primero de la agrupación) lo tiene otro: aplicar arma su plan y se queda esperando.
    const otro = await retener(Prisma.sql`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR NO KEY UPDATE`)
    const aplicando = applyShopifyProposal(e.venueId, actor(e), spid(1), { expectedFingerprint: pv.fingerprint })
    aplicando.catch(() => undefined)
    // Hasta que aplicar se forma detrás del candado (su plan ya está armado, sin la talla nueva).
    for (let i = 0; i < 100; i++) {
      const [{ n: esperando }] = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
      if (esperando > 0) break
      await new Promise(r => setTimeout(r, 50))
    }
    const xl = await talla(e, spid(1), [['Talla', 'XL']]) // Shopify liga una talla nueva mientras tanto
    otro.soltar()
    await otro.fin
    await expect(aplicando).rejects.toMatchObject({ statusCode: 409, code: 'PRODUCT_GROUP_PREVIEW_STALE' })
    expect(await prisma.productGroup.count({ where: { venueId: e.venueId } })).toBe(0)
    const ps = await prisma.product.findMany({ where: { id: { in: [s, m, xl] } }, select: { productGroupId: true }, take: 3 })
    expect(ps.map(p => p.productGroupId)).toEqual([null, null, null])
  })

  it('H1: un shopifyCatalog mal formado cuenta como «no lista», no tira la página', async () => {
    const e = await escenario()
    const a = await talla(e, spid(1), [['Talla', 'S']])
    await prisma.shopifyVariantLink.update({
      where: { productId: a },
      data: { shopifyCatalog: { title: 'Playera', options: [{ name: 5, value: 'S' }], productImage: null, variantImage: null } },
    })
    const b = await talla(e, spid(2), [['Talla', 'S']])
    await prisma.shopifyVariantLink.update({
      where: { productId: b },
      data: { shopifyCatalog: { title: 123, options: [{ name: 'Talla', value: 'S' }], productImage: null, variantImage: null } },
    })
    const lista = await listShopifyFamilyProposals(e.venueId, {})
    expect(lista.items.map(i => [i.shopifyProductId, i.ready, i.blockedReason])).toEqual([
      [spid(1), false, null],
      [spid(2), false, null],
    ])
    await expect(previewShopifyProposal(e.venueId, spid(1), {})).rejects.toMatchObject({ code: 'SHOPIFY_DATOS_PENDIENTES' })
    expect((await previewAllShopifyProposals(e.venueId, {})).blocked).toHaveLength(2)
  })

  it('H2: un shopifyProductId repetido en un lote sale en skipped «Repetido en el lote»', async () => {
    const e = await escenario()
    await talla(e, spid(1), [['Talla', 'S']])
    const pv = await previewShopifyProposal(e.venueId, spid(1), {})
    const par = { shopifyProductId: spid(1), fingerprint: pv.fingerprint }
    const r = await applyShopifyProposalsBatch(e.venueId, actor(e), [par, par])
    expect(r.applied).toEqual([{ shopifyProductId: spid(1), groupId: expect.any(String), mode: 'CREATE' }])
    expect(r.skipped).toEqual([{ shopifyProductId: spid(1), motivo: 'Repetido en el lote' }])
  })

  it('🔴 I: vender de verdad 1 pieza de una talla AGRUPADA y ligada ⇒ su Inventory baja 1, su buzón lleva −1 y la familia no cambia', async () => {
    const e = await escenario()
    const s = await talla(e, spid(1), [['Talla', 'S']], { stock: 5 })
    await talla(e, spid(1), [['Talla', 'M']], { stock: 5 })
    const r = await aplicar(e, spid(1))
    const familiaAntes = await prisma.productGroup.findUniqueOrThrow({
      where: { id: r.groupId },
      include: { options: { include: { values: true } } },
    })
    const tallaAntes = await prisma.product.findUniqueOrThrow({ where: { id: s } })
    expect(await prisma.shopifyStockOutbox.count({ where: { productId: s } })).toBe(0)

    // El camino real de la venta (TPV, POS y ligas descuentan por aquí; guardia.integration «venta»).
    await deductInventoryForProduct(e.venueId, s, 1, `orden-${Date.now()}`)

    expect((await prisma.inventory.findUniqueOrThrow({ where: { productId: s } })).currentStock.toString()).toBe('4')
    expect((await prisma.shopifyStockOutbox.findMany({ where: { productId: s }, take: 5 })).map(f => f.delta.toString())).toEqual(['-1'])
    expect(
      await prisma.productGroup.findUniqueOrThrow({ where: { id: r.groupId }, include: { options: { include: { values: true } } } }),
    ).toEqual(familiaAntes)
    expect(await prisma.product.findUniqueOrThrow({ where: { id: s } })).toMatchObject({
      productGroupId: r.groupId,
      variantKey: tallaAntes.variantKey,
      name: tallaAntes.name,
    })
  })
})

describe('«Agrupar todas»', () => {
  const pares = (items: Array<{ shopifyProductId: string; preview: { fingerprint: string } }>) =>
    items.map(i => ({ shopifyProductId: i.shopifyProductId, fingerprint: i.preview.fingerprint }))

  it('🔴 apply-batch: 3 listas + 1 cuya categoría cambió entre la vista previa y el clic ⇒ 3 aplicadas y 1 saltada «Cambió desde que lo viste» (Review Focus 1)', async () => {
    const e = await escenario()
    const otra = await otraCategoria(e)
    const ultimas: string[] = []
    for (const k of [1, 2, 3, 4]) {
      await talla(e, spid(k), [['Talla', 'S']])
      ultimas.push(await talla(e, spid(k), [['Talla', 'M']]))
    }
    const todas = await previewAllShopifyProposals(e.venueId, {})
    expect(todas).toMatchObject({ total: 4, blocked: [], nextCursor: null })
    expect(todas.items.map(i => [i.shopifyProductId, i.mode, i.groupName])).toEqual([1, 2, 3, 4].map(k => [spid(k), 'CREATE', 'Playera']))
    expect(todas.items[0].preview.members.map(m => m.newName)).toEqual(['Playera · S', 'Playera · M'])
    await prisma.product.update({ where: { id: ultimas[3] }, data: { categoryId: otra.id } })

    const r = await applyShopifyProposalsBatch(e.venueId, actor(e), pares(todas.items))
    expect(r.applied).toEqual([1, 2, 3].map(k => ({ shopifyProductId: spid(k), groupId: expect.any(String), mode: 'CREATE' })))
    expect(r.skipped).toEqual([{ shopifyProductId: spid(4), motivo: 'Cambió desde que lo viste' }])
    expect(await prisma.productGroup.count({ where: { venueId: e.venueId, source: 'SHOPIFY' } })).toBe(3)
  })

  it('apply-batch repetido tras respuesta perdida ⇒ todas «Ya estaba agrupada», nada nuevo', async () => {
    const e = await escenario()
    for (const k of [1, 2]) await talla(e, spid(k), [['Talla', 'S']])
    const todas = await previewAllShopifyProposals(e.venueId, {})
    const primera = await applyShopifyProposalsBatch(e.venueId, actor(e), pares(todas.items))
    expect(primera.applied).toHaveLength(2)
    const otraVez = await applyShopifyProposalsBatch(e.venueId, actor(e), pares(todas.items))
    expect(otraVez.applied).toEqual([])
    expect(otraVez.skipped).toEqual(
      primera.applied.map(a => ({ shopifyProductId: a.shopifyProductId, motivo: 'Ya estaba agrupada', groupId: a.groupId })),
    )
    expect(await prisma.productGroup.count({ where: { venueId: e.venueId } })).toBe(2)
  })

  it('30 propuestas en dos páginas y dos lotes ⇒ 30 aplicadas', async () => {
    const e = await escenario()
    for (let k = 1; k <= 30; k++) await talla(e, spid(k), [['Talla', 'S']])
    const p1 = await previewAllShopifyProposals(e.venueId, {})
    expect(p1.items).toHaveLength(25)
    expect(p1).toMatchObject({ total: 30, nextCursor: spid(25) })
    const p2 = await previewAllShopifyProposals(e.venueId, { cursor: p1.nextCursor! })
    expect(p2.items).toHaveLength(5)
    expect(p2.nextCursor).toBeNull()
    // Lotes de a lo más 25.
    await expect(applyShopifyProposalsBatch(e.venueId, actor(e), [...pares(p1.items), ...pares(p2.items)])).rejects.toMatchObject({
      statusCode: 400,
    })
    const r1 = await applyShopifyProposalsBatch(e.venueId, actor(e), pares(p1.items))
    const r2 = await applyShopifyProposalsBatch(e.venueId, actor(e), pares(p2.items))
    expect(r1.applied.length + r2.applied.length).toBe(30)
    expect([...r1.skipped, ...r2.skipped]).toEqual([])
    expect(await prisma.productGroup.count({ where: { venueId: e.venueId, source: 'SHOPIFY', deletedAt: null } })).toBe(30)
  })

  it('una página con todas bloqueadas o saltadas ⇒ el cursor avanza a la siguiente', async () => {
    const e = await escenario()
    await talla(e, spid(1), [['Talla', 'S']], { sinCatalogo: true })
    await talla(e, spid(2), [
      ['A', '1'],
      ['B', '1'],
      ['C', '1'],
      ['D', '1'],
    ])
    await talla(e, spid(3), [['Talla', 'S']])
    const p1 = await previewAllShopifyProposals(e.venueId, { limit: 2 })
    expect(p1.items).toEqual([])
    expect(p1.blocked).toEqual([
      { shopifyProductId: spid(1), motivo: 'Este producto se completa en la próxima sincronización con Shopify.' },
      { shopifyProductId: spid(2), motivo: 'No se puede agrupar: Shopify trae más de 3 opciones.' },
    ])
    expect(p1).toMatchObject({ total: 3, nextCursor: spid(2) })
    const p2 = await previewAllShopifyProposals(e.venueId, { cursor: p1.nextCursor!, limit: 2 })
    expect(p2.items.map(i => i.shopifyProductId)).toEqual([spid(3)])
    // Una bloqueada mandada a aplicar se salta con su motivo.
    const r = await applyShopifyProposalsBatch(e.venueId, actor(e), [{ shopifyProductId: spid(1), fingerprint: 'x' }])
    expect(r.skipped).toEqual([
      { shopifyProductId: spid(1), motivo: 'Este producto se completa en la próxima sincronización con Shopify.' },
    ])
  })
})

describe('«Agregar a X»: los valores se acomodan por nombre de opción', () => {
  it('ADD con opciones reordenadas en Shopify (Color × Talla) ⇒ valores bien acomodados por nombre', async () => {
    const e = await escenario()
    await talla(e, spid(1), [
      ['Talla', 'S'],
      ['Color', 'Rojo'],
    ])
    const r = await aplicar(e, spid(1))
    const b = await talla(e, spid(1), [
      ['color', 'Azul'],
      ['Talla', 'M'],
    ])
    expect(await buildShopifyProposal(prisma, e.venueId, spid(1))).toMatchObject({
      mode: 'ADD',
      members: [{ productId: b, values: ['M', 'Azul'] }],
      skipped: [],
    })
    await aplicar(e, spid(1))
    expect(await prisma.product.findUniqueOrThrow({ where: { id: b } })).toMatchObject({
      productGroupId: r.groupId,
      name: 'Playera · M · Azul',
    })
  })

  it('ADD con un eje cambiado ⇒ bloqueada con su motivo', async () => {
    const e = await escenario()
    await talla(e, spid(1), [
      ['Talla', 'S'],
      ['Color', 'Rojo'],
    ])
    await aplicar(e, spid(1))
    await talla(e, spid(1), [
      ['Talla', 'M'],
      ['Material', 'Algodón'],
    ])
    const motivo = 'Las opciones de Shopify ya no coinciden con la familia «Playera»'
    expect((await listShopifyFamilyProposals(e.venueId, {})).items).toEqual([
      expect.objectContaining({ shopifyProductId: spid(1), mode: 'ADD', ready: true, blockedReason: motivo }),
    ])
    await expect(buildShopifyProposal(prisma, e.venueId, spid(1))).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHOPIFY_NO_AGRUPABLE',
      message: motivo,
    })
  })

  it('familia con 249 vivas + 2 tallas nuevas ⇒ ADD bloqueada por cupo', async () => {
    const e = await escenario()
    await talla(e, spid(1), [['Talla', 'S']])
    const r = await aplicar(e, spid(1))
    await prisma.$transaction(async tx => {
      await markProductGroupWriter(tx)
      await tx.product.createMany({
        data: Array.from({ length: 248 }, (_x, i) => ({
          venueId: e.venueId,
          categoryId: e.categoryId,
          name: `Relleno ${i}`,
          sku: `RELLENO-${i}-${Date.now()}`,
          price: 1,
          productGroupId: r.groupId,
          variantKey: `relleno-${i}`,
        })),
      })
    })
    expect(await prisma.product.count({ where: { productGroupId: r.groupId, deletedAt: null } })).toBe(249)
    await talla(e, spid(1), [['Talla', 'M']])
    await talla(e, spid(1), [['Talla', 'L']])
    const motivo = 'No se puede agrupar: «Playera» ya tiene 249 tallas y el máximo es 250.'
    expect((await listShopifyFamilyProposals(e.venueId, {})).items[0]).toMatchObject({ mode: 'ADD', blockedReason: motivo })
    await expect(buildShopifyProposal(prisma, e.venueId, spid(1))).rejects.toMatchObject({ code: 'SHOPIFY_NO_AGRUPABLE', message: motivo })
  })
})

describe('sucursales, deshacer y agrupar a mano', () => {
  it('dos sucursales ligadas a la misma tienda: cada una ve sólo sus propuestas y arma su propia familia', async () => {
    const e = await escenario()
    const s = await otraSucursalDeLaTienda(e)
    sucursales.push(s)
    await sinTallas(s)
    await talla(e, spid(1), [['Talla', 'S']])
    await talla(e, spid(1), [['Talla', 'M']])
    const suya = await talla(s, spid(1), [['Talla', 'S']])
    expect((await listShopifyFamilyProposals(e.venueId, {})).items.map(i => i.members.length)).toEqual([2])
    expect((await listShopifyFamilyProposals(s.venueId, {})).items.map(i => i.members.map(m => m.productId))).toEqual([[suya]])
    const de1 = await aplicar(e, spid(1))
    const de2 = await aplicar(s, spid(1))
    expect(de1.groupId).not.toBe(de2.groupId)
    expect(await prisma.productGroup.findUniqueOrThrow({ where: { id: de2.groupId } })).toMatchObject({
      venueId: s.venueId,
      externalId: spid(1),
    })
    expect(await prisma.product.count({ where: { productGroupId: de1.groupId, venueId: e.venueId } })).toBe(2)
    expect(await prisma.product.count({ where: { productGroupId: de2.groupId, venueId: s.venueId } })).toBe(1)
  })

  it('deshacer una familia SHOPIFY y volver a agruparla ⇒ sin P2002', async () => {
    const e = await escenario()
    await talla(e, spid(1), [['Talla', 'S']])
    await talla(e, spid(1), [['Talla', 'M']])
    const r = await aplicar(e, spid(1))
    await ungroupProductGroup(e.venueId, r.groupId, actor(e))
    const otra = await aplicar(e, spid(1))
    expect(otra.mode).toBe('CREATE')
    expect(otra.groupId).not.toBe(r.groupId)
    expect(await prisma.productGroup.count({ where: { venueId: e.venueId, externalId: spid(1) } })).toBe(2)
    expect(await prisma.productGroup.count({ where: { venueId: e.venueId, externalId: spid(1), deletedAt: null } })).toBe(1)
  })

  it('palomear a mano un producto ligado ⇒ 409 «Desde Shopify»', async () => {
    const e = await escenario()
    const ligado = await talla(e, spid(1), [['Talla', 'S']])
    const suelto = await agregarProductoShopify(e, { sku: `SUELTO-${Date.now()}`, pareja: false })
    await expect(
      previewGroupExisting(e.venueId, {
        name: 'Camisa',
        options: [{ name: 'Talla', values: ['S', 'L'] }],
        members: [
          { productId: ligado, values: ['S'] },
          { productId: suelto.productId, values: ['L'] },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('se agrupa desde la pestaña Desde Shopify') })
  })
})

describe('por HTTP (rutas, permiso y plan)', () => {
  let server: Server
  beforeAll(async () => {
    const app = (await import('@/app')).default
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(listo => server.once('listening', () => listo()))
  })
  afterAll(async () => {
    await new Promise<void>(listo => server.close(() => listo()))
  })
  const token = (e: EscenarioShopify) =>
    jwt.sign({ sub: e.staffId, orgId: e.organizationId, venueId: e.venueId, role: 'ADMIN' }, process.env.ACCESS_TOKEN_SECRET as string, {
      expiresIn: '15m',
    })
  const ruta = (e: EscenarioShopify, r: string) => `/api/v1/dashboard/venues/${e.venueId}/product-groups${r}`

  it('sin PRODUCT_VARIANTS ⇒ 403 del plan; con la función, la lista, la vista previa y aplicar responden', async () => {
    const e = await escenario()
    await talla(e, spid(1), [['Talla', 'S']])
    const auth = { Authorization: `Bearer ${token(e)}` }
    const sinPlan = await request(server).get(ruta(e, '/shopify-proposals')).set(auth)
    expect(sinPlan.status).toBe(403)

    await prisma.venue.update({ where: { id: e.venueId }, data: { seatCapExempt: true } }) // negocio con todo el catálogo de funciones
    const lista = await request(server).get(ruta(e, '/shopify-proposals?limit=10')).set(auth)
    expect(lista.status).toBe(200)
    expect(lista.body.data).toMatchObject({ total: 1, items: [{ shopifyProductId: spid(1), mode: 'CREATE' }] })

    const id = encodeURIComponent(spid(1))
    expect((await request(server).post(ruta(e, '/shopify-proposals/abc/preview')).set(auth).send({})).status).toBe(400)
    const pv = await request(server)
      .post(ruta(e, `/shopify-proposals/${id}/preview`))
      .set(auth)
      .send({})
    expect(pv.status).toBe(200)
    const ap = await request(server)
      .post(ruta(e, `/shopify-proposals/${id}/apply`))
      .set(auth)
      .send({ expectedFingerprint: pv.body.data.fingerprint })
    expect(ap.status).toBe(201)
    expect(ap.body.data).toMatchObject({ mode: 'CREATE', groupId: expect.any(String) })

    const todas = await request(server).post(ruta(e, '/shopify-proposals/preview-all')).set(auth).send({})
    expect(todas.status).toBe(200)
    expect(todas.body.data).toMatchObject({ items: [], total: 0 })
    const lote = await request(server)
      .post(ruta(e, '/shopify-proposals/apply-batch'))
      .set(auth)
      .send({ items: [{ shopifyProductId: spid(1), fingerprint: pv.body.data.fingerprint }] })
    expect(lote.status).toBe(200)
    expect(lote.body.data.skipped).toEqual([{ shopifyProductId: spid(1), motivo: 'Ya estaba agrupada', groupId: ap.body.data.groupId }])
  })
})
