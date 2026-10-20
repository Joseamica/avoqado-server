import { aggregateGiftCardLoads, aggregatePaymentsByMethod } from '@/services/legacy/mergedPayments.service'
import { prismaMock } from '@tests/__helpers__/setup'

const filtros = {
  fromDate: new Date('2026-10-14T06:00:00.000Z'),
  toDate: new Date('2026-10-15T05:59:59.999Z'),
  includeRefunds: true,
  excludeCancelledOrders: true,
}

beforeEach(() => {
  ;(prismaMock.payment.groupBy as jest.Mock).mockReset()
  ;(prismaMock.payment.aggregate as jest.Mock).mockReset()
  ;(prismaMock.venueTenderType.findMany as jest.Mock).mockReset()
})

describe('aggregatePaymentsByMethod · tarjetas de regalo', () => {
  it('🔴 lo pagado con saldo sale como GIFT_CARD (no OTHER) y las cuentas de tarjetas no entran', async () => {
    ;(prismaMock.payment.groupBy as jest.Mock).mockResolvedValue([
      { method: 'CASH', tenderTypeId: null, _sum: { amount: 300, tipAmount: 0 }, _count: { _all: 1 } },
      { method: 'OTHER', tenderTypeId: 'tender-gc', _sum: { amount: 200, tipAmount: 10 }, _count: { _all: 1 } },
      { method: 'OTHER', tenderTypeId: 'vale', _sum: { amount: 50, tipAmount: 0 }, _count: { _all: 1 } },
    ])
    ;(prismaMock.venueTenderType.findMany as jest.Mock).mockResolvedValue([{ id: 'tender-gc' }])
    const filas = await aggregatePaymentsByMethod('v1', filtros)
    expect(filas).toEqual(
      expect.arrayContaining([
        { method: 'CASH', amount: 300, tips: 0, count: 1 },
        { method: 'GIFT_CARD', amount: 200, tips: 10, count: 1 },
        { method: 'OTHER', amount: 50, tips: 0, count: 1 },
      ]),
    )
    const llamada = (prismaMock.payment.groupBy as jest.Mock).mock.calls[0][0]
    expect(llamada.by).toEqual(['method', 'tenderTypeId'])
    expect(llamada.where.AND[1]).toEqual({ order: { items: { none: { giftCardId: { not: null } } } } })
    expect((prismaMock.venueTenderType.findMany as jest.Mock).mock.calls[0][0].where).toEqual({
      venueId: 'v1',
      id: { in: ['tender-gc', 'vale'] },
      systemKind: 'GIFT_CARD',
    })
  })

  it('regresión: sin tenders, ninguna consulta extra', async () => {
    ;(prismaMock.payment.groupBy as jest.Mock).mockResolvedValue([
      { method: 'CASH', tenderTypeId: null, _sum: { amount: 100, tipAmount: 0 }, _count: { _all: 2 } },
    ])
    expect(await aggregatePaymentsByMethod('v1', filtros)).toEqual([{ method: 'CASH', amount: 100, tips: 0, count: 2 }])
    expect(prismaMock.venueTenderType.findMany).not.toHaveBeenCalled()
  })
})

describe('aggregatePaymentsByMethod · vista de DINERO (r1, Fix 1)', () => {
  it('🔴 la carga de una tarjeta se queda en su método real y lo pagado con saldo no entra (no es dinero nuevo)', async () => {
    ;(prismaMock.payment.groupBy as jest.Mock).mockResolvedValue([
      { method: 'CASH', tenderTypeId: null, _sum: { amount: 300, tipAmount: 0 }, _count: { _all: 1 } },
      { method: 'CREDIT_CARD', tenderTypeId: null, _sum: { amount: 500, tipAmount: 0 }, _count: { _all: 1 } },
      { method: 'OTHER', tenderTypeId: 'vale', _sum: { amount: 50, tipAmount: 0 }, _count: { _all: 1 } },
    ])
    const filas = await aggregatePaymentsByMethod('v1', filtros, 'dinero')
    expect(filas).toEqual([
      { method: 'CASH', amount: 300, tips: 0, count: 1 },
      { method: 'CREDIT_CARD', amount: 500, tips: 0, count: 1 },
      { method: 'OTHER', amount: 50, tips: 0, count: 1 },
    ])
    const llamada = (prismaMock.payment.groupBy as jest.Mock).mock.calls[0][0]
    // Sin el filtro de cuentas de tarjetas (la carga es dinero real) y SIN lo pagado con saldo (la marca NULL-safe de B1).
    expect(llamada.where.AND[1]).toEqual({ OR: [{ tenderTypeId: null }, { tenderType: { is: { systemKind: null } } }] })
    // Sin saldo en el resultado no hace falta preguntar qué tender es el de sistema.
    expect(prismaMock.venueTenderType.findMany).not.toHaveBeenCalled()
  })
})

describe('aggregateGiftCardLoads', () => {
  it('suma sólo cuentas de tarjetas PAGADAS (cargas menos cancelaciones) y cuenta sólo las cargas, no los reembolsos (r1, M-1)', async () => {
    ;(prismaMock.payment.groupBy as jest.Mock).mockResolvedValue([
      { type: 'REGULAR', _sum: { amount: 800 }, _count: { _all: 2 } },
      { type: 'REFUND', _sum: { amount: -300 }, _count: { _all: 1 } },
    ])
    expect(await aggregateGiftCardLoads('v1', filtros)).toEqual({ amount: 500, count: 2 })
    const llamada = (prismaMock.payment.groupBy as jest.Mock).mock.calls[0][0]
    expect(llamada.by).toEqual(['type'])
    // Un abono a una venta de tarjetas SIN pagar no es una tarjeta cargada (sus sobres siguen PENDING, valen $0).
    expect(llamada.where.AND[1]).toEqual({
      order: { AND: [{ items: { some: { giftCardId: { not: null } } } }, { paymentStatus: 'PAID' }] },
    })
  })
})
