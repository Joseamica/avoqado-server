/**
 * IVA por producto, plan 5 — «Reemplazar menú» ARCHIVA lo que el archivo no trae (D2) y cuida sus categorías (D4); el SKU
 * de un archivado que regresa restaura el MISMO producto (D3, opción A del founder, Tarea 4). Contra Postgres REAL (H1),
 * negocio NUEVO por caso. El actor es SERVICE (sin Staff que crear): `deletedBy` del reemplazo queda en null.
 */
import { Prisma, PrismaClient } from '@prisma/client'

import { getIncomeStatement } from '@/services/dashboard/accounting.dashboard.service'
import { getMenus, importMenu } from '@/services/dashboard/menu.dashboard.service'
import { getPaymentLinkByShortCode } from '@/services/dashboard/paymentLink.service'
import { deleteProduct } from '@/services/dashboard/product.dashboard.service'
import { cleanDemoData } from '@/services/onboarding/demoCleanup.service'
import prisma from '@/utils/prismaClient'
import {
  conProducto,
  desenlace,
  hastaQue,
  limpiarNegocios,
  nuevoNegocio,
  retener,
  type Negocio,
} from '../fiscal/exclusionContable.fixtures'

jest.setTimeout(120_000)

const SERVICIO = { type: 'SERVICE' as const, servicePrincipalId: 'PLAN5_PRUEBA' }
const CUANDO = new Date('2026-06-15T18:00:00.000Z') // 12:00 en la Ciudad de México: dentro de junio de 2026
const JUNIO = { from: '2026-06-01', to: '2026-06-30' }
const usados: Negocio[] = []
const personal: string[] = []
// C5-1: otra transacción (la liga que se guarda) y quien mira pg_stat_activity, cada una con su propia conexión.
const bloqueador = new PrismaClient()
const observador = new PrismaClient()

async function negocio() {
  const x = await nuevoNegocio({ contabilidad: false })
  usados.push(x)
  return x
}

