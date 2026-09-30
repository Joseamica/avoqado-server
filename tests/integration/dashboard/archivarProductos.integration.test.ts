/**
 * IVA por producto, plan 5 — archivar y el trigger de borrado, contra Postgres REAL (H1). Negocio NUEVO por caso.
 * Tarea 1: la migración 20260929000200 apaga UNA vez los productos que el dashboard ya había «borrado» sólo con deletedAt.
 * Tarea 2: borrar una categoría cuyo único contenido es un archivado. Tarea 5: el trigger BEFORE DELETE y los caminos de demo.
 */
import { readFileSync } from 'fs'
import path from 'path'

import prisma from '@/utils/prismaClient'
import { deleteMenuCategory } from '@/services/dashboard/menu.dashboard.service'
import { deleteProduct, esProductoConVentas, PRODUCTO_CON_VENTAS_NO_SE_BORRA } from '@/services/dashboard/product.dashboard.service'
import { createProductWithInventory } from '@/services/dashboard/productWizard.service'
import { deleteVenue } from '@/services/dashboard/venue.dashboard.service'
import { cleanDemoData } from '@/services/onboarding/demoCleanup.service'
import { desenlace, limpiarNegocios, nuevoNegocio, type Negocio } from '../fiscal/exclusionContable.fixtures'

jest.setTimeout(120_000)

afterAll(() => limpiarNegocios())

/** Un producto en la categoría «Plan 5» del negocio (se crea la primera vez). Devuelve su id. */
async function producto(x: Negocio, nombre: string, extra: { isDemo?: boolean } = {}): Promise<string> {
  const categoria = await prisma.menuCategory.upsert({
    where: { venueId_slug: { venueId: x.venueId, slug: 'plan5' } },
    create: { venueId: x.venueId, name: 'Plan 5', slug: 'plan5' },
    update: {},
  })
  return (
    await prisma.product.create({
      data: { venueId: x.venueId, categoryId: categoria.id, sku: `${nombre}-${x.rfc}`, name: nombre, price: 100, ...extra },
    })
  ).id
}

describe('D1 · archivar es deletedAt + deletedBy + active=false', () => {
  it('la migración apaga UNA vez los que el dashboard sólo marcaba con deletedAt; nada más se toca', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    const viejo = await producto(x, 'Masaje')
    const vivo = await producto(x, 'Facial')
    const cuando = new Date('2026-09-01T12:00:00.000Z')
    // Así «borraba» el dashboard hasta el plan 5: deletedAt y deletedBy, active intacto.
    await prisma.product.update({ where: { id: viejo }, data: { deletedAt: cuando, deletedBy: 'staff-viejo' } })

    const sql = readFileSync(path.join(process.cwd(), 'prisma/migrations/20260929000200_producto_archivado_se_apaga/migration.sql'), 'utf8')
    await prisma.$executeRawUnsafe(sql.slice(sql.indexOf('-- archivados-apagados:inicio'), sql.indexOf('-- archivados-apagados:fin')))

    expect(
      await prisma.product.findUniqueOrThrow({ where: { id: viejo }, select: { active: true, deletedAt: true, deletedBy: true } }),
    ).toEqual({ active: false, deletedAt: cuando, deletedBy: 'staff-viejo' })
    expect((await prisma.product.findUniqueOrThrow({ where: { id: vivo } })).active).toBe(true)
  })
})

describe('D6 · borrar una categoría cuyo único contenido es un archivado (Review Focus 4)', () => {
  it('se APAGA en vez del 500 de la llave RESTRICT, y el archivado sigue en ella', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    const pay = await producto(x, 'Pay')
    const { categoryId } = await prisma.product.findUniqueOrThrow({ where: { id: pay }, select: { categoryId: true } })
    await deleteProduct(x.venueId, pay, 'staff-plan5')

    await expect(deleteMenuCategory(x.venueId, categoryId)).resolves.toMatchObject({ id: categoryId, active: false })
    expect(await prisma.product.findUniqueOrThrow({ where: { id: pay }, select: { categoryId: true } })).toEqual({ categoryId })
  })
})

