/**
 * Etapa 3 del KDS (spec 2026-09-27 §2 y §5): cada ronda de mesa produce SU comanda de pantalla, con folio
 * round:<roundKey> cuando la app manda llaves; la misma ronda repetida desde la cola no duplica nada; y una ronda
 * de la caja de Windows (sin llaves, asNewRound=false) también produce la suya.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { addItemsToOrder } from '@/services/tpv/order.tpv.service'

const SUF = `kdsrondas-${Date.now()}`
const haceUnaHora = new Date(Date.now() - 60 * 60 * 1000)
let orgId: string
let venueId: string
let sinPantalla: string
let cocina: string
let taco: string
let tacoSinPantalla: string
let mesa = 0

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Rondas ${SUF}`, email: `${SUF}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  const venue = async (n: string) =>
    (await prisma.venue.create({ data: { organizationId: orgId, name: `${n} ${SUF}`, slug: `${n}-${SUF}` } })).id
  venueId = await venue('con')
  sinPantalla = await venue('sin')
  cocina = (
    await prisma.printStation.create({
      data: { venueId, name: 'Cocina', isDefault: true, hasKitchenDisplay: true, kitchenDisplaySince: haceUnaHora },
    })
  ).id
  await prisma.printStation.create({ data: { venueId: sinPantalla, name: 'Cocina', isDefault: true } })
  const producto = async (v: string, sku: string) => {
    const categoria = (await prisma.menuCategory.create({ data: { venueId: v, name: 'Comida', slug: `comida-${sku}` } })).id
    return (await prisma.product.create({ data: { venueId: v, sku, name: 'Taco', categoryId: categoria, price: new Prisma.Decimal(50) } }))
      .id
  }
  taco = await producto(venueId, `taco-${SUF}`)
  tacoSinPantalla = await producto(sinPantalla, `taco2-${SUF}`)
})

afterAll(async () => {
  if (!orgId) return
  const venues = [venueId, sinPantalla]
  await prisma.kdsOrder.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.order.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.table.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.product.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.menuCategory.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.printStation.deleteMany({ where: { venueId: { in: venues } } })
  await prisma.venue.deleteMany({ where: { id: { in: venues } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

async function cuentaDeMesa(v = venueId) {
  mesa += 1
  const tableId = (await prisma.table.create({ data: { venueId: v, number: `${mesa}`, capacity: 4, qrCode: `qr-${mesa}-${SUF}` } })).id
  return prisma.order.create({
    data: { venueId: v, orderNumber: `M-${mesa}-${SUF}`, tableId, subtotal: 0, taxAmount: 0, total: 0 },
    select: { id: true },
  })
}
const version = async (id: string) => (await prisma.order.findUniqueOrThrow({ where: { id } })).version
const comandas = (orderId: string) =>
  prisma.kdsOrder.findMany({ where: { orderId }, include: { items: true }, orderBy: { createdAt: 'asc' }, take: 20 })

describe('addItemsToOrder — comanda de pantalla por ronda', () => {
  it('ronda con llaves sync:<roundKey>:<idx> ⇒ comanda round:<roundKey>:<estación> y marca limpia', async () => {
    const o = await cuentaDeMesa()
    await addItemsToOrder(venueId, o.id, [{ productId: taco, quantity: 2, externalId: 'sync:rk-1:0' } as any], await version(o.id), true)
    const [k] = await comandas(o.id)
    expect(k.sourceKey).toBe(`round:rk-1:${cocina}`)
    expect(k.items.map(i => [i.productName, i.quantity])).toEqual([['Taco', 2]])
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).kitchenPendingAt).toBeNull()
  })

  it('🔴 la MISMA ronda repetida desde la cola (mismas llaves) no duplica la cuenta ni la comanda', async () => {
    const o = await cuentaDeMesa()
    const ronda = [{ productId: taco, quantity: 2, externalId: 'sync:rk-2:0' } as any]
    await addItemsToOrder(venueId, o.id, ronda, await version(o.id), true)
    await addItemsToOrder(venueId, o.id, ronda, await version(o.id), true)
    expect(await prisma.orderItem.count({ where: { orderId: o.id } })).toBe(1)
    const ks = await comandas(o.id)
    expect(ks).toHaveLength(1)
    expect(ks[0].items).toHaveLength(1)
  })

  it('dos rondas distintas ⇒ dos comandas', async () => {
    const o = await cuentaDeMesa()
    await addItemsToOrder(venueId, o.id, [{ productId: taco, quantity: 1, externalId: 'sync:rk-3:0' } as any], await version(o.id), true)
    await addItemsToOrder(venueId, o.id, [{ productId: taco, quantity: 1, externalId: 'sync:rk-4:0' } as any], await version(o.id), true)
    expect((await comandas(o.id)).map(k => k.sourceKey)).toEqual([`round:rk-3:${cocina}`, `round:rk-4:${cocina}`])
  })

  it('ronda de la caja de Windows (asNewRound=false, sin llaves) ⇒ su comanda y el renglón queda enviado', async () => {
    const o = await cuentaDeMesa()
    await addItemsToOrder(venueId, o.id, [{ productId: taco, quantity: 1 } as any], await version(o.id), false)
    const [k] = await comandas(o.id)
    expect(k.sourceKey).toMatch(new RegExp(`^round:${o.id}:\\d+:${cocina}$`))
    const [renglon] = await prisma.orderItem.findMany({ where: { orderId: o.id }, take: 5 })
    expect(renglon.sentToKitchenAt).toBeInstanceOf(Date)
  })

  it('un importe libre con llave repetido no se cobra dos veces', async () => {
    const o = await cuentaDeMesa()
    const libre = [{ customName: 'Propina de cocina', customUnitPriceCents: 3000, quantity: 1, externalId: 'sync:rk-5:0' } as any]
    await addItemsToOrder(venueId, o.id, libre, await version(o.id), true)
    await addItemsToOrder(venueId, o.id, libre, await version(o.id), true)
    expect(await prisma.orderItem.count({ where: { orderId: o.id } })).toBe(1)
  })

  it('negocio sin pantalla: ni marca ni comanda', async () => {
    const o = await cuentaDeMesa(sinPantalla)
    await addItemsToOrder(
      sinPantalla,
      o.id,
      [{ productId: tacoSinPantalla, quantity: 1, externalId: 'sync:rk-6:0' } as any],
      await version(o.id),
      true,
    )
    expect(await comandas(o.id)).toHaveLength(0)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).kitchenPendingAt).toBeNull()
  })
})
