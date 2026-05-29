import * as service from '../../../../src/services/onboarding/testPaymentLink.service'

jest.mock('../../../../src/services/dashboard/paymentLink.service', () => ({
  __esModule: true,
  createPaymentLink: jest.fn().mockResolvedValue({
    id: 'link-1',
    url: 'https://book.example.com/pay/abc',
    shortUrl: 'https://av.io/abc',
  }),
}))

jest.mock('../../../../src/services/whatsapp.service', () => ({
  __esModule: true,
  sendServiceMessage: jest.fn().mockResolvedValue({ messageId: 'wamid.test-123' }),
}))

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    ecommerceMerchant: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'merch-1',
        provider: { code: 'MERCADO_PAGO' },
        onboardingStatus: 'COMPLETED',
      }),
    },
    venue: {
      findUnique: jest.fn().mockResolvedValue({ id: 'venue-1', phone: '+526648442154' }),
    },
  },
}))

import * as whatsappService from '../../../../src/services/whatsapp.service'

describe('testPaymentLink.service — happy path', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns url and qrCodeUrl for a 50 MXN MP test link', async () => {
    const result = await service.createTestPaymentLink({
      venueId: 'venue-1',
      providerCode: 'MERCADO_PAGO',
      amount: 50,
      staffId: 'staff-1',
    })
    expect(result.url).toBe('https://book.example.com/pay/abc')
    expect(result.qrCodeUrl).toMatch(/^data:image\/(svg\+xml|png);base64,/)
  })

  it('rejects amounts outside 1-10000 MXN range', async () => {
    await expect(
      service.createTestPaymentLink({ venueId: 'venue-1', providerCode: 'MERCADO_PAGO', amount: 0, staffId: 'staff-1' }),
    ).rejects.toThrow(/monto/i)
    await expect(
      service.createTestPaymentLink({ venueId: 'venue-1', providerCode: 'MERCADO_PAGO', amount: 99999, staffId: 'staff-1' }),
    ).rejects.toThrow(/monto/i)
  })

  it('rejects when the venue has no merchant for the provider', async () => {
    const prisma = require('../../../../src/utils/prismaClient').default
    prisma.ecommerceMerchant.findFirst.mockResolvedValueOnce(null)
    await expect(
      service.createTestPaymentLink({ venueId: 'venue-1', providerCode: 'MERCADO_PAGO', amount: 50, staffId: 'staff-1' }),
    ).rejects.toThrow(/no.*conectado|not.*connected/i)
  })
})

describe('testPaymentLink.service — WhatsApp delivery', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Restore default happy-path mock impls (clearAllMocks wipes them)
    const prisma = require('../../../../src/utils/prismaClient').default
    prisma.ecommerceMerchant.findFirst.mockResolvedValue({
      id: 'merch-1',
      provider: { code: 'MERCADO_PAGO' },
      onboardingStatus: 'COMPLETED',
    })
    prisma.venue.findUnique.mockResolvedValue({ id: 'venue-1', phone: '+526648442154' })
    const paymentLink = require('../../../../src/services/dashboard/paymentLink.service')
    paymentLink.createPaymentLink.mockResolvedValue({
      id: 'link-1',
      url: 'https://book.example.com/pay/abc',
      shortUrl: 'https://av.io/abc',
    })
    ;(whatsappService.sendServiceMessage as jest.Mock).mockResolvedValue({ messageId: 'wamid.test-123' })
  })

  it('sends a WhatsApp message to the venue phone and reports success', async () => {
    const result = await service.createTestPaymentLink({
      venueId: 'venue-1',
      providerCode: 'MERCADO_PAGO',
      amount: 100,
      staffId: 'staff-1',
    })
    expect(result.whatsappSent).toBe(true)
    expect(whatsappService.sendServiceMessage).toHaveBeenCalledWith(
      '+526648442154',
      expect.stringContaining('https://book.example.com/pay/abc'),
    )
  })

  it('returns whatsappSent=false when the service rejects, without throwing', async () => {
    ;(whatsappService.sendServiceMessage as jest.Mock).mockRejectedValueOnce(new Error('WA down'))
    const result = await service.createTestPaymentLink({
      venueId: 'venue-1',
      providerCode: 'MERCADO_PAGO',
      amount: 100,
      staffId: 'staff-1',
    })
    expect(result.whatsappSent).toBe(false)
    expect(result.url).toBeTruthy() // URL still delivered to caller
  })

  it('returns whatsappSent=false silently when venue has no phone on file', async () => {
    const prisma = require('../../../../src/utils/prismaClient').default
    prisma.venue.findUnique.mockResolvedValueOnce({ id: 'venue-1', phone: null })
    const result = await service.createTestPaymentLink({
      venueId: 'venue-1',
      providerCode: 'MERCADO_PAGO',
      amount: 100,
      staffId: 'staff-1',
    })
    expect(result.whatsappSent).toBe(false)
    expect(whatsappService.sendServiceMessage).not.toHaveBeenCalled()
  })
})
