const settleOrderMock = jest.fn()
const settleCustomerBalanceMock = jest.fn()

jest.mock('@/services/dashboard/order.dashboard.service', () => ({
  settleOrder: (...args: unknown[]) => settleOrderMock(...args),
}))
jest.mock('@/services/dashboard/customer.dashboard.service', () => ({
  settleCustomerBalance: (...args: unknown[]) => settleCustomerBalanceMock(...args),
}))

import { settleOrder } from '@/controllers/dashboard/order.dashboard.controller'
import { settleCustomerBalance } from '@/controllers/dashboard/customer.dashboard.controller'

function response() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }
}

beforeEach(() => jest.clearAllMocks())

it('settleOrder pasa authContext.userId y nunca un staffId declarativo del body', async () => {
  settleOrderMock.mockResolvedValue({ settledAmount: 100 })
  const req = {
    params: { venueId: 'venue-1', orderId: 'order-1' },
    body: { notes: 'efectivo', staffId: 'staff-atacante' },
    authContext: { userId: 'staff-autenticado' },
  }

  await settleOrder(req as any, response() as any, jest.fn())

  expect(settleOrderMock).toHaveBeenCalledWith('venue-1', 'order-1', 'efectivo', 'staff-autenticado')
})

it('settleCustomerBalance usa el mismo actor autenticado para toda la liquidación', async () => {
  settleCustomerBalanceMock.mockResolvedValue({ settledOrderCount: 2 })
  const req = {
    params: { venueId: 'venue-1', customerId: 'customer-1' },
    body: { notes: 'cobro de saldo', staffId: 'staff-atacante' },
    authContext: { userId: 'staff-autenticado' },
  }

  await settleCustomerBalance(req as any, response() as any, jest.fn())

  expect(settleCustomerBalanceMock).toHaveBeenCalledWith('venue-1', 'customer-1', 'cobro de saldo', 'staff-autenticado')
})
