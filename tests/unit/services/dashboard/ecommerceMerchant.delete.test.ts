// M1 (revisión final, pedidos en línea fase 2): `OnlineOrderCharge.ecommerceMerchantId` es Restrict. Borrar un comercio con cargos de
// pedidos en línea debe contestar un 409 claro (como con las ligas de pago), nunca un 500 de la llave foránea.
import { prismaMock } from '@tests/__helpers__/setup'
import { deleteEcommerceMerchant } from '@/services/dashboard/ecommerceMerchant.service'

jest.mock('@/services/dashboard/activity-log.service', () => ({ __esModule: true, logAction: jest.fn() }))

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.ecommerceMerchant.findUnique.mockResolvedValue({
    id: 'm1',
    venueId: 'v1',
    channelName: 'Tienda',
    chargesEnabled: false,
    onboardingStatus: 'PENDING',
    provider: { code: 'STRIPE_CONNECT' },
  } as any)
  prismaMock.checkoutSession.count.mockResolvedValue(0 as any)
  prismaMock.paymentLink.count.mockResolvedValue(0 as any)
  prismaMock.onlineOrderCharge.count.mockResolvedValue(0 as any)
})

describe('deleteEcommerceMerchant — cargos de pedidos en línea', () => {
  it('con cargos de pedidos en línea → 409 claro y no se borra', async () => {
    prismaMock.onlineOrderCharge.count.mockResolvedValue(2 as any)
    await expect(deleteEcommerceMerchant('m1', 'v1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'ECOMMERCE_MERCHANT_HAS_ONLINE_ORDER_CHARGES',
      message: expect.stringContaining('2 cobros de pedidos en línea'),
    })
    expect(prismaMock.onlineOrderCharge.count).toHaveBeenCalledWith({ where: { ecommerceMerchantId: 'm1' } })
    expect(prismaMock.ecommerceMerchant.delete).not.toHaveBeenCalled()
  })

  it('sin cargos se borra como siempre', async () => {
    await expect(deleteEcommerceMerchant('m1', 'v1')).resolves.toEqual({ success: true, merchantId: 'm1' })
    expect(prismaMock.ecommerceMerchant.delete).toHaveBeenCalledWith({ where: { id: 'm1' } })
  })
})
