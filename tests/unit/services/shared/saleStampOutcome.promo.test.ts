/** Task 8: la respuesta de la venta dice cuántos sellos dio y con qué promoción (campos opcionales, leídos de la base). */
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/shared/loyaltyOnPaidOrder', () => ({ awardLoyaltyForPaidOrder: jest.fn() }))
jest.mock('@/services/wallet/stampLedger.service', () => ({ getStampCardStatus: jest.fn(), reverseStampForOrder: jest.fn() }))
jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn() }))

import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { getStampCardStatus } from '@/services/wallet/stampLedger.service'
import { describeSaleStamp } from '@/services/shared/loyaltyOnLateCustomer'

const cardMock = getStampCardStatus as jest.Mock
const earnDeLaVenta = (stampsEarned: number, completa: boolean) => ({
  stampCard: {
    stampsEarned,
    stampsRequired: 7,
    completedAt: completa ? new Date() : null,
    rewards: completa ? [{ rewardLabel: 'Café', status: 'PENDING' }] : [],
  },
})

describe('SaleStampOutcome: stampsAdded y promotionName', () => {
  beforeEach(() => {
    cardMock.mockResolvedValue({ stampsEarned: 1, stampsRequired: 7, rewardLabel: 'Café', pendingRewards: 0 })
    const hace = new Date(Date.now() - 30 * 60_000)
    // Venta ya saldada de este cliente que ya tiene su sello (decisión STAMPED).
    prismaMock.order.findFirst.mockResolvedValue({
      id: 'o',
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      total: 90,
      tipAmount: 10,
      customerId: 'c',
      loyaltyEligibleAt: hace,
      loyaltyProcessedAt: hace,
      orderCustomers: [{ customerId: 'c' }],
      payments: [{ createdAt: hace }],
      stampEvents: [{ type: 'EARN', stampCard: { customerId: 'c' } }],
      loyaltyTransactions: [],
    } as never)
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ active: true, stampsEnabled: true, maxStampsPerDay: 1 } as never)
    prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' } as never)
    prismaMock.payment.count.mockResolvedValue(0)
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(true)
  })

  async function correr(partes: unknown[], earn: unknown) {
    prismaMock.stampEvent.findFirst.mockResolvedValueOnce(earn as never)
    prismaMock.stampEvent.findMany.mockResolvedValueOnce(partes as never)
    return describeSaleStamp({ venueId: 'v', orderId: 'o', customerId: 'c' })
  }

  it('venta sin promo → stampsAdded 1, promotionName null', async () => {
    const r = await correr([{ part: 0, quantity: 1, promotion: null }], earnDeLaVenta(4, false))
    expect(r?.stampsAdded).toBe(1)
    expect(r?.promotionName).toBeNull()
  })

  it('venta ×2 con sobrante → stampsAdded 2, promo de la parte 0 y saleCard.completed true', async () => {
    const r = await correr(
      [
        { part: 0, quantity: 1, promotion: { name: 'Doble sello' } },
        { part: 1, quantity: 1, promotion: { name: 'Doble sello' } },
      ],
      earnDeLaVenta(7, true),
    )
    expect(r?.stampsAdded).toBe(2)
    expect(r?.promotionName).toBe('Doble sello')
    expect(r?.saleCard?.completed).toBe(true)
  })
})
