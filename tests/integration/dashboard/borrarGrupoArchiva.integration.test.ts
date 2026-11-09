/**
 * D16 (decisión del founder, 9-nov, opción A): borrar un GRUPO de extras lo archiva. Para quien administra desaparece igual que
 * antes; por dentro nada que apunte a sus extras se rompe. Contra Postgres REAL, negocio nuevo por caso.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'

import {
  assignModifierGroupToProduct,
  createModifier,
  createModifierGroup,
  deleteModifierGroup,
  getModifierGroupById,
  getModifierGroups,
  importMenu,
  updateModifierGroup,
} from '@/services/dashboard/menu.dashboard.service'
import { getPaymentLinkByShortCode } from '@/services/dashboard/paymentLink.service'
import { createProduct, updateProduct } from '@/services/dashboard/product.dashboard.service'
import { createProductWithVariants } from '@/services/product-variants/productGroup.service'
import { createOrderWithItems } from '@/services/mobile/order.mobile.service'
import { configureVariableIngredient } from '@/services/dashboard/recipe.service'
import prisma from '@/utils/prismaClient'
import { conProducto, limpiarNegocios, nuevoNegocio, type Negocio } from '../fiscal/exclusionContable.fixtures'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))

jest.setTimeout(120_000)

const SERVICIO = { type: 'SERVICE' as const, servicePrincipalId: 'D16_PRUEBA' }
const usados: Negocio[] = []
const personal: string[] = []

async function negocio() {
  const x = await nuevoNegocio({ contabilidad: false })
  usados.push(x)
  return x
}

/** Un grupo OBLIGATORIO con un extra de $20, enlazado a un producto de $50. */
async function grupoConExtra(x: Negocio) {
  const { categoryId, productId } = await conProducto(x)
  const grupo = await prisma.modifierGroup.create({
    data: { venueId: x.venueId, name: 'Extras', required: true, minSelections: 1, modifiers: { create: [{ name: 'Shot', price: 20 }] } },
  })
  const extra = await prisma.modifier.findFirstOrThrow({ where: { groupId: grupo.id } })
  await prisma.productModifierGroup.create({ data: { productId, groupId: grupo.id } })
  return { categoryId, productId, grupoId: grupo.id, extraId: extra.id }
}

async function ligaConExtra(x: Negocio, productId: string, modifierId: string) {
  const etiqueta = x.rfc.toLowerCase()
  const proveedor = await prisma.paymentProvider.upsert({
    where: { code: 'D16_PRUEBA' },
    create: { code: 'D16_PRUEBA', name: 'D16 (prueba)', type: 'PAYMENT_PROCESSOR' },
    update: {},
  })
  const staff = await prisma.staff.create({ data: { email: `d16-${etiqueta}@example.test`, firstName: 'D', lastName: 'Dieciseis' } })
  personal.push(staff.id)
  const canal = await prisma.ecommerceMerchant.create({
    data: {
      venueId: x.venueId,
      businessName: 'D16',
      contactEmail: `d16-comercio-${etiqueta}@example.test`,
      publicKey: `pk_test_d16_${etiqueta}`,
      secretKeyHash: `d16-${etiqueta}`,
      providerId: proveedor.id,
      providerCredentials: {},
    },
  })
  const liga = await prisma.paymentLink.create({
    data: {
      shortCode: etiqueta.slice(-8),
      venueId: x.venueId,
      ecommerceMerchantId: canal.id,
      createdById: staff.id,
      purpose: 'ITEM',
      title: 'Liga viva',
      amountType: 'FIXED',
      amount: 70,
      items: { create: [{ productId, modifiers: { create: [{ modifierId, quantity: 1 }] } }] },
    },
  })
  return { corto: liga.shortCode, staffId: staff.id }
}

afterAll(async () => {
  const venues = usados.map(x => x.venueId)
  await prisma.paymentLink.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.ecommerceMerchant.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.staffVenue.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.staff.deleteMany({ where: { id: { in: personal } } })
  await prisma.paymentProvider.deleteMany({ where: { code: 'D16_PRUEBA' } })
  await limpiarNegocios()
})

