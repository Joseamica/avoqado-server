import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { leerCobradoDeLaOrden, leerCobradoDeLasOrdenes, NO_SE_PUEDE_POR_ARTICULOS } from '@/services/fiscal/cobradoDeLaOrden'
import { TOPES_POR_ORDEN } from '@/services/fiscal/librosDeOrdenes'
import { crearNegocioDePrueba, limpiarNegocioDePrueba } from '../giftCards/sembrarTarjetasDeRegalo'
import { clienteQueCuenta } from '../exchanges/contarConsultas'

const D = (value: number) => new Prisma.Decimal(value)
type Venue = Awaited<ReturnType<typeof crearNegocioDePrueba>>
let venue: Venue
let otherVenue: Venue
let plain: string
let discounted: string
let promo: string
let oversized: string
let tooManyDiscounts: string
let foreign: string
let orderNumber = 0
const counter = clienteQueCuenta()

async function seedOrder(owner: Venue, count = 2) {
  return prisma.order.create({
    data: {
      venueId: owner.venueId,
      createdById: owner.staffId,
      orderNumber: `B1-${owner.venueId}-${orderNumber++}`,
      type: 'TAKEOUT',
      source: 'AVOQADO_IOS',
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      contratoDePrecio: 'IVA_INCLUIDO',
      subtotal: D(100 * count),
      total: D(100 * count),
      taxAmount: D(0),
      items: {
        create: Array.from({ length: count }, () => ({
          productName: 'Shirt',
          quantity: 1,
          unitPrice: D(100),
          total: D(100),
          taxAmount: D(0),
          ivaTratamiento: 'IVA_16' as const,
        })),
      },
    },
    include: { items: { orderBy: { id: 'asc' } } },
  })
}

beforeAll(async () => {
  expect(new URL(process.env.TEST_DATABASE_URL!).pathname).toMatch(/^\/avoqado_(?:cambio_(?:fix_|r5_)?test_\d{8}|h1a_test_\d{8}(?:_\d+)?)$/)
  venue = await crearNegocioDePrueba('batch-charged')
  otherVenue = await crearNegocioDePrueba('batch-charged-foreign')
  plain = (await seedOrder(venue)).id
  const sale = await seedOrder(venue)
  discounted = sale.id
  await prisma.order.update({ where: { id: discounted }, data: { discountAmount: D(20), total: D(180) } })
  await prisma.orderDiscount.create({
    data: {
      orderId: discounted,
      type: 'FIXED_AMOUNT',
      name: 'Account discount',
      value: D(20),
      amount: D(20),
      reparto: {
        v: 1,
        alcance: 'CUENTA',
        conPromociones: true,
        espejo: false,
        renglones: { [sale.items[0].id]: 1000, [sale.items[1].id]: 1000 },
      },
    },
  })
  const promotion = await prisma.promotion.create({
    data: {
      venueId: venue.venueId,
      name: '2x1',
      type: 'BUNDLE',
      pricingMode: 'PER_UNIT',
      daysOfWeek: [],
    },
  })
  const promoSale = await seedOrder(venue)
  promo = promoSale.id
  const instance = await prisma.orderPromotion.create({
    data: {
      orderId: promo,
      promotionId: promotion.id,
      instanceId: promo,
      snapshotJson: { name: '2x1' },
      grossCents: 20000,
      discountCents: 10000,
      netCents: 10000,
    },
  })
  await prisma.orderItem.updateMany({ where: { orderId: promo }, data: { orderPromotionId: instance.id, discountAmount: D(50) } })
  await prisma.order.update({ where: { id: promo }, data: { discountAmount: D(100), total: D(100) } })
  oversized = (await seedOrder(venue, TOPES_POR_ORDEN.renglones + 1)).id
  tooManyDiscounts = (await seedOrder(venue, 1)).id
  await prisma.orderDiscount.createMany({
    data: Array.from({ length: TOPES_POR_ORDEN.descuentos + 1 }, () => ({
      orderId: tooManyDiscounts,
      type: 'FIXED_AMOUNT' as const,
      name: 'Zero discount',
      value: D(0),
      amount: D(0),
    })),
  })
  foreign = (await seedOrder(otherVenue)).id
})