/** Una venta cobrada con tarjeta en CUANDO: un renglón del producto, sin sellar. Devuelve el id del renglón. */
async function venta(x: Negocio, productId: string, precio: string): Promise<string> {
  const o = await prisma.order.create({
    data: {
      venueId: x.venueId,
      orderNumber: `P5-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      subtotal: 0,
      taxAmount: 0,
      total: 0,
    },
  })
  const item = await prisma.orderItem.create({
    data: {
      orderId: o.id,
      productId,
      productName: 'Producto',
      quantity: 1,
      unitPrice: new Prisma.Decimal(precio),
      taxAmount: 0,
      total: new Prisma.Decimal(precio),
    },
  })
  await prisma.payment.create({
    data: {
      venueId: x.venueId,
      orderId: o.id,
      createdAt: CUANDO,
      amount: new Prisma.Decimal(precio),
      tipAmount: 0,
      netAmount: new Prisma.Decimal(precio),
      method: 'CREDIT_CARD',
      status: 'COMPLETED',
      type: 'REGULAR',
      splitType: 'FULLPAYMENT',
      source: 'TPV',
      feePercentage: 0,
      feeAmount: 0,
    },
  })
  return item.id
}

/** Un archivo de UNA categoría con productos [nombre, sku, precio]. */
const archivo = (mode: 'merge' | 'replace', name: string, slug: string, productos: Array<[string, string, number]>) => ({
  mode,
  categories: [{ name, slug, products: productos.map(([nombre, sku, price]) => ({ name: nombre, sku, price })) }],
})

/** Lo que muestra el menú del dashboard (y de /tpv): categoría → ids de productos, ordenados. */
async function vistos(venueId: string) {
  const menus = (await getMenus(venueId)) as unknown as Array<{
    categories: Array<{ category: { id: string; products: Array<{ id: string }> } }>
  }>
  return menus.flatMap(m => m.categories.map(c => ({ categoria: c.category.id, productos: c.category.products.map(p => p.id).sort() })))
}

/** Una liga de pago VIVA `purpose: 'ITEM'` (el default es PAYMENT) con un renglón del producto y, si se pide, un EXTRA PAGADO. Devuelve su código. */
async function ligaDePago(x: Negocio, productId: string, modifierId?: string): Promise<string> {
  const proveedor = await prisma.paymentProvider.upsert({
    where: { code: 'PLAN5_PRUEBA' },
    create: { code: 'PLAN5_PRUEBA', name: 'Plan 5 (prueba)', type: 'PAYMENT_PROCESSOR' },
    update: {},
  })
  const etiqueta = x.rfc.toLowerCase()
  const staff = await prisma.staff.create({ data: { email: `plan5-${etiqueta}@example.test`, firstName: 'Plan', lastName: 'Cinco' } })
  personal.push(staff.id)
  const comercio = await prisma.ecommerceMerchant.create({
    data: {
      venueId: x.venueId,
      businessName: 'Plan 5',
      contactEmail: `plan5-comercio-${etiqueta}@example.test`,
      publicKey: `pk_test_plan5_${etiqueta}`,
      secretKeyHash: `plan5-${etiqueta}`,
      providerId: proveedor.id,
      providerCredentials: {},
    },
  })
  const liga = await prisma.paymentLink.create({
    data: {
      shortCode: etiqueta.slice(-8),
      venueId: x.venueId,
      ecommerceMerchantId: comercio.id,
      createdById: staff.id,
      purpose: 'ITEM',
      title: 'Liga viva',
      amountType: 'FIXED',
      amount: 70,
      items: { create: [{ productId, modifiers: modifierId ? { create: [{ modifierId, quantity: 1 }] } : undefined }] },
    },
  })
  return liga.shortCode
}

/** Lo que cobra una liga `ITEM`: Σ cantidad × (precio + Σ extra × cantidad), la misma cuenta que `computeBundleTotal`. */
const totalDeLiga = (liga: Awaited<ReturnType<typeof getPaymentLinkByShortCode>>) =>
  liga.items.reduce(
    (suma, it) =>
      suma + (Number(it.product.price) + it.modifiers.reduce((m, mm) => m + Number(mm.modifier.price) * mm.quantity, 0)) * it.quantity,
    0,
  )

afterAll(async () => {
  const venues = usados.map(x => x.venueId)
  // Antes que limpiarNegocios: CreditPackItem → Product es RESTRICT; PaymentLink → EcommerceMerchant y → Staff también.
  await prisma.paymentLink.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.ecommerceMerchant.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.staff.deleteMany({ where: { id: { in: personal } } })
  await prisma.paymentProvider.deleteMany({ where: { code: 'PLAN5_PRUEBA' } })
  await prisma.creditPack.deleteMany({ where: { venueId: { in: venues } } })
  await limpiarNegocios()
  await Promise.all([bloqueador.$disconnect(), observador.$disconnect()])
})

describe('D2 · «Reemplazar» archiva lo que no viene: la historia y su IVA no se mueven', () => {
  it('el producto al 0 % con ventas sin facturar queda ARCHIVADO, su renglón conserva el producto y el estado de resultados no cambia', async () => {
    const x = await negocio()
    const { categoryId, productId: cafe } = await conProducto(x) // bandera ENCENDIDA: el grano puede ir al 0 %
    const grano = (
      await prisma.product.create({
        data: { venueId: x.venueId, categoryId, sku: `GRANO-${x.rfc}`, name: 'Grano', price: 100, ivaTratamiento: 'IVA_0' },
      })
    ).id
    const renglon = await venta(x, grano, '100.00')
    await venta(x, cafe, '116.00')
    const antes = await getIncomeStatement(x.venueId, JUNIO)
    expect(antes.revenue.tasa0BaseCents).toBe(10000) // la prueba sólo vale si el grano cuenta al 0 %

    const r = await importMenu(x.venueId, archivo('replace', 'IVA', `iva-${x.rfc}`.toLowerCase(), [['Café', `P-${x.rfc}`, 116]]), SERVICIO)

    expect(r.stats).toMatchObject({ productsArchived: 1 })
    expect(
      await prisma.product.findUniqueOrThrow({
        where: { id: grano },
        select: { deletedAt: true, deletedBy: true, active: true, ivaTratamiento: true },
      }),
    ).toEqual({ deletedAt: expect.any(Date), deletedBy: null, active: false, ivaTratamiento: 'IVA_0' })
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: renglon } })).productId).toBe(grano)
    expect(await getIncomeStatement(x.venueId, JUNIO)).toEqual(antes)
  })

  it('receta VARIABLE, inventario y kárdex siguen; la liga viva cobra LO MISMO con su extra; un paquete de créditos (RESTRICT) ya no tumba el reemplazo', async () => {
    const x = await negocio()
    const { categoryId } = await conProducto(x)
    const te = (await prisma.product.create({ data: { venueId: x.venueId, categoryId, sku: `TE-${x.rfc}`, name: 'Té', price: 50 } })).id
    const insumo = (name: string, sku: string, unit: 'GRAM' | 'LITER', unitType: 'WEIGHT' | 'VOLUME') =>
      prisma.rawMaterial.create({
        data: {
          venueId: x.venueId,
          name,
          sku: `${sku}-${x.rfc}`,
          currentStock: 10,
          unit,
          unitType,
          minimumStock: 0,
          reorderPoint: 0,
          costPerUnit: 1,
          avgCostPerUnit: 1,
        },
      })
    const hojas = await insumo('Té negro', 'HOJAS', 'GRAM', 'WEIGHT')
    const leche = await insumo('Leche entera', 'LECHE', 'LITER', 'VOLUME')
    // Receta variable REAL: la leche se sustituye con un extra del grupo «Leche» (P5-R15: la receta usa el grupo).
    const grupoLeche = await prisma.modifierGroup.create({
      data: { venueId: x.venueId, name: 'Leche', modifiers: { create: [{ name: 'Avena', price: 15 }] } },
    })
    const receta = await prisma.recipe.create({
      data: {
        productId: te,
        totalCost: 10,
        lines: {
          create: [
            { rawMaterialId: hojas.id, quantity: 5, unit: 'GRAM' },
            { rawMaterialId: leche.id, quantity: 0.2, unit: 'LITER', isVariable: true, linkedModifierGroupId: grupoLeche.id },
          ],
        },
      },
    })
    // Un extra PAGADO en la liga viva, de otro grupo (P5-R15: la liga usa el grupo). Y un grupo que nadie usa.
    const grupoExtras = await prisma.modifierGroup.create({
      data: { venueId: x.venueId, name: 'Extras', modifiers: { create: [{ name: 'Shot', price: 20 }] } },
    })
    const shot = await prisma.modifier.findFirstOrThrow({ where: { groupId: grupoExtras.id } })
    await prisma.modifierGroup.create({
      data: { venueId: x.venueId, name: 'Salsas', modifiers: { create: [{ name: 'Chipotle', price: 5 }] } },
    })
    const inventario = await prisma.inventory.create({ data: { productId: te, venueId: x.venueId, currentStock: 7 } })
    const movimiento = await prisma.inventoryMovement.create({
      data: { inventoryId: inventario.id, type: 'ADJUSTMENT', quantity: 7, previousStock: 0, newStock: 7 },
    })
    const paquete = await prisma.creditPack.create({
      data: { venueId: x.venueId, name: 'Diez tés', price: 400, items: { create: [{ productId: te, quantity: 10 }] } },
    })
    const corto = await ligaDePago(x, te, shot.id)
    const ligaAntes = await getPaymentLinkByShortCode(corto)
    expect(totalDeLiga(ligaAntes)).toBe(70) // la prueba sólo vale con el extra de $20 dentro

    await expect(
      importMenu(x.venueId, archivo('replace', 'IVA', `iva-${x.rfc}`.toLowerCase(), [['Café', `P-${x.rfc}`, 116]]), SERVICIO),
    ).resolves.toMatchObject({ stats: { productsArchived: 1 } })

    expect(await getPaymentLinkByShortCode(corto)).toEqual(ligaAntes) // mismo renglón, mismo extra, mismo cobro
    expect(await prisma.recipeLine.count({ where: { recipeId: receta.id } })).toBe(2)
    expect(
      (await prisma.recipeLine.findFirstOrThrow({ where: { recipeId: receta.id, rawMaterialId: leche.id } })).linkedModifierGroupId,
    ).toBe(grupoLeche.id)
    // Los dos que algo usa quedan APAGADOS con sus extras; «Salsas», que nadie usa, se borró como hoy.
    expect(
      await prisma.modifierGroup.findMany({
        where: { venueId: x.venueId },
        select: { name: true, active: true },
        orderBy: { name: 'asc' },
      }),
    ).toEqual([
      { name: 'Extras', active: false },
      { name: 'Leche', active: false },
    ])
    expect(await prisma.modifier.findUniqueOrThrow({ where: { id: shot.id }, select: { active: true } })).toEqual({ active: false })
    expect(Number((await prisma.inventory.findUniqueOrThrow({ where: { id: inventario.id } })).currentStock)).toBe(7)
    expect(await prisma.inventoryMovement.findUnique({ where: { id: movimiento.id } })).not.toBeNull()
    expect(await prisma.creditPackItem.count({ where: { creditPackId: paquete.id, productId: te } })).toBe(1)
  })
})

describe('D4 · categorías del reemplazo (Review Focus 1 y 2)', () => {
  it('sin productos se borra; con archivados se apaga; la que el archivo trae —por slug y repetida por nombre— se enciende UNA vez y vuelve al menú con sus vigentes', async () => {
    const x = await negocio()
    const categoria = (name: string, slug: string) =>
      prisma.menuCategory.create({ data: { venueId: x.venueId, name, slug: `${slug}-${x.rfc}`.toLowerCase() } })
    const bebidas = await categoria('Bebidas', 'bebidas')
    const postres = await categoria('Postres', 'postres')
    const vacia = await categoria('Vacía', 'vacia')
    const prod = async (categoryId: string, name: string) =>
      (await prisma.product.create({ data: { venueId: x.venueId, categoryId, sku: `${name}-${x.rfc}`, name, price: 50 } })).id
    const agua = await prod(bebidas.id, 'Agua') // no viene: se archiva
    const cafe = await prod(bebidas.id, 'Cafe') // viene
    await prod(postres.id, 'Pay') // no viene: se archiva y su categoría se apaga

    await importMenu(
      x.venueId,
      {
        mode: 'replace',
        categories: [
          // Otro nombre, el MISMO slug que «Bebidas»: se reutiliza por slug.
          {
            name: 'BEBIDAS',
            slug: bebidas.slug,
            products: [
              { name: 'Café', sku: `Cafe-${x.rfc}`, price: 55 },
              { name: 'Té', sku: `Te-${x.rfc}`, price: 40 },
            ],
          },
          // La misma categoría otra vez, por su nombre: ni otra categoría ni otra asignación.
          { name: 'Bebidas', slug: `otra-${x.rfc}`.toLowerCase(), products: [] },
        ],
      },
      SERVICIO,
    )

    const te = (await prisma.product.findFirstOrThrow({ where: { venueId: x.venueId, sku: `Te-${x.rfc}` } })).id
    expect(await prisma.menuCategory.findUnique({ where: { id: vacia.id } })).toBeNull()
    expect(await prisma.menuCategory.findUniqueOrThrow({ where: { id: postres.id } })).toMatchObject({ active: false })
    expect(await prisma.menuCategory.findUniqueOrThrow({ where: { id: bebidas.id } })).toMatchObject({ active: true, name: 'Bebidas' })
    expect(await prisma.menuCategory.count({ where: { venueId: x.venueId } })).toBe(2)
    expect((await prisma.product.findUniqueOrThrow({ where: { id: agua } })).deletedAt).not.toBeNull()
    expect(await vistos(x.venueId)).toEqual([{ categoria: bebidas.id, productos: [cafe, te].sort() }])
  })
})

describe('D3 · el SKU de un archivado que regresa restaura el MISMO producto', () => {
  it('«Reemplazar»: regresa con su id, su receta, su inventario, su kárdex y su IVA, y vuelve a los menús', async () => {
    const x = await negocio()
    const { categoryId } = await conProducto(x)
    const grano = (
      await prisma.product.create({
        data: { venueId: x.venueId, categoryId, sku: `GRANO-${x.rfc}`, name: 'Grano', price: 100, ivaTratamiento: 'IVA_0' },
      })
    ).id
    const receta = await prisma.recipe.create({ data: { productId: grano, totalCost: 10 } })
    const inventario = await prisma.inventory.create({ data: { productId: grano, venueId: x.venueId, currentStock: 7 } })
    const movimiento = await prisma.inventoryMovement.create({
      data: { inventoryId: inventario.id, type: 'ADJUSTMENT', quantity: 7, previousStock: 0, newStock: 7 },
    })
    const slug = `iva-${x.rfc}`.toLowerCase()
    await importMenu(x.venueId, archivo('replace', 'IVA', slug, [['Café', `P-${x.rfc}`, 116]]), SERVICIO) // el grano se archiva

    const r = await importMenu(
      x.venueId,
      archivo('replace', 'IVA', slug, [
        ['Café', `P-${x.rfc}`, 116],
        ['Grano', `GRANO-${x.rfc}`, 120],
      ]),
      SERVICIO,
    )

    expect(r.stats).toMatchObject({ productsRestored: 1, productsArchived: 0 })
    expect(await prisma.product.count({ where: { venueId: x.venueId, sku: `GRANO-${x.rfc}` } })).toBe(1)
    expect(
      await prisma.product.findUniqueOrThrow({
        where: { id: grano },
        select: { deletedAt: true, deletedBy: true, active: true, ivaTratamiento: true },
      }),
    ).toEqual({ deletedAt: null, deletedBy: null, active: true, ivaTratamiento: 'IVA_0' })
    expect(await prisma.recipe.findUnique({ where: { id: receta.id } })).not.toBeNull()
    expect(Number((await prisma.inventory.findUniqueOrThrow({ where: { id: inventario.id } })).currentStock)).toBe(7)
    expect(await prisma.inventoryMovement.findUnique({ where: { id: movimiento.id } })).not.toBeNull()
    expect((await vistos(x.venueId)).flatMap(v => v.productos)).toContain(grano)
  })

  it('«Combinar» (Review Focus 3): un producto borrado desde el dashboard regresa — antes se actualizaba y seguía invisible', async () => {
    const x = await negocio()
    const { productId: cafe } = await conProducto(x)
    await deleteProduct(x.venueId, cafe, 'staff-plan5')

    const r = await importMenu(x.venueId, archivo('merge', 'IVA', `iva-${x.rfc}`.toLowerCase(), [['Café', `P-${x.rfc}`, 120]]), SERVICIO)

    expect(r.stats).toMatchObject({ productsRestored: 1 })
    expect(await prisma.product.count({ where: { venueId: x.venueId, sku: `P-${x.rfc}` } })).toBe(1)
    // Vuelve a las listas (dashboard, TPV, móvil: filtran deletedAt y active). Los menús no se afirman aquí: «Combinar» no
    // asigna una categoría vigente ya existente, y conProducto no crea menú; la vuelta al menú la prueba el caso de «Reemplazar».
    const p = await prisma.product.findUniqueOrThrow({ where: { id: cafe } })
    expect(p).toMatchObject({ deletedAt: null, deletedBy: null, active: true })
    expect(Number(p.price)).toBe(120)
  })
})

describe('C5-1 · una liga que se guarda MIENTRAS «Reemplazar» corre no pierde su extra', () => {
  it('el reemplazo espera al extra que la liga está insertando; al confirmarse, el extra sigue y la liga cobra lo mismo', async () => {
    const x = await negocio()
    const { categoryId } = await conProducto(x)
    const te = (await prisma.product.create({ data: { venueId: x.venueId, categoryId, sku: `TE-${x.rfc}`, name: 'Té', price: 50 } })).id
    const grupo = await prisma.modifierGroup.create({
      data: { venueId: x.venueId, name: 'Extras', modifiers: { create: [{ name: 'Shot', price: 20 }] } },
    })
    const shot = await prisma.modifier.findFirstOrThrow({ where: { groupId: grupo.id } })
    // La liga viva existe SIN extra: nadie usa «Extras» todavía, así que una lectura sin candado lo tomaría por borrable.
    const corto = await ligaDePago(x, te)
    const { id: renglon } = await prisma.paymentLinkItem.findFirstOrThrow({ where: { paymentLink: { shortCode: corto } } })

    // Otra petición guarda la liga con el extra de $20 y todavía no confirma.
    const liga = await retener(
      bloqueador,
      tx => tx.paymentLinkItemModifier.create({ data: { paymentLinkItemId: renglon, modifierId: shot.id, quantity: 1 } }),
      { confirmar: true },
    )
    let reemplazo: Promise<unknown> = Promise.resolve()
    try {
      reemplazo = desenlace(
        importMenu(x.venueId, archivo('replace', 'IVA', `iva-${x.rfc}`.toLowerCase(), [['Café', `P-${x.rfc}`, 116]]), SERVICIO),
      )
      const pid = await hastaQue(
        observador,
        'el reemplazo espera al extra que la liga está guardando',
        20_000,
        Prisma.sql`SELECT a.pid FROM pg_stat_activity a
          WHERE a.datname = current_database() AND a.wait_event_type = 'Lock'
            AND ${liga.pid}::int = ANY(pg_blocking_pids(a.pid)) AND a.query LIKE '%Modifier%'
          LIMIT 1`,
      )
      const [espera] = await observador.$queryRaw<Array<Record<string, unknown>>>`
        SELECT pid, wait_event_type, wait_event, state, pg_blocking_pids(pid) AS bloqueado_por, left(query, 200) AS query
        FROM pg_stat_activity WHERE pid = ${pid}`
      console.log('[C5-1] pg_stat_activity', JSON.stringify(espera))
    } finally {
      await liga.soltar()
    }

    expect(await reemplazo).toMatchObject({ ok: { stats: { productsArchived: 1 } } })
    expect(await prisma.paymentLinkItemModifier.count({ where: { paymentLinkItemId: renglon, modifierId: shot.id } })).toBe(1)
    expect(totalDeLiga(await getPaymentLinkByShortCode(corto))).toBe(70) // $50 del té + $20 del extra
    expect(await prisma.modifierGroup.findUniqueOrThrow({ where: { id: grupo.id }, select: { active: true } })).toEqual({ active: false })
  })
})

describe('C5-2 · lo que la importación adopta en un negocio DEMO deja de ser demo: convertirlo no lo borra', () => {
  it.each(['replace', 'merge'] as const)(
    '«%s»: el producto, su categoría, su inventario y su grupo de extras sobreviven a cleanDemoData',
    async mode => {
      const x = await negocio()
      const categoria = await prisma.menuCategory.create({
        data: { venueId: x.venueId, name: 'Bebidas Calientes', slug: `bebidas-${x.rfc}`.toLowerCase(), isDemo: true },
      })
      const demo = await prisma.product.create({
        data: { venueId: x.venueId, categoryId: categoria.id, sku: `BEB-${x.rfc}`, name: 'Café Americano', price: 35, isDemo: true },
      })
      const inventario = await prisma.inventory.create({ data: { productId: demo.id, venueId: x.venueId, currentStock: 4, isDemo: true } })
      await prisma.modifierGroup.create({
        data: {
          venueId: x.venueId,
          name: 'Tipo de Leche',
          isDemo: true,
          modifiers: { create: [{ name: 'Leche Light', price: 0, isDemo: true }] },
        },
      })

      await importMenu(
        x.venueId,
        {
          mode,
          categories: [
            {
              name: 'Bebidas Calientes',
              slug: categoria.slug,
              products: [
                {
                  name: 'Café Americano',
                  sku: `BEB-${x.rfc}`,
                  price: 40,
                  trackInventory: true,
                  modifierGroups: [
                    {
                      name: 'Tipo de Leche',
                      required: false,
                      allowMultiple: false,
                      minSelections: 0,
                      maxSelections: 1,
                      modifiers: [{ name: 'Leche Light', price: 5 }],
                    },
                  ],
                },
                // Un SKU NUEVO en la categoría demo: si la categoría siguiera demo, su borrado chocaría con la llave RESTRICT.
                { name: 'Nuevo', sku: `NUEVO-${x.rfc}`, price: 10 },
              ],
            },
          ],
        },
        SERVICIO,
      )

      await expect(cleanDemoData(x.venueId)).resolves.toBeDefined()

      expect(await prisma.product.findUnique({ where: { id: demo.id }, select: { isDemo: true, deletedAt: true } })).toEqual({
        isDemo: false,
        deletedAt: null,
      })
      expect(await prisma.menuCategory.findUnique({ where: { id: categoria.id }, select: { isDemo: true } })).toEqual({ isDemo: false })
      expect(await prisma.product.count({ where: { venueId: x.venueId, sku: `NUEVO-${x.rfc}`, categoryId: categoria.id } })).toBe(1)
      expect(await prisma.inventory.findUnique({ where: { id: inventario.id }, select: { isDemo: true } })).toEqual({ isDemo: false })
      expect(
        await prisma.productModifierGroup.findMany({
          where: { productId: demo.id },
          select: { group: { select: { name: true, isDemo: true, modifiers: { select: { name: true, isDemo: true } } } } },
        }),
      ).toEqual([{ group: { name: 'Tipo de Leche', isDemo: false, modifiers: [{ name: 'Leche Light', isDemo: false }] } }])
    },
  )
})
