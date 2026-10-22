/**
 * Lealtad de la venta nueva de un cambio de producto (spec 2026-10-20 §7.7):
 *   · los puntos salen sólo de lo cobrado de más: lo pagado con «Crédito de cambio» ya dio puntos en la venta original;
 *   · la venta nueva de un cambio no da sello (no es una visita nueva), aunque el crédito sea $0;
 *   · una venta que no es de un cambio sigue EXACTAMENTE como hoy.
 */

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffVenue: { findFirst: jest.fn() },
    orderCustomer: { findMany: jest.fn() },
    order: { updateMany: jest.fn() },
    orderItem: { findFirst: jest.fn() },
    payment: { aggregate: jest.fn() },
    exchange: { findUnique: jest.fn() },
  },
}))
jest.mock('@/services/dashboard/loyalty.dashboard.service', () => ({ earnPoints: jest.fn() }))
jest.mock('@/services/dashboard/customer.dashboard.service', () => ({ updateCustomerMetrics: jest.fn() }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { earnPoints } from '@/services/dashboard/loyalty.dashboard.service'
import { updateCustomerMetrics } from '@/services/dashboard/customer.dashboard.service'
import { awardLoyaltyForPaidOrder } from '@/services/shared/loyaltyOnPaidOrder'
import { WHERE_PAYMENT_IS_EXCHANGE_CREDIT } from '@/services/exchanges/exchangeMarks'
import logger from '@/config/logger'

const p = prisma as unknown as {
  staffVenue: { findFirst: jest.Mock }
  orderCustomer: { findMany: jest.Mock }
  order: { updateMany: jest.Mock }
  orderItem: { findFirst: jest.Mock }
  payment: { aggregate: jest.Mock }
  exchange: { findUnique: jest.Mock }
}
const earnPointsMock = earnPoints as jest.Mock
const metricsMock = updateCustomerMetrics as jest.Mock

const venueId = 'venue-1'
const orderId = 'order-new'
const customerId = 'cust-1'

/** Lo pagado con crédito de cambio en la venta (`null` = ningún cobro con crédito). */
const conCredito = (pesos: number | null) =>
  p.payment.aggregate.mockResolvedValue({ _sum: { amount: pesos === null ? null : new Prisma.Decimal(pesos) } })
/** ¿La venta es la nueva de un cambio? */
const esVentaNueva = (si: boolean) => p.exchange.findUnique.mockResolvedValue(si ? { id: 'exch-1' } : null)

beforeEach(() => {
  jest.clearAllMocks()
  p.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1' })
  p.orderItem.findFirst.mockResolvedValue(null) // no es una cuenta de tarjetas de regalo
  p.orderCustomer.findMany.mockResolvedValue([
    { customerId, isPrimary: true, customer: { id: customerId, firstName: 'Ana', lastName: null } },
  ])
  p.order.updateMany.mockResolvedValue({ count: 1 })
  earnPointsMock.mockResolvedValue({ pointsEarned: 0, newBalance: 0 })
  metricsMock.mockResolvedValue(undefined)
  conCredito(null)
  esVentaNueva(false)
})

describe('awardLoyaltyForPaidOrder · new sale of a product exchange', () => {
  it('does not award points nor stamp when the order was fully paid with EXCHANGE_CREDIT (even exchange)', async () => {
    esVentaNueva(true)
    conCredito(500)

    const r = await awardLoyaltyForPaidOrder({ venueId, orderId, orderTotal: 500, staffId: 'staff-1' })

    expect(earnPointsMock).not.toHaveBeenCalled()
    // Ni visita (no es una visita nueva) ni gasto (no se cobró nada de más).
    expect(metricsMock).not.toHaveBeenCalled()
    // Nada que dar no es un fallo: la venta queda procesada y el reconciliador no la repite.
    expect(r).toEqual({ complete: true, errors: [] })
    expect(p.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ loyaltyProcessedAt: expect.any(Date) }) }),
    )
    // Lo pagado con crédito se suma con la marca EXACTA del tender, sin reembolsos y sólo lo capturado de ESTA venta.
    expect(p.payment.aggregate).toHaveBeenCalledWith({
      where: {
        orderId,
        venueId,
        status: 'COMPLETED',
        AND: [{ OR: [{ type: null }, { type: { not: 'REFUND' } }] }, WHERE_PAYMENT_IS_EXCHANGE_CREDIT],
      },
      _sum: { amount: true },
    })
    expect(p.exchange.findUnique).toHaveBeenCalledWith({ where: { newOrderId: orderId }, select: { id: true } })
  })

  it('awards points on the collected difference only, without stamp', async () => {
    // orderTotal 500, cobros REGULAR COMPLETED: crédito de cambio 400 + efectivo 100.
    esVentaNueva(true)
    conCredito(400)

    await awardLoyaltyForPaidOrder({ venueId, orderId, orderTotal: 500 })

    expect(earnPointsMock).toHaveBeenCalledWith(venueId, customerId, 100, orderId, undefined, { skipStamp: true })
  })

  it('the new sale of an exchange adds only the charged base to the spend and no visit, for every customer of the sale', async () => {
    p.orderCustomer.findMany.mockResolvedValue([
      { customerId, isPrimary: true, customer: { id: customerId, firstName: 'Ana', lastName: null } },
      { customerId: 'cust-2', isPrimary: false, customer: { id: 'cust-2', firstName: 'Beto', lastName: null } },
    ])
    esVentaNueva(true)
    conCredito(400)

    await awardLoyaltyForPaidOrder({ venueId, orderId, orderTotal: 500 })

    expect(metricsMock.mock.calls).toEqual([
      [customerId, 100, orderId, venueId, { skipVisit: true }],
      ['cust-2', 100, orderId, venueId, { skipVisit: true }],
    ])
  })

  it('the points log keeps the real total and names the reduced base apart', async () => {
    esVentaNueva(true)
    conCredito(400)
    earnPointsMock.mockResolvedValue({ pointsEarned: 100, newBalance: 100 })

    await awardLoyaltyForPaidOrder({ venueId, orderId, orderTotal: 500 })

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Loyalty points earned'),
      expect.objectContaining({ orderTotal: 500, base: 100 }),
    )
  })

  it('a credit greater than the order total is clamped: base 0, no earnPoints call, no stamp and no metrics', async () => {
    esVentaNueva(true)
    conCredito(600)

    const r = await awardLoyaltyForPaidOrder({ venueId, orderId, orderTotal: 500, staffId: 'staff-1' })

    expect(earnPointsMock).not.toHaveBeenCalled()
    expect(metricsMock).not.toHaveBeenCalled()
    expect(r).toEqual({ complete: true, errors: [] })
  })

  it('R=0, N=10000: the new sale earns points on 10000 but no new stamp', async () => {
    // N = 10000 centavos ($100) y nada regresado: no hay cobro con crédito, pero sigue siendo la venta nueva de un cambio.
    esVentaNueva(true)
    conCredito(null)

    await awardLoyaltyForPaidOrder({ venueId, orderId, orderTotal: 100, staffId: 'staff-1' })

    expect(earnPointsMock).toHaveBeenCalledWith(venueId, customerId, 100, orderId, 'sv-1', { skipStamp: true })
  })

  it('keeps today behavior for an order without EXCHANGE_CREDIT payments (stamp and points on 500)', async () => {
    await awardLoyaltyForPaidOrder({ venueId, orderId, orderTotal: 500, staffId: 'staff-1' })

    // Exactamente los cinco argumentos de siempre: sin opciones, `earnPoints` sella como hoy.
    expect(earnPointsMock.mock.calls).toEqual([[venueId, customerId, 500, orderId, 'sv-1']])
    // Y las métricas con los cuatro argumentos de siempre: la visita y el total, como hoy.
    expect(metricsMock.mock.calls).toEqual([[customerId, 500, orderId, venueId]])
  })

  it('keeps today behavior for a $0 order that is not an exchange (earnPoints still decides the stamp)', async () => {
    await awardLoyaltyForPaidOrder({ venueId, orderId, orderTotal: 0, staffId: 'staff-1' })

    expect(earnPointsMock.mock.calls).toEqual([[venueId, customerId, 0, orderId, 'sv-1']])
  })

  it('the legacy single customer path applies the same exchange rule', async () => {
    p.orderCustomer.findMany.mockResolvedValue([])
    esVentaNueva(true)
    conCredito(400)

    await awardLoyaltyForPaidOrder({
      venueId,
      orderId,
      orderTotal: 500,
      staffId: 'staff-1',
      legacyCustomer: { id: 'cust-legacy', firstName: 'Leo', lastName: null },
    })

    expect(earnPointsMock).toHaveBeenCalledWith(venueId, 'cust-legacy', 100, orderId, 'sv-1', { skipStamp: true })
  })

  it('the stamp is skipped for being the new sale of an exchange, not for the credit amount', async () => {
    // Un cobro con crédito en una venta que no es la nueva de un cambio: el crédito se resta, el sello no se toca.
    esVentaNueva(false)
    conCredito(400)

    await awardLoyaltyForPaidOrder({ venueId, orderId, orderTotal: 500, staffId: 'staff-1' })

    expect(earnPointsMock.mock.calls).toEqual([[venueId, customerId, 100, orderId, 'sv-1']])
    expect(metricsMock.mock.calls).toEqual([[customerId, 500, orderId, venueId]])
  })

  it('if reading the exchange credit fails, no points are given on the full total and the order stays pending', async () => {
    esVentaNueva(true)
    p.payment.aggregate.mockRejectedValue(new Error('P1001'))

    const r = await awardLoyaltyForPaidOrder({ venueId, orderId, orderTotal: 500, staffId: 'staff-1' })

    expect(earnPointsMock).not.toHaveBeenCalled()
    expect(r.complete).toBe(false)
    expect(r.errors.join(' ')).toContain('P1001')
  })

  it('a sale without a customer does not read the exchange (nothing to credit)', async () => {
    p.orderCustomer.findMany.mockResolvedValue([])

    const r = await awardLoyaltyForPaidOrder({ venueId, orderId, orderTotal: 500 })

    expect(r.complete).toBe(true)
    expect(p.payment.aggregate).not.toHaveBeenCalled()
    expect(p.exchange.findUnique).not.toHaveBeenCalled()
    expect(earnPointsMock).not.toHaveBeenCalled()
  })
})