afterEach(() => jest.restoreAllMocks())
afterAll(async () => {
  if (venue?.venueId) await limpiarNegocioDePrueba(venue.venueId)
  if (otherVenue?.venueId) await limpiarNegocioDePrueba(otherVenue.venueId)
  await counter.cerrar()
})

describe('leerCobradoDeLasOrdenes (batch of leerCobradoDeLaOrden)', () => {
  it('matches the individual reader for a plain sale, account reparto and 2x1 promotion', async () => {
    const ids = [plain, discounted, promo]
    const batch = await leerCobradoDeLasOrdenes(prisma, venue.venueId, ids)
    expect(batch.size).toBe(3)
    for (const id of ids) {
      expect(batch.get(id)).toEqual(await leerCobradoDeLaOrden(prisma, id))
      expect(batch.get(id)?.atribuible).toBe(true)
    }
    expect([...batch.get(plain)!.cobradoCents.values()]).toEqual([10000, 10000])
    expect([...batch.get(discounted)!.cobradoCents.values()]).toEqual([9000, 9000])
    expect([...batch.get(promo)!.cobradoCents.values()]).toEqual([5000, 5000])
  })

  it.each(['lines', 'discounts'] as const)('rejects excess %s without loading that order items or discounts', async kind => {
    const id = kind === 'lines' ? oversized : tooManyDiscounts
    const individual = await leerCobradoDeLaOrden(prisma, id)
    const itemsRead = jest.spyOn(prisma.orderItem, 'findMany')
    const discountsRead = jest.spyOn(prisma, '$queryRaw')
    const batch = await leerCobradoDeLasOrdenes(prisma, venue.venueId, [id, plain])
    expect(batch.get(id)).toEqual({ atribuible: false, motivo: NO_SE_PUEDE_POR_ARTICULOS.TOPE, renglones: [], cobradoCents: new Map() })
    expect(batch.get(id)?.atribuible).toBe(individual.atribuible)
    expect(batch.get(id)?.motivo).toBe(individual.motivo)
    expect(itemsRead).toHaveBeenCalledTimes(1)
    expect(itemsRead).toHaveBeenCalledWith(expect.objectContaining({ take: 2, where: { orderId: { in: [plain] } } }))
    expect(discountsRead).toHaveBeenCalledTimes(1)
    const query = discountsRead.mock.calls[0][0] as Prisma.Sql
    expect(query.values).toEqual([plain])
    expect(query.sql).not.toContain('LIMIT')
    expect(batch.get(plain)).toEqual(await leerCobradoDeLaOrden(prisma, plain))
  })

  it('excludes orders from another venue and missing orders', async () => {
    const batch = await leerCobradoDeLasOrdenes(prisma, venue.venueId, [plain, foreign, venue.venueId])
    expect([...batch.keys()]).toEqual([plain])
  })

  it('uses the same SQL statement count for one order and three orders', async () => {
    await counter.db.$connect()
    await counter.reiniciar()
    await leerCobradoDeLasOrdenes(counter.db, venue.venueId, [plain])
    const one = await counter.consultas()
    await counter.reiniciar()
    await leerCobradoDeLasOrdenes(counter.db, venue.venueId, [plain, discounted, promo])
    expect(one).toBe(3)
    expect(await counter.consultas()).toBe(one)
  })

  it('returns an empty map without SQL for an empty input', async () => {
    await counter.reiniciar()
    expect(await leerCobradoDeLasOrdenes(counter.db, venue.venueId, [])).toEqual(new Map())
    expect(await counter.consultas()).toBe(0)
  })

  it('returns only the cap rejection when no order fits', async () => {
    const itemsRead = jest.spyOn(prisma.orderItem, 'findMany')
    const discountsRead = jest.spyOn(prisma, '$queryRaw')
    const batch = await leerCobradoDeLasOrdenes(prisma, venue.venueId, [oversized, tooManyDiscounts])
    expect(batch.size).toBe(2)
    for (const result of batch.values())
      expect(result).toMatchObject({ atribuible: false, motivo: NO_SE_PUEDE_POR_ARTICULOS.TOPE, renglones: [] })
    expect(itemsRead).not.toHaveBeenCalled()
    expect(discountsRead).not.toHaveBeenCalled()
  })
})
