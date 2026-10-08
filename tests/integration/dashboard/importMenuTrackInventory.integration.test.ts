/**
 * La importación por hoja de cálculo del dashboard (`importMenu`) con `trackInventory: true` creaba la fila de Inventory con su
 * saldo de apertura, pero NUNCA prendía `Product.trackInventory` ni `inventoryMethod`: el producto quedaba con existencias
 * cargadas y sus ventas NO descontaban. Contra Postgres REAL (base desechable), negocio NUEVO por caso, y la venta por el
 * camino real de descuento (`deductInventoryForProduct`).
 */
import { Prisma } from '@prisma/client'

import { importMenu } from '@/services/dashboard/menu.dashboard.service'
import { deductInventoryForProduct } from '@/services/dashboard/productInventoryIntegration.service'
import { NON_INVENTORIABLE_MESSAGE } from '@/services/dashboard/quantityInventoryRow'
import prisma from '@/utils/prismaClient'
import { desenlace, limpiarNegocios, nuevoNegocio } from '../fiscal/exclusionContable.fixtures'

jest.setTimeout(120_000)

const SERVICIO = { type: 'SERVICE' as const, servicePrincipalId: 'IMPORT_TRACK_INVENTORY_PRUEBA' }

type Fila = {
  name: string
  sku: string
  price: number
  type?: 'FOOD' | 'RETAIL' | 'CLASS'
  trackInventory?: boolean
  currentStock?: number
}
const archivo = (filas: Fila[]) => ({ mode: 'merge' as const, categories: [{ name: 'Tienda', slug: 'tienda', products: filas }] })

const negocio = () => nuevoNegocio({ contabilidad: false })
const producto = (venueId: string, sku: string) =>
  prisma.product.findFirstOrThrow({ where: { venueId, sku }, include: { inventory: true, recipe: true } })

afterAll(async () => {
  await limpiarNegocios()
  await prisma.$disconnect()
})

