jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staffVenue: { findFirst: jest.fn() },
    orderCustomer: { findMany: jest.fn() },
    order: { updateMany: jest.fn() },
    orderItem: { findFirst: jest.fn() },
    // Cambio de producto: por default la venta no es la nueva de un cambio ni tiene cobros con crédito de cambio.
    payment: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }) },
    exchange: { findUnique: jest.fn().mockResolvedValue(null) },
  },
}))
jest.mock('@/services/dashboard/loyalty.dashboard.service', () => ({ earnPoints: jest.fn() }))
jest.mock('@/services/dashboard/customer.dashboard.service', () => ({ updateCustomerMetrics: jest.fn() }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import prisma from '@/utils/prismaClient'
import { earnPoints } from '@/services/dashboard/loyalty.dashboard.service'
import { updateCustomerMetrics } from '@/services/dashboard/customer.dashboard.service'
import { awardLoyaltyForPaidOrder } from '@/services/shared/loyaltyOnPaidOrder'

const p = prisma as unknown as {
  orderCustomer: { findMany: jest.Mock }
  order: { updateMany: jest.Mock }
  orderItem: { findFirst: jest.Mock }
  staffVenue: { findFirst: jest.Mock }
}

beforeEach(() => {
  jest.clearAllMocks()
  p.staffVenue.findFirst.mockResolvedValue({ id: 'sv1' })
  p.orderCustomer.findMany.mockResolvedValue([
    { customerId: 'c1', isPrimary: true, customer: { id: 'c1', firstName: 'Ana', lastName: null } },
  ])
  p.order.updateMany.mockResolvedValue({ count: 1 })
})

describe('awardLoyaltyForPaidOrder · tarjetas de regalo (R1)', () => {
  it('🔴 vender una tarjeta no da métricas de gasto, puntos ni sello, y la cuenta queda procesada', async () => {
    p.orderItem.findFirst.mockResolvedValueOnce({ id: 'oi-gc' }).mockResolvedValueOnce(null)
    const r = await awardLoyaltyForPaidOrder({ venueId: 'v1', orderId: 'o-gc', orderTotal: 500, staffId: 's1' })
    expect(r).toEqual({ complete: true, errors: [] })
    expect(updateCustomerMetrics).not.toHaveBeenCalled()
    expect(earnPoints).not.toHaveBeenCalled()
    expect(p.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ loyaltyProcessedAt: expect.any(Date) }) }),
    )
  })

  it('regresión: una compra (aunque se pague con saldo) acredita como siempre', async () => {
    p.orderItem.findFirst.mockResolvedValueOnce(null)
    ;(earnPoints as jest.Mock).mockResolvedValue({ pointsEarned: 5, newBalance: 5 })
    await awardLoyaltyForPaidOrder({ venueId: 'v1', orderId: 'o-merc', orderTotal: 200, staffId: 's1' })
    expect(updateCustomerMetrics).toHaveBeenCalledWith('c1', 200, 'o-merc', 'v1')
    expect(earnPoints).toHaveBeenCalledWith('v1', 'c1', 200, 'o-merc', 'sv1')
  })
})
