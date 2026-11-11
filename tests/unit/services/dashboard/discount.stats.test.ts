/**
 * S9 (P2-5, codex-faseA-r6 #6; decisión 28 del plan): las estadísticas de descuentos no cuentan las cuentas canceladas o borradas. La
 * cortesía de un folio que nunca se pagó sumaba un canje y su ahorro. Y ya no traen todas las filas del negocio para sumarlas en
 * memoria: los totales salen de `aggregate` y el top de `groupBy` (con tope), en la base.
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { getDiscountStats } from '@/services/dashboard/discount.dashboard.service'

const D = (v: number) => new Prisma.Decimal(v)
const VENUE = 'venue-123'
const VIVA = { venueId: VENUE, status: { notIn: ['CANCELLED', 'DELETED'] } }

beforeEach(() => {
  prismaMock.discount.count.mockReset()
  prismaMock.discount.findMany.mockReset()
  prismaMock.orderDiscount.aggregate.mockReset()
  prismaMock.orderDiscount.groupBy.mockReset()
  prismaMock.orderDiscount.findMany.mockReset()
})

describe('getDiscountStats (S9)', () => {
  it('no cuenta cuentas CANCELLED ni DELETED y lee con aggregate/groupBy, sin traer las filas', async () => {
    prismaMock.discount.count.mockResolvedValueOnce(10).mockResolvedValueOnce(8).mockResolvedValueOnce(3)
    prismaMock.orderDiscount.aggregate.mockResolvedValue({ _count: { _all: 3 }, _sum: { amount: D(30) } })
    prismaMock.orderDiscount.groupBy.mockResolvedValue([
      { discountId: 'd1', _count: { _all: 2 }, _sum: { amount: D(25) } },
      { discountId: 'd2', _count: { _all: 1 }, _sum: { amount: D(5) } },
    ])
    prismaMock.discount.findMany.mockResolvedValue([
      { id: 'd2', name: 'Discount 2', type: 'FIXED_AMOUNT' },
      { id: 'd1', name: 'Discount 1', type: 'PERCENTAGE' },
    ])

    const r = await getDiscountStats(VENUE)

    expect(prismaMock.orderDiscount.aggregate).toHaveBeenCalledWith({
      where: { order: VIVA },
      _count: { _all: true },
      _sum: { amount: true },
    })
    expect(prismaMock.orderDiscount.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ by: ['discountId'], where: { order: VIVA, discountId: { not: null } }, take: 5 }),
    )
    expect(prismaMock.discount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: VENUE, id: { in: ['d1', 'd2'] } } }),
    )
    expect(prismaMock.orderDiscount.findMany).not.toHaveBeenCalled()
    expect(r).toEqual({
      totalDiscounts: 10,
      activeDiscounts: 8,
      automaticDiscounts: 3,
      totalRedemptions: 3,
      totalSaved: 30,
      topDiscounts: [
        { id: 'd1', name: 'Discount 1', type: 'PERCENTAGE', redemptions: 2, totalSaved: 25 },
        { id: 'd2', name: 'Discount 2', type: 'FIXED_AMOUNT', redemptions: 1, totalSaved: 5 },
      ],
    })
  })

  it('sin canjes: ceros y sin buscar nombres', async () => {
    prismaMock.discount.count.mockResolvedValue(0)
    prismaMock.orderDiscount.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { amount: null } })
    prismaMock.orderDiscount.groupBy.mockResolvedValue([])

    const r = await getDiscountStats(VENUE)

    expect(r).toMatchObject({ totalRedemptions: 0, totalSaved: 0, topDiscounts: [] })
    expect(prismaMock.discount.findMany).not.toHaveBeenCalled()
  })

  it('un descuento del top que ya no existe (borrado) no sale en la lista', async () => {
    prismaMock.discount.count.mockResolvedValue(1)
    prismaMock.orderDiscount.aggregate.mockResolvedValue({ _count: { _all: 2 }, _sum: { amount: D(20) } })
    prismaMock.orderDiscount.groupBy.mockResolvedValue([
      { discountId: 'd1', _count: { _all: 1 }, _sum: { amount: D(10) } },
      { discountId: 'otro-negocio', _count: { _all: 1 }, _sum: { amount: D(10) } },
    ])
    prismaMock.discount.findMany.mockResolvedValue([{ id: 'd1', name: 'Discount 1', type: 'PERCENTAGE' }])

    const r = await getDiscountStats(VENUE)

    expect(r.topDiscounts.map(d => d.id)).toEqual(['d1'])
  })
})