describe('Borrar un grupo de extras lo archiva', () => {
  it('apaga grupo y extras, suelta los enlaces, y la liga, la venta y el historial de precios no se mueven', async () => {
    const x = await negocio()
    const { productId, grupoId, extraId } = await grupoConExtra(x)
    const { corto } = await ligaConExtra(x, productId, extraId)
    const ligaAntes = await getPaymentLinkByShortCode(corto)
    const orden = await prisma.order.create({
      data: { venueId: x.venueId, orderNumber: `D16-${randomUUID()}`, subtotal: 0, taxAmount: 0, total: 0 },
    })
    const renglon = await prisma.orderItem.create({
      data: { orderId: orden.id, productId, productName: 'Café', quantity: 1, unitPrice: new Prisma.Decimal(70), taxAmount: 0, total: new Prisma.Decimal(70) },
    })
    const vendido = await prisma.orderItemModifier.create({ data: { orderItemId: renglon.id, modifierId: extraId, name: 'Shot', price: 20 } })
    const historial = await prisma.modifierPriceHistory.count({ where: { modifierId: extraId } })

    await expect(deleteModifierGroup(x.venueId, grupoId)).resolves.toBeUndefined()

    expect(await prisma.modifierGroup.findUniqueOrThrow({ where: { id: grupoId }, select: { active: true } })).toEqual({ active: false })
    expect(await prisma.modifier.findUniqueOrThrow({ where: { id: extraId }, select: { active: true } })).toEqual({ active: false })
    expect(await prisma.productModifierGroup.count({ where: { groupId: grupoId } })).toBe(0) // un obligatorio sin opciones trabaría la venta
    expect(await getPaymentLinkByShortCode(corto)).toEqual(ligaAntes)
    expect((await prisma.orderItemModifier.findUniqueOrThrow({ where: { id: vendido.id } })).modifierId).toBe(extraId)
    expect(await prisma.modifierPriceHistory.count({ where: { modifierId: extraId } })).toBe(historial)
  })

  it('sin red: una venta de la cola que trae un extra del grupo archivado se acepta con su precio', async () => {
    const x = await negocio()
    const { productId, grupoId, extraId } = await grupoConExtra(x)
    const staffId = (await prisma.staff.create({ data: { email: `d16-venta-${x.rfc.toLowerCase()}@example.test`, firstName: 'V', lastName: 'Enta' } })).id
    personal.push(staffId)
    await prisma.staffVenue.create({ data: { venueId: x.venueId, staffId, role: 'MANAGER' } })
    await deleteModifierGroup(x.venueId, grupoId)

    const venta = await createOrderWithItems(x.venueId, {
      staffId,
      externalId: `d16-${randomUUID()}`,
      source: 'AVOQADO_ANDROID',
      items: [{ productId, quantity: 1, modifierIds: [extraId] }],
    } as any)

    const renglon = await prisma.orderItem.findFirstOrThrow({ where: { orderId: venta.id }, include: { modifiers: true } })
    expect(renglon.modifiers.map(m => m.modifierId)).toEqual([extraId])
    expect(Number(renglon.modifiers[0].price)).toBe(20)
  })

  it('para quien administra ya no existe: no sale en la lista y todo lo demás da «no existe», igual que antes', async () => {
    const x = await negocio()
    const { grupoId, extraId } = await grupoConExtra(x)
    const vivo = await prisma.modifierGroup.create({ data: { venueId: x.venueId, name: 'Salsas' } })

    await deleteModifierGroup(x.venueId, grupoId)

    expect((await getModifierGroups(x.venueId)).map(g => g.id)).toEqual([vivo.id])
    expect((await getModifierGroups(x.venueId, { active: false })).map(g => g.id)).toEqual([grupoId]) // quien lo pide a propósito, sí
    await expect(getModifierGroupById(x.venueId, grupoId)).rejects.toMatchObject({ statusCode: 404 })
    await expect(deleteModifierGroup(x.venueId, grupoId)).rejects.toMatchObject({ statusCode: 404 }) // el segundo DELETE, como hoy
    await expect(updateModifierGroup(x.venueId, grupoId, { name: 'Otro' } as any)).rejects.toMatchObject({ statusCode: 404 })
    await expect(createModifier(x.venueId, grupoId, { name: 'Nuevo', price: 1 } as any)).rejects.toMatchObject({ statusCode: 404 })
    expect(await prisma.modifier.findUniqueOrThrow({ where: { id: extraId }, select: { name: true } })).toEqual({ name: 'Shot' })
  })

  it('nadie lo vuelve a enlazar: se rechaza en cada escritor', async () => {
    const x = await negocio()
    const { categoryId, productId, grupoId } = await grupoConExtra(x)
    await deleteModifierGroup(x.venueId, grupoId)

    await expect(assignModifierGroupToProduct(x.venueId, productId, { modifierGroupId: grupoId } as any)).rejects.toMatchObject({ statusCode: 404 })
    await expect(updateProduct(x.venueId, productId, { modifierGroupIds: [grupoId] } as any, SERVICIO as any)).rejects.toMatchObject({ statusCode: 400 })
    await expect(
      createProduct(x.venueId, { name: 'Té', sku: `TE-${x.rfc}`, price: 40, categoryId, modifierGroupIds: [grupoId] } as any, SERVICIO as any),
    ).rejects.toMatchObject({ statusCode: 404 })
    await expect(
      createProductWithVariants(
        x.venueId,
        { name: 'Taco', categoryId, modifierGroupIds: [grupoId], options: [{ name: 'Tamaño', values: ['Chico'] }], variants: [{ values: ['Chico'], price: 30 }] } as any,
        SERVICIO as any,
      ),
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(await prisma.productModifierGroup.count({ where: { groupId: grupoId } })).toBe(0)
  })

  it('el mismo nombre se puede volver a crear', async () => {
    const x = await negocio()
    const { grupoId } = await grupoConExtra(x)
    await deleteModifierGroup(x.venueId, grupoId)

    const nuevo = await createModifierGroup(x.venueId, { name: 'Extras' } as any)

    expect(nuevo.id).not.toBe(grupoId)
    expect((await getModifierGroups(x.venueId)).map(g => g.id)).toEqual([nuevo.id])
  })

  it('también en una familia: suelta el enlace del padre y el de cada variante', async () => {
    const x = await negocio()
    const { categoryId } = await conProducto(x)
    const grupo = await prisma.modifierGroup.create({ data: { venueId: x.venueId, name: 'Salsa' } })
    const actor = { type: 'SERVICE', servicePrincipalId: 'D16_PRUEBA' } as any
    const f = await createProductWithVariants(
      x.venueId,
      { name: 'Taco', categoryId, modifierGroupIds: [grupo.id], options: [{ name: 'Tamaño', values: ['Chico'] }], variants: [{ values: ['Chico'], price: 30 }] },
      actor,
    )
    expect(await prisma.productModifierGroup.count({ where: { groupId: grupo.id } })).toBe(1) // la prueba sólo vale con la variante enlazada

    await deleteModifierGroup(x.venueId, grupo.id)

    expect(await prisma.productGroupModifierGroup.count({ where: { groupId: f.groupId } })).toBe(0)
    expect(await prisma.productModifierGroup.count({ where: { groupId: grupo.id } })).toBe(0)
    // limpiarNegocios no conoce familias (ProductGroup → categoría es RESTRICT)
    await prisma.product.deleteMany({ where: { productGroupId: f.groupId } })
    await prisma.productGroup.delete({ where: { id: f.groupId } })
  })
})

describe('Candados', () => {
  it('dos ediciones de productos con extras a la vez no se traban entre sí', async () => {
    const x = await negocio()
    const { categoryId, productId, grupoId } = await grupoConExtra(x)
    const otro = await prisma.product.create({ data: { venueId: x.venueId, categoryId, sku: `OT-${x.rfc}`, name: 'Otro', price: 10 } })

    const r = await Promise.allSettled(
      [...Array(6)].map((_, i) =>
        updateProduct(x.venueId, i % 2 ? productId : otro.id, { modifierGroupIds: [grupoId], name: `Nombre ${i}` } as any, SERVICIO as any),
      ),
    )

    expect(r.filter(y => y.status === 'rejected').map(y => String((y as PromiseRejectedResult).reason))).toEqual([])
  })
})

describe('Recetas y grupos archivados', () => {
  async function lineaVariable(x: Negocio, categoryId: string, grupoId: string, marca: string) {
    const { id: productId } = await prisma.product.create({
      data: { venueId: x.venueId, categoryId, sku: `R-${marca}-${x.rfc}`, name: `Latte ${marca}`, price: 60 },
    })
    const leche = await prisma.rawMaterial.create({
      data: { venueId: x.venueId, name: `Leche ${marca}`, sku: `L-${marca}-${x.rfc}`, category: 'DAIRY', unit: 'LITER', unitType: 'VOLUME', currentStock: 5, minimumStock: 1, reorderPoint: 2, costPerUnit: 20, avgCostPerUnit: 20 } as any,
    })
    const receta = await prisma.recipe.create({
      data: { productId, portionYield: 1, totalCost: 4, lines: { create: [{ rawMaterialId: leche.id, quantity: 0.2, unit: 'LITER', isVariable: true, linkedModifierGroupId: grupoId }] } } as any,
      include: { lines: true },
    })
    return { productId, lineaId: receta.lines[0].id }
  }

  it('un grupo archivado no se liga a una receta de nuevo, pero la que ya lo traía se puede volver a guardar', async () => {
    const x = await negocio()
    const { categoryId, grupoId } = await grupoConExtra(x)
    const otro = await prisma.modifierGroup.create({ data: { venueId: x.venueId, name: 'Otro' } })
    const { productId, lineaId } = await lineaVariable(x, categoryId, grupoId, 'A')
    const conOtro = await lineaVariable(x, categoryId, otro.id, 'B')
    await deleteModifierGroup(x.venueId, grupoId)

    await expect(
      configureVariableIngredient(x.venueId, conOtro.productId, conOtro.lineaId, { isVariable: true, linkedModifierGroupId: grupoId }),
    ).rejects.toMatchObject({ statusCode: 404 })
    await expect(
      configureVariableIngredient(x.venueId, productId, lineaId, { isVariable: true, linkedModifierGroupId: grupoId }),
    ).resolves.toMatchObject({ linkedModifierGroupId: grupoId })
  })
})

describe('Importar menú con grupos archivados', () => {
  const archivoCon = (mode: 'merge' | 'replace', x: Negocio, grupo: string, extra: string) => ({
    mode,
    categories: [
      {
        name: 'IVA',
        slug: `iva-${x.rfc}`.toLowerCase(),
        products: [
          {
            name: 'Café',
            sku: `P-${x.rfc}`,
            price: 100,
            modifierGroups: [{ name: grupo, required: false, allowMultiple: false, minSelections: 0, maxSelections: 1, modifiers: [{ name: extra, price: 25 }] }],
          },
        ],
      },
    ],
  })

  it('«Reemplazar» que trae el nombre de un archivado lo regresa con el mismo id, y lo cuenta como creado', async () => {
    const x = await negocio()
    const { grupoId, extraId } = await grupoConExtra(x)
    await deleteModifierGroup(x.venueId, grupoId)

    const r = await importMenu(x.venueId, archivoCon('replace', x, 'Extras', 'Shot') as any, SERVICIO)

    expect(await prisma.modifierGroup.findUniqueOrThrow({ where: { id: grupoId }, select: { active: true } })).toEqual({ active: true })
    expect(await prisma.modifier.findUniqueOrThrow({ where: { id: extraId }, select: { active: true, price: true } })).toMatchObject({
      active: true,
      price: new Prisma.Decimal(25),
    })
    expect(r.stats).toMatchObject({ modifierGroups: 1, modifiers: 1 })
    expect((await getModifierGroups(x.venueId)).map(g => g.id)).toEqual([grupoId])
  })

  it('con un vivo y un archivado del mismo nombre, se usa el vivo', async () => {
    const x = await negocio()
    const { grupoId } = await grupoConExtra(x)
    await deleteModifierGroup(x.venueId, grupoId)
    const vivo = await createModifierGroup(x.venueId, { name: 'Extras' } as any)

    await importMenu(x.venueId, archivoCon('merge', x, 'Extras', 'Shot') as any, SERVICIO)

    expect(await prisma.modifierGroup.findUniqueOrThrow({ where: { id: grupoId }, select: { active: true } })).toEqual({ active: false })
    expect((await getModifierGroups(x.venueId)).map(g => g.id)).toEqual([vivo.id])
  })

  it('«Combinar» con un archivado crea uno nuevo: las reglas y el precio del archivo, sin tocar la liga vieja', async () => {
    const x = await negocio()
    const { productId, grupoId, extraId } = await grupoConExtra(x) // obligatorio, «Shot» a $20
    const { corto } = await ligaConExtra(x, productId, extraId)
    const ligaAntes = await getPaymentLinkByShortCode(corto)
    await deleteModifierGroup(x.venueId, grupoId)

    const r = await importMenu(x.venueId, archivoCon('merge', x, 'Extras', 'Shot') as any, SERVICIO) // opcional, «Shot» a $25

    expect(await prisma.modifierGroup.findUniqueOrThrow({ where: { id: grupoId }, select: { active: true } })).toEqual({ active: false })
    expect(await prisma.modifier.findUniqueOrThrow({ where: { id: extraId }, select: { active: true, price: true } })).toMatchObject({
      active: false,
      price: new Prisma.Decimal(20),
    })
    const [nuevo] = await getModifierGroups(x.venueId)
    expect(nuevo.id).not.toBe(grupoId)
    expect(nuevo.required).toBe(false)
    expect(r.stats).toMatchObject({ modifierGroups: 1, modifiers: 1 })
    expect(await getPaymentLinkByShortCode(corto)).toEqual(ligaAntes)
  })

  it('«Reemplazar» con un vivo y un archivado del mismo nombre: regresa el que estaba vivo', async () => {
    const x = await negocio()
    const { grupoId: vivoId } = await grupoConExtra(x)
    const segundo = await createModifierGroup(x.venueId, { name: 'Extras' } as any) // mismo nombre, más nuevo
    await deleteModifierGroup(x.venueId, segundo.id)

    await importMenu(x.venueId, archivoCon('replace', x, 'Extras', 'Shot') as any, SERVICIO)

    expect((await getModifierGroups(x.venueId)).map(g => g.id)).toEqual([vivoId])
    expect(await prisma.modifierGroup.findUniqueOrThrow({ where: { id: segundo.id }, select: { active: true } })).toEqual({ active: false })
  })
})
