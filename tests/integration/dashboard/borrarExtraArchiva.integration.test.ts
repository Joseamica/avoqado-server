/**
 * D17 (decisión del founder, 9-nov, opción A): el `DELETE` de un EXTRA lo archiva (`active=false`). Deja de venderse; la liga, el
 * reporte, el historial de precios y la venta sin red no se mueven. Las lecturas de administración NO cambian: el apagado se ve y
 * se vuelve a prender (el ANDROID viejo lo hace con su interruptor «Activo» desde la lista). Contra Postgres REAL, negocio nuevo por caso.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'

import {
  deleteModifier,
  getModifierGroupById,
  getModifierGroups,
  importMenu,
  updateModifier,
} from '@/services/dashboard/menu.dashboard.service'
import { getPaymentLinkByShortCode } from '@/services/dashboard/paymentLink.service'
import { getProducts } from '@/services/dashboard/product.dashboard.service'
import { createOrderWithItems } from '@/services/mobile/order.mobile.service'
import prisma from '@/utils/prismaClient'
import { conProducto, limpiarNegocios, nuevoNegocio, type Negocio } from '../fiscal/exclusionContable.fixtures'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))

jest.setTimeout(120_000)

const usados: Negocio[] = []
const personal: string[] = []

async function negocio() {
  const x = await nuevoNegocio({ contabilidad: false })
  usados.push(x)
  return x
}

/** Un grupo con «Shot» ($20) y «Leche» ($10), enlazado a un producto. */
async function grupoConExtras(x: Negocio) {
  const { productId } = await conProducto(x)
  const grupo = await prisma.modifierGroup.create({
    data: {
      venueId: x.venueId,
      name: 'Extras',
      modifiers: {
        create: [
          { name: 'Shot', price: 20 },
          { name: 'Leche', price: 10 },
        ],
      },
    },
  })
  const extras = await prisma.modifier.findMany({ where: { groupId: grupo.id }, orderBy: { name: 'asc' } })
  await prisma.productModifierGroup.create({ data: { productId, groupId: grupo.id } })
  return { productId, grupoId: grupo.id, lecheId: extras[0].id, extraId: extras[1].id }
}