/** Una orden con un renglón del producto (sin cobro). Devuelve el id del renglón. */
async function renglon(x: Negocio, productId: string): Promise<string> {
  const o = await prisma.order.create({
    data: {
      venueId: x.venueId,
      orderNumber: `P5T-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      subtotal: 100,
      taxAmount: 0,
      total: 100,
    },
  })
  return (
    await prisma.orderItem.create({
      data: { orderId: o.id, productId, productName: 'Producto', quantity: 1, unitPrice: 100, taxAmount: 0, total: 100 },
    })
  ).id
}

describe('D5 · trigger BEFORE DELETE: un producto con ventas no se borra de verdad', () => {
  it('con un renglón de venta rechaza (modelo y SQL directo), el renglón conserva su producto y el error se reconoce como 409', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    const p = await producto(x, 'Vendido')
    const item = await renglon(x, p)

    const porModelo = await desenlace(prisma.product.delete({ where: { id: p } }))
    expect(String((porModelo as Error).message)).toContain(PRODUCTO_CON_VENTAS_NO_SE_BORRA)
    expect(esProductoConVentas(porModelo)).toBe(true)
    expect(esProductoConVentas(await desenlace(prisma.$executeRaw`DELETE FROM "Product" WHERE id = ${p}`))).toBe(true)
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: item } })).productId).toBe(p)
  })

  it('sin ventas se borra (el rollback del asistente borra un producto recién creado)', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    const p = await producto(x, 'Nuevo')

    await expect(prisma.product.delete({ where: { id: p } })).resolves.toMatchObject({ id: p })
  })

  it('P5-R18 c · el rollback del asistente de productos REAL sigue funcionando: un fallo inducido borra lo que creó y devuelve el error original', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    const { categoryId } = await prisma.product.findUniqueOrThrow({
      where: { id: await producto(x, 'Ancla') },
      select: { categoryId: true },
    })
    const sku = `WIZ-${x.rfc}`

    await expect(
      createProductWithInventory(
        x.venueId,
        {
          product: { name: 'Asistente', price: 50, categoryId, sku },
          inventory: { useInventory: true, inventoryMethod: 'RECIPE' },
          // Ingrediente inexistente: el paso 3 falla DESPUÉS de crear el producto ⇒ el asistente borra (duro) lo que creó.
          recipe: { portionYield: 1, ingredients: [{ rawMaterialId: 'no-existe-plan5', quantity: 1, unit: 'GRAM' }] },
        },
        { type: 'SERVICE', servicePrincipalId: 'PLAN5_PRUEBA' },
      ),
    ).rejects.toMatchObject({ statusCode: 404, message: 'Some ingredients were not found or do not belong to this venue' })
    expect(await prisma.product.count({ where: { venueId: x.venueId, sku } })).toBe(0)
  })

  it('borrar un negocio TRIAL con ventas (deleteVenue real) sigue funcionando: quita renglones y órdenes antes que productos', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    await prisma.venue.update({ where: { id: x.venueId }, data: { status: 'TRIAL' } })
    const p = await producto(x, 'Cafe')
    await renglon(x, p)

    await expect(deleteVenue(x.organizationId, x.venueId)).resolves.toBeUndefined()
    expect(await prisma.venue.count({ where: { id: x.venueId } })).toBe(0)
    expect(await prisma.product.count({ where: { id: p } })).toBe(0)
  })

  it('convertir un demo (cleanDemoData real) sigue funcionando: sus órdenes se van antes que sus productos demo', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    const demo = await producto(x, 'Demo', { isDemo: true })
    const real = await producto(x, 'Real')
    await renglon(x, demo)

    await expect(cleanDemoData(x.venueId)).resolves.toMatchObject({ deletedProducts: 1 })
    expect(await prisma.product.count({ where: { id: demo } })).toBe(0)
    expect(await prisma.product.count({ where: { id: real } })).toBe(1)
  })

  it('MEDIDO (P5-R10): un DELETE directo del Venue con una venta viva falla —sin suponer qué rechaza primero— y no borra nada', async () => {
    const x = await nuevoNegocio({ contabilidad: false })
    const p = await producto(x, 'Vivo')
    const item = await renglon(x, p)
    const { categoryId } = await prisma.product.findUniqueOrThrow({ where: { id: p }, select: { categoryId: true } })

    const e = await desenlace(prisma.$executeRaw`DELETE FROM "Venue" WHERE id = ${x.venueId}`)
    const texto = `${(e as { meta?: { message?: string } }).meta?.message ?? ''} ${(e as Error).message ?? ''}`
    // Postgres dispara las acciones de las llaves en orden de NOMBRE de trigger, no por la jerarquía del negocio: puede rechazar
    // la llave de la orden, la de la categoría (su cascada llega antes que la de productos) o el trigger nuevo. Se anota cuál.
    const quien = ['Order_venueId_fkey', 'Product_categoryId_fkey', PRODUCTO_CON_VENTAS_NO_SE_BORRA].find(c => texto.includes(c))
    expect(quien).toBeDefined()
    console.info(`plan 5 · medido: rechazó primero ${quien}`)
    expect(await prisma.venue.count({ where: { id: x.venueId } })).toBe(1)
    expect(await prisma.menuCategory.count({ where: { id: categoryId } })).toBe(1)
    expect(await prisma.product.count({ where: { id: p } })).toBe(1)
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: item } })).productId).toBe(p)
  })
})
