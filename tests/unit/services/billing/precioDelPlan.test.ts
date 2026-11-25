const mockPriceList = jest.fn()
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({ prices: { list: mockPriceList } })))
jest.mock('../../../../src/utils/prismaClient', () => ({ __esModule: true, default: {} }))

import { resolverPrecioDelPlan } from '../../../../src/services/billing/precioDelPlan'

beforeEach(() => {
  mockPriceList.mockReset()
})

describe('resolverPrecioDelPlan', () => {
  it('devuelve id y monto del precio de la llave', async () => {
    mockPriceList.mockResolvedValue({ data: [{ id: 'price_A', unit_amount: 115884 }] })
    await expect(resolverPrecioDelPlan('PLAN_PRO', 'monthly')).resolves.toEqual({ priceId: 'price_A', unitAmount: 115884 })
    expect(mockPriceList).toHaveBeenCalledTimes(1)
    expect(mockPriceList).toHaveBeenCalledWith(expect.objectContaining({ lookup_keys: ['plan_pro_monthly'], limit: 1 }), expect.anything())
  })

  it('sin precio lanza PLAN_NOT_CONFIGURED', async () => {
    mockPriceList.mockResolvedValue({ data: [] })
    await expect(resolverPrecioDelPlan('PLAN_PREMIUM', 'annual')).rejects.toMatchObject({ statusCode: 503, code: 'PLAN_NOT_CONFIGURED' })
  })
})