async function ligaConExtra(x: Negocio, productId: string, modifierId: string) {
  const etiqueta = x.rfc.toLowerCase()
  const proveedor = await prisma.paymentProvider.upsert({
    where: { code: 'D17_PRUEBA' },
    create: { code: 'D17_PRUEBA', name: 'D17 (prueba)', type: 'PAYMENT_PROCESSOR' },
    update: {},
  })
  const staff = await prisma.staff.create({ data: { email: `d17-${etiqueta}@example.test`, firstName: 'D', lastName: 'Diecisiete' } })
  personal.push(staff.id)
  const canal = await prisma.ecommerceMerchant.create({
    data: {
      venueId: x.venueId,
      businessName: 'D17',
      contactEmail: `d17-comercio-${etiqueta}@example.test`,
      publicKey: `pk_test_d17_${etiqueta}`,
      secretKeyHash: `d17-${etiqueta}`,
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
  return liga.shortCode
}

const extrasDe = (grupo: { modifiers: { id: string; active: boolean }[] }) =>
  grupo.modifiers.map(m => ({ id: m.id, active: m.active })).sort((a, b) => a.id.localeCompare(b.id))

afterAll(async () => {
  const venues = usados.map(x => x.venueId)
  await prisma.paymentLink.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.ecommerceMerchant.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.staffVenue.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.staff.deleteMany({ where: { id: { in: personal } } })
  await prisma.paymentProvider.deleteMany({ where: { code: 'D17_PRUEBA' } })
  await limpiarNegocios()
})

describe('Borrar un extra lo archiva', () => {
  it('lo apaga sin destruirlo: la liga, el reporte, el historial y el grupo no se mueven', async () => {
    const x = await negocio()
    const { productId, grupoId, extraId } = await grupoConExtras(x)
    const corto = await ligaConExtra(x, productId, extraId)
    const ligaAntes = await getPaymentLinkByShortCode(corto)
    const orden = await prisma.order.create({
      data: { venueId: x.venueId, orderNumber: `D17-${randomUUID()}`, subtotal: 0, taxAmount: 0, total: 0 },
    })
    const renglon = await prisma.orderItem.create({
      data: {
        orderId: orden.id,
        productId,
        productName: 'Café',
        quantity: 1,
        unitPrice: new Prisma.Decimal(70),
        taxAmount: 0,
        total: new Prisma.Decimal(70),
      },
    })
    const vendido = await prisma.orderItemModifier.create({
      data: { orderItemId: renglon.id, modifierId: extraId, name: 'Shot', price: 20 },
    })
    const historial = await prisma.modifierPriceHistory.count({ where: { modifierId: extraId } })

    await expect(deleteModifier(x.venueId, grupoId, extraId)).resolves.toBeUndefined()

    expect(await prisma.modifier.findUniqueOrThrow({ where: { id: extraId }, select: { active: true, name: true, price: true } })).toEqual({
      active: false,
      name: 'Shot',
      price: new Prisma.Decimal(20),
    })
    expect(await getPaymentLinkByShortCode(corto)).toEqual(ligaAntes)
    expect((await prisma.orderItemModifier.findUniqueOrThrow({ where: { id: vendido.id } })).modifierId).toBe(extraId)
    expect(await prisma.modifierPriceHistory.count({ where: { modifierId: extraId } })).toBe(historial)
    expect(await prisma.modifierGroup.findUniqueOrThrow({ where: { id: grupoId }, select: { active: true } })).toEqual({ active: true })
    expect(await prisma.productModifierGroup.count({ where: { groupId: grupoId } })).toBe(1)
    // El registro `MODIFIER_DELETED` sale sin esperar (fire-and-forget): lo cuida la prueba unitaria.
  })

  it('la caja ya no lo ofrece, y el otro extra sí', async () => {
    const x = await negocio()
    const { productId, grupoId, extraId, lecheId } = await grupoConExtras(x)

    await deleteModifier(x.venueId, grupoId, extraId)

    const [producto] = (await getProducts(x.venueId)).filter((p: any) => p.id === productId)
    expect(producto.modifierGroups[0].group.modifiers.map((m: any) => m.id)).toEqual([lecheId])
  })

  it('sin red: una venta de la cola que trae el extra archivado entra con su precio', async () => {
    const x = await negocio()
    const { productId, grupoId, extraId } = await grupoConExtras(x)
    const staffId = (
      await prisma.staff.create({ data: { email: `d17-venta-${x.rfc.toLowerCase()}@example.test`, firstName: 'V', lastName: 'Enta' } })
    ).id
    personal.push(staffId)
    await prisma.staffVenue.create({ data: { venueId: x.venueId, staffId, role: 'MANAGER' } })
    await deleteModifier(x.venueId, grupoId, extraId)

    const venta = await createOrderWithItems(x.venueId, {
      staffId,
      externalId: `d17-${randomUUID()}`,
      source: 'AVOQADO_ANDROID',
      items: [{ productId, quantity: 1, modifierIds: [extraId] }],
    } as any)

    const renglon = await prisma.orderItem.findFirstOrThrow({ where: { orderId: venta.id }, include: { modifiers: true } })
    expect(renglon.modifiers.map(m => m.modifierId)).toEqual([extraId])
    expect(Number(renglon.modifiers[0].price)).toBe(20)
  })

  it('quien administra lo sigue viendo apagado y lo puede volver a prender (las lecturas no cambian)', async () => {
    const x = await negocio()
    const { grupoId, extraId, lecheId } = await grupoConExtras(x)
    const esperado = [
      { id: extraId, active: false },
      { id: lecheId, active: true },
    ].sort((a, b) => a.id.localeCompare(b.id))

    await deleteModifier(x.venueId, grupoId, extraId)

    const [enLista] = await getModifierGroups(x.venueId) // lo que pinta el ANDROID viejo
    expect(extrasDe(enLista as any)).toEqual(esperado)
    expect(extrasDe(await getModifierGroupById(x.venueId, grupoId))).toEqual(esperado) // lo que abre el DASHBOARD

    await updateModifier(x.venueId, grupoId, extraId, { active: true } as any)
    expect(await prisma.modifier.findUniqueOrThrow({ where: { id: extraId }, select: { active: true } })).toEqual({ active: true })
  })

  it('repetirlo, o quitar uno que ya estaba apagado, contesta igual y lo deja apagado', async () => {
    const x = await negocio()
    const { grupoId, extraId, lecheId } = await grupoConExtras(x)
    await prisma.modifier.update({ where: { id: lecheId }, data: { active: false } }) // apagado a mano con «Activo»

    await deleteModifier(x.venueId, grupoId, extraId)
    await expect(deleteModifier(x.venueId, grupoId, extraId)).resolves.toBeUndefined()
    await expect(deleteModifier(x.venueId, grupoId, lecheId)).resolves.toBeUndefined()

    expect(await prisma.modifier.count({ where: { groupId: grupoId, active: false } })).toBe(2)
  })

  it('Codex r1 · «Combinar» un menú que trae el extra quitado no lo revive con su precio viejo: crea otro con el del archivo', async () => {
    const x = await negocio()
    const { productId, grupoId, extraId } = await grupoConExtras(x) // «Shot» a $20
    const corto = await ligaConExtra(x, productId, extraId)
    const ligaAntes = await getPaymentLinkByShortCode(corto)
    await deleteModifier(x.venueId, grupoId, extraId)

    const archivo = {
      mode: 'merge',
      categories: [
        {
          name: 'IVA',
          slug: `iva-${x.rfc}`.toLowerCase(),
          products: [
            {
              name: 'Café',
              sku: `P-${x.rfc}`,
              price: 100,
              modifierGroups: [
                {
                  name: 'Extras',
                  required: false,
                  allowMultiple: false,
                  minSelections: 0,
                  maxSelections: 1,
                  modifiers: [{ name: 'Shot', price: 25 }],
                },
              ],
            },
          ],
        },
      ],
    }
    await importMenu(x.venueId, archivo as any, { type: 'SERVICE', servicePrincipalId: 'D17_PRUEBA' } as any)

    expect(await prisma.modifier.findUniqueOrThrow({ where: { id: extraId }, select: { active: true, price: true } })).toEqual({
      active: false,
      price: new Prisma.Decimal(20),
    })
    const shots = await prisma.modifier.findMany({ where: { groupId: grupoId, name: 'Shot', active: true } })
    expect(shots.map(m => Number(m.price))).toEqual([25])
    expect(shots[0].id).not.toBe(extraId)
    expect(await getPaymentLinkByShortCode(corto)).toEqual(ligaAntes)
  })

  it('Codex r2 · quitar → «Combinar» → «Reemplazar»: revive el que estaba vivo, con su SKU, y el quitado se queda como estaba', async () => {
    const x = await negocio()
    const { grupoId, extraId } = await grupoConExtras(x) // «Shot» A a $20
    await prisma.modifier.update({ where: { id: extraId }, data: { sku: 'SHOT-A' } })
    await deleteModifier(x.venueId, grupoId, extraId)
    const conShot = (mode: 'merge' | 'replace', price: number) => ({
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
              modifierGroups: [
                {
                  name: 'Extras',
                  required: false,
                  allowMultiple: false,
                  minSelections: 0,
                  maxSelections: 1,
                  modifiers: [{ name: 'Shot', price }],
                },
              ],
            },
          ],
        },
      ],
    })
    const actor = { type: 'SERVICE', servicePrincipalId: 'D17_PRUEBA' } as any
    await importMenu(x.venueId, conShot('merge', 25) as any, actor)
    const b = await prisma.modifier.findFirstOrThrow({ where: { groupId: grupoId, name: 'Shot', active: true } })
    await prisma.modifier.update({ where: { id: b.id }, data: { sku: 'SHOT-B' } })

    await importMenu(x.venueId, conShot('replace', 30) as any, actor)

    const shots = await prisma.modifier.findMany({
      where: { name: 'Shot', group: { venueId: x.venueId } },
      select: { id: true, active: true, price: true, sku: true },
    })
    expect(shots.find(m => m.active)).toEqual({ id: b.id, active: true, price: new Prisma.Decimal(30), sku: 'SHOT-B' })
    expect(shots.find(m => m.id === extraId)).toEqual({ id: extraId, active: false, price: new Prisma.Decimal(20), sku: 'SHOT-A' })
  })

  it('Codex r4 · «Reemplazar» elige el que está vivo aunque sea el más viejo, y apaga lo que el archivo no trae', async () => {
    const x = await negocio()
    const { grupoId, extraId: a, lecheId } = await grupoConExtras(x) // A, el viejo
    const b = (await prisma.modifier.create({ data: { groupId: grupoId, name: 'Shot', price: 22 } })).id // B, el nuevo
    await deleteModifier(x.venueId, grupoId, b)
    const actor = { type: 'SERVICE', servicePrincipalId: 'D17_PRUEBA' } as any
    const archivo = {
      mode: 'replace',
      categories: [
        {
          name: 'IVA',
          slug: `iva-${x.rfc}`.toLowerCase(),
          products: [
            {
              name: 'Café',
              sku: `P-${x.rfc}`,
              price: 100,
              modifierGroups: [
                {
                  name: 'Extras',
                  required: false,
                  allowMultiple: false,
                  minSelections: 0,
                  maxSelections: 1,
                  modifiers: [{ name: 'Shot', price: 30 }],
                },
              ],
            },
          ],
        },
      ],
    }

    const r = await importMenu(x.venueId, archivo as any, actor)

    const estado = await prisma.modifier.findMany({ where: { groupId: grupoId }, select: { id: true, active: true, price: true } })
    expect(estado.find(m => m.id === a)).toEqual({ id: a, active: true, price: new Prisma.Decimal(30) })
    expect(estado.find(m => m.id === b)).toEqual({ id: b, active: false, price: new Prisma.Decimal(22) })
    expect(estado.find(m => m.id === lecheId)?.active).toBe(false) // el archivo no la trae
    expect(r.stats).toMatchObject({ modifiers: 1 })
  })

  // Regresión: los 404 de hoy
  it('de otro negocio o de otro grupo: 404 y no toca nada', async () => {
    const x = await negocio()
    const y = await negocio()
    const { grupoId, extraId } = await grupoConExtras(x)
    const otro = await prisma.modifierGroup.create({ data: { venueId: x.venueId, name: 'Salsas' } })

    await expect(deleteModifier(y.venueId, grupoId, extraId)).rejects.toMatchObject({ statusCode: 404 })
    await expect(deleteModifier(x.venueId, otro.id, extraId)).rejects.toMatchObject({ statusCode: 404 })
    expect(await prisma.modifier.findUniqueOrThrow({ where: { id: extraId }, select: { active: true } })).toEqual({ active: true })
  })
})