describe('importMenu con trackInventory: true', () => {
  it('un producto NUEVO queda «por cantidad» y su venta SÍ descuenta', async () => {
    const x = await negocio()
    await importMenu(
      x.venueId,
      archivo([{ name: 'Gorra', sku: 'GORRA', price: 250, type: 'RETAIL', trackInventory: true, currentStock: 10 }]),
      SERVICIO,
    )

    const p = await producto(x.venueId, 'GORRA')
    expect({ trackInventory: p.trackInventory, inventoryMethod: p.inventoryMethod }).toEqual({
      trackInventory: true,
      inventoryMethod: 'QUANTITY',
    })
    expect(Number(p.inventory?.currentStock)).toBe(10)

    const venta = await deductInventoryForProduct(x.venueId, p.id, 3, 'orden-prueba', undefined)
    expect(venta.inventoryMethod).toBe('QUANTITY')
    const despues = await producto(x.venueId, 'GORRA')
    expect(Number(despues.inventory?.currentStock)).toBe(7)
    expect(await prisma.inventoryMovement.count({ where: { inventoryId: p.inventory!.id, type: 'SALE' } })).toBe(1)
  })

  it('un producto que YA existía sin inventario lo prende al re-importarse, y su venta descuenta', async () => {
    const x = await negocio()
    await importMenu(x.venueId, archivo([{ name: 'Taza', sku: 'TAZA', price: 120, type: 'RETAIL' }]), SERVICIO)
    const antes = await producto(x.venueId, 'TAZA')
    expect({ trackInventory: antes.trackInventory, inventoryMethod: antes.inventoryMethod, inventory: antes.inventory }).toEqual({
      trackInventory: false,
      inventoryMethod: null,
      inventory: null,
    })

    await importMenu(
      x.venueId,
      archivo([{ name: 'Taza', sku: 'TAZA', price: 120, type: 'RETAIL', trackInventory: true, currentStock: 5 }]),
      SERVICIO,
    )

    const p = await producto(x.venueId, 'TAZA')
    expect(p.id).toBe(antes.id)
    expect({ trackInventory: p.trackInventory, inventoryMethod: p.inventoryMethod }).toEqual({
      trackInventory: true,
      inventoryMethod: 'QUANTITY',
    })
    await deductInventoryForProduct(x.venueId, p.id, 2, 'orden-prueba', undefined)
    expect(Number((await producto(x.venueId, 'TAZA')).inventory?.currentStock)).toBe(3)
  })

  it('un producto con RECETA no se convierte a «por cantidad»: conserva su receta y el resumen lo cuenta', async () => {
    const x = await negocio()
    await importMenu(x.venueId, archivo([{ name: 'Latte', sku: 'LATTE', price: 60 }]), SERVICIO)
    const antes = await producto(x.venueId, 'LATTE')
    await prisma.product.update({ where: { id: antes.id }, data: { trackInventory: true, inventoryMethod: 'RECIPE' } })
    await prisma.recipe.create({ data: { productId: antes.id, portionYield: 1, totalCost: new Prisma.Decimal(12) } })

    const r = await importMenu(
      x.venueId,
      archivo([{ name: 'Latte', sku: 'LATTE', price: 60, trackInventory: true, currentStock: 4 }]),
      SERVICIO,
    )

    const p = await producto(x.venueId, 'LATTE')
    expect({ trackInventory: p.trackInventory, inventoryMethod: p.inventoryMethod }).toEqual({
      trackInventory: true,
      inventoryMethod: 'RECIPE',
    })
    expect(p.recipe).not.toBeNull()
    expect(r.stats.productsKeptOnRecipe).toBe(1)
  })

  it('un tipo que no lleva existencias (clase) rechaza el archivo entero, como el resto de la plataforma', async () => {
    const x = await negocio()
    const r = (await desenlace(
      importMenu(
        x.venueId,
        archivo([{ name: 'Yoga', sku: 'YOGA', price: 150, type: 'CLASS', trackInventory: true, currentStock: 8 }]),
        SERVICIO,
      ),
    )) as { statusCode?: number; message?: string }

    expect({ statusCode: r.statusCode, message: r.message }).toEqual({ statusCode: 400, message: NON_INVENTORIABLE_MESSAGE })
    expect(await prisma.product.count({ where: { venueId: x.venueId } })).toBe(0)
    expect(await prisma.inventory.count({ where: { venueId: x.venueId } })).toBe(0)
  })
})

describe('importMenu sin trackInventory (compatibilidad)', () => {
  it('una fila sin trackInventory no prende nada ni crea inventario', async () => {
    const x = await negocio()
    const r = await importMenu(x.venueId, archivo([{ name: 'Pan', sku: 'PAN', price: 30 }]), SERVICIO)

    const p = await producto(x.venueId, 'PAN')
    expect({ trackInventory: p.trackInventory, inventoryMethod: p.inventoryMethod, inventory: p.inventory }).toEqual({
      trackInventory: false,
      inventoryMethod: null,
      inventory: null,
    })
    expect(r.stats.productsKeptOnRecipe).toBe(0)
  })

  it('re-importar SIN trackInventory no apaga un producto que ya se contaba por cantidad ni toca su saldo', async () => {
    const x = await negocio()
    await importMenu(
      x.venueId,
      archivo([{ name: 'Vela', sku: 'VELA', price: 90, type: 'RETAIL', trackInventory: true, currentStock: 6 }]),
      SERVICIO,
    )
    await importMenu(x.venueId, archivo([{ name: 'Vela aroma', sku: 'VELA', price: 95, type: 'RETAIL' }]), SERVICIO)

    const p = await producto(x.venueId, 'VELA')
    expect({ name: p.name, trackInventory: p.trackInventory, inventoryMethod: p.inventoryMethod }).toEqual({
      name: 'Vela aroma',
      trackInventory: true,
      inventoryMethod: 'QUANTITY',
    })
    expect(Number(p.inventory?.currentStock)).toBe(6)
  })
})
