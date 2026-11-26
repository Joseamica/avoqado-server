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

  // Codex B0 #4: las pruebas del checkout ya reciben un priceId fijo, así que aquí se fija la llave de CADA plan y ciclo.
  // Una llave anual o de Premium equivocada cobraría otro plan sin que nada más lo notara.
  it.each([
    ['PLAN_PRO', 'monthly', 'plan_pro_monthly'],
    ['PLAN_PRO', 'annual', 'plan_pro_annual'],
    ['PLAN_PREMIUM', 'monthly', 'plan_premium_monthly'],
    ['PLAN_PREMIUM', 'annual', 'plan_premium_annual'],
  ] as const)('%s %s consulta la llave %s', async (tierCode, interval, llave) => {
    mockPriceList.mockResolvedValue({ data: [{ id: `price_${llave}`, unit_amount: 100 }] })
    await expect(resolverPrecioDelPlan(tierCode, interval)).resolves.toEqual({ priceId: `price_${llave}`, unitAmount: 100 })
    expect(mockPriceList).toHaveBeenCalledTimes(1)
    expect(mockPriceList.mock.calls[0][0]).toEqual({ lookup_keys: [llave], limit: 1 })
  })

  it('sin precio lanza PLAN_NOT_CONFIGURED', async () => {
    mockPriceList.mockResolvedValue({ data: [] })
    await expect(resolverPrecioDelPlan('PLAN_PREMIUM', 'annual')).rejects.toMatchObject({ statusCode: 503, code: 'PLAN_NOT_CONFIGURED' })
  })
})
