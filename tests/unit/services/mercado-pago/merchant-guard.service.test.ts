import { getMercadoPagoMerchant } from '@/services/mercado-pago/merchant-guard.service'
import { BadRequestError, NotFoundError, UnauthorizedError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

const mockPrisma = prisma as unknown as {
  ecommerceMerchant: { findUnique: jest.Mock }
}

describe('getMercadoPagoMerchant', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns the merchant when venue + provider match', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1',
      venueId: 'v_1',
      provider: { code: 'MERCADO_PAGO' },
    })
    const merchant = await getMercadoPagoMerchant('v_1', 'em_1')
    expect(merchant.id).toBe('em_1')
    expect(mockPrisma.ecommerceMerchant.findUnique).toHaveBeenCalledWith({
      where: { id: 'em_1' },
      include: { provider: { select: { code: true } } },
    })
  })

  it('throws NotFoundError when merchant does not exist', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue(null)
    await expect(getMercadoPagoMerchant('v_1', 'em_nope')).rejects.toThrow(NotFoundError)
  })

  it('throws UnauthorizedError when merchant belongs to a different venue', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1',
      venueId: 'v_OTHER',
      provider: { code: 'MERCADO_PAGO' },
    })
    await expect(getMercadoPagoMerchant('v_1', 'em_1')).rejects.toThrow(UnauthorizedError)
  })

  it('throws BadRequestError when provider is not MERCADO_PAGO', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1',
      venueId: 'v_1',
      provider: { code: 'STRIPE_CONNECT' },
    })
    await expect(getMercadoPagoMerchant('v_1', 'em_1')).rejects.toThrow(BadRequestError)
  })

  it('throws BadRequestError when provider is missing', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1',
      venueId: 'v_1',
      provider: null,
    })
    await expect(getMercadoPagoMerchant('v_1', 'em_1')).rejects.toThrow(BadRequestError)
  })

  it('uses Spanish error messages (matches Stripe Connect guard pattern)', async () => {
    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue(null)
    await expect(getMercadoPagoMerchant('v_1', 'em_x')).rejects.toThrow(/no encontrada/i)

    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1',
      venueId: 'v_OTHER',
      provider: { code: 'MERCADO_PAGO' },
    })
    await expect(getMercadoPagoMerchant('v_1', 'em_1')).rejects.toThrow(/no tienes acceso/i)

    mockPrisma.ecommerceMerchant.findUnique.mockResolvedValue({
      id: 'em_1',
      venueId: 'v_1',
      provider: { code: 'BLUMON' },
    })
    await expect(getMercadoPagoMerchant('v_1', 'em_1')).rejects.toThrow(/no usa mercado pago/i)
  })
})
