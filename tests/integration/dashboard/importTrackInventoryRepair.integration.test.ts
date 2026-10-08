/**
 * Diagnóstico y reparación (`scripts/lib/importTrackInventory.ts`) de los productos que la importación por hoja de cálculo
 * del dashboard ya dejó dañados: fila de Inventory con existencias, producto sin «por cantidad». Contra Postgres REAL
 * (base desechable), negocio NUEVO por caso.
 */
import { Prisma } from '@prisma/client'

import { deductInventoryForProduct } from '@/services/dashboard/productInventoryIntegration.service'
import prisma from '@/utils/prismaClient'
import { limpiarNegocios, nuevoNegocio } from '../fiscal/exclusionContable.fixtures'
import { ACCION, buscarDanados, clasificar, reparar } from '../../../scripts/lib/importTrackInventory'

jest.setTimeout(120_000)

const negocio = () => nuevoNegocio({ contabilidad: false })

afterAll(async () => {
  await limpiarNegocios()
  await prisma.$disconnect()
})

describe('diagnóstico y reparación de lo que la importación ya dejó dañado (scripts/lib/importTrackInventory)', () => {
  /** Un producto como lo dejó la importación vieja (o en otro estado), con su fila de Inventory si se pide. */
  async function sembrar(
    venueId: string,
    categoryId: string,
    sku: string,
    estado: { type?: 'FOOD' | 'RETAIL' | 'CLASS'; trackInventory: boolean; inventoryMethod: 'QUANTITY' | 'RECIPE' | null },
    extra: { inventario?: number; venta?: boolean; receta?: boolean } = {},
  ) {
    const p = await prisma.product.create({ data: { venueId, categoryId, name: sku, sku, price: 10, ...estado } })
    if (extra.inventario !== undefined) {
      const inv = await prisma.inventory.create({ data: { productId: p.id, venueId, currentStock: extra.inventario } })
      if (extra.venta)
        await prisma.inventoryMovement.create({
          data: { inventoryId: inv.id, type: 'SALE', quantity: -1, previousStock: extra.inventario + 1, newStock: extra.inventario },
        })
    }
    if (extra.receta) await prisma.recipe.create({ data: { productId: p.id, portionYield: 1, totalCost: new Prisma.Decimal(1) } })
    return p.id
  }

  async function negocioDanado() {
    const x = await negocio()
    const { id: cat } = await prisma.menuCategory.create({ data: { venueId: x.venueId, name: 'Daños', slug: 'danos' } })
    const ids = {
      apagado: await sembrar(
        x.venueId,
        cat,
        'APAGADO',
        { type: 'RETAIL', trackInventory: false, inventoryMethod: null },
        { inventario: 10 },
      ),
      sinMetodo: await sembrar(
        x.venueId,
        cat,
        'SIN-METODO',
        { type: 'RETAIL', trackInventory: true, inventoryMethod: null },
        { inventario: 4 },
      ),
      clase: await sembrar(x.venueId, cat, 'CLASE', { type: 'CLASS', trackInventory: false, inventoryMethod: null }, { inventario: 8 }),
      receta: await sembrar(
        x.venueId,
        cat,
        'RECETA',
        { type: 'FOOD', trackInventory: false, inventoryMethod: 'RECIPE' },
        { inventario: 3, receta: true },
      ),
      vendido: await sembrar(
        x.venueId,
        cat,
        'VENDIDO',
        { type: 'RETAIL', trackInventory: false, inventoryMethod: 'QUANTITY' },
        { inventario: 2, venta: true },
      ),
      sano: await sembrar(x.venueId, cat, 'SANO', { type: 'RETAIL', trackInventory: true, inventoryMethod: 'QUANTITY' }, { inventario: 5 }),
      sinFila: await sembrar(x.venueId, cat, 'SIN-FILA', { type: 'RETAIL', trackInventory: false, inventoryMethod: null }),
    }
    return { x, ids }
  }

  it('el diagnóstico lista por negocio, con nombre, sólo los que tienen inventario y no se cuentan, y los clasifica', async () => {
    const { x, ids } = await negocioDanado()
    const { filas, truncado } = await buscarDanados(prisma, x.venueId)

    expect(truncado).toBe(false)
    expect(Object.fromEntries(filas.map(f => [f.sku, clasificar(f)]))).toEqual({
      APAGADO: 'REPARABLE',
      'SIN-METODO': 'REPARABLE',
      CLASE: 'TIPO_SIN_EXISTENCIAS',
      RECETA: 'CON_RECETA',
      VENDIDO: 'APAGADO_TRAS_VENDER',
    })
    expect(new Set(filas.map(f => f.venueName))).toEqual(
      new Set([(await prisma.venue.findUniqueOrThrow({ where: { id: x.venueId } })).name]),
    )
    expect(filas.find(f => f.productId === ids.sano)).toBeUndefined()
  })

  it('la reparación prende «por cantidad» SÓLO los reparables, deja bitácora, no toca existencias, y la venta ya descuenta', async () => {
    const { x, ids } = await negocioDanado()
    const { filas } = await buscarDanados(prisma, x.venueId)

    expect(await reparar(prisma, filas)).toBe(2)

    const estado = async (id: string) =>
      prisma.product.findUniqueOrThrow({
        where: { id },
        select: { trackInventory: true, inventoryMethod: true, inventory: { select: { currentStock: true } } },
      })
    expect(await estado(ids.apagado)).toMatchObject({ trackInventory: true, inventoryMethod: 'QUANTITY' })
    expect(await estado(ids.sinMetodo)).toMatchObject({ trackInventory: true, inventoryMethod: 'QUANTITY' })
    expect(await estado(ids.clase)).toMatchObject({ trackInventory: false, inventoryMethod: null })
    expect(await estado(ids.receta)).toMatchObject({ trackInventory: false, inventoryMethod: 'RECIPE' })
    expect(await estado(ids.vendido)).toMatchObject({ trackInventory: false, inventoryMethod: 'QUANTITY' })
    expect(Number((await estado(ids.apagado)).inventory?.currentStock)).toBe(10)
    expect(await prisma.activityLog.count({ where: { venueId: x.venueId, action: ACCION } })).toBe(2)

    await deductInventoryForProduct(x.venueId, ids.apagado, 1, 'orden-prueba', undefined)
    expect(Number((await estado(ids.apagado)).inventory?.currentStock)).toBe(9)
    expect((await buscarDanados(prisma, x.venueId)).filas.filter(f => clasificar(f) === 'REPARABLE')).toEqual([])
  })

  it('si un producto cambió desde que se listó, no repara NADA (CAS en una sola transacción)', async () => {
    const { x, ids } = await negocioDanado()
    const { filas } = await buscarDanados(prisma, x.venueId)
    await prisma.product.update({ where: { id: ids.sinMetodo }, data: { inventoryMethod: 'RECIPE' } })

    await expect(reparar(prisma, filas)).rejects.toThrow('cambió desde que se listó')
    expect(await prisma.product.findUniqueOrThrow({ where: { id: ids.apagado } })).toMatchObject({
      trackInventory: false,
      inventoryMethod: null,
    })
    expect(await prisma.activityLog.count({ where: { venueId: x.venueId, action: ACCION } })).toBe(0)
  })
})
