/** El tope diario de sellos cuenta el día de la VENTA (como `grantStamp`), no el de hoy; tope 0 = sin límite. */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/shared/loyaltyOnPaidOrder', () => ({ awardLoyaltyForPaidOrder: jest.fn() }))
jest.mock('@/services/wallet/stampLedger.service', () => ({ getStampCardStatus: jest.fn(), reverseStampForOrder: jest.fn() }))
jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn() }))

import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { previewSaleStamp } from '@/services/shared/loyaltyOnLateCustomer'

const AHORA = Date.UTC(2026, 9, 14, 18, 0, 0) // 12:00 hora de CDMX del 14-oct
const AYER_2330 = new Date(Date.UTC(2026, 9, 14, 5, 30, 0)) // 13-oct 23:30 hora de CDMX
const HOY_1000 = new Date(Date.UTC(2026, 9, 14, 16, 0, 0)) // 14-oct 10:00 hora de CDMX

function arma(over: Record<string, unknown>, maxStampsPerDay = 1) {
  prismaMock.order.findFirst.mockResolvedValue({
    id: 'o1',
    orderNumber: 'ORD-1',
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    total: new Prisma.Decimal(100),
    tipAmount: new Prisma.Decimal(0),
    customerId: 'c1',
    loyaltyEligibleAt: AYER_2330,
    loyaltySaleAt: AYER_2330,
    loyaltyProcessedAt: AYER_2330,
    orderCustomers: [{ customerId: 'c1' }],
    payments: [{ createdAt: AYER_2330 }],
    stampEvents: [],
    loyaltyTransactions: [],
    ...over,
  } as any)
  prismaMock.payment.count.mockResolvedValue(0)
  prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ active: true, stampsEnabled: true, maxStampsPerDay } as any)
  prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' } as any)
  ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(true)
  // Un sello EARN HOY (14-oct hora de CDMX); el día de ayer está vacío.
  prismaMock.stampEvent.count.mockImplementation((async ({ where }: any) =>
    HOY_1000 >= where.createdAt.gte && HOY_1000 <= where.createdAt.lte ? 1 : 0) as never)
}

beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(AHORA))
afterEach(() => jest.restoreAllMocks())

describe('topeDelDiaAlcanzado (vía la vista previa del MCP)', () => {
  it('cuenta el día de la venta, no el de hoy: venta de ayer 23:30 con un sello hoy → no alcanzado', async () => {
    arma({})
    const v = await previewSaleStamp({ venueId: 'v1', orderId: 'o1', customerId: 'c1' })
    expect(v?.decision).toBe('ELIGIBLE')
    expect(v?.dailyLimitReached).toBe(false)
  })

  it('una venta de hoy con un sello hoy sí alcanza el tope', async () => {
    arma({ loyaltySaleAt: HOY_1000, loyaltyEligibleAt: HOY_1000, payments: [{ createdAt: HOY_1000 }] })
    const v = await previewSaleStamp({ venueId: 'v1', orderId: 'o1', customerId: 'c1' })
    expect(v?.dailyLimitReached).toBe(true)
  })

  it('sin loyaltySaleAt usa loyaltyEligibleAt (igual que grantStamp)', async () => {
    arma({ loyaltySaleAt: null })
    const v = await previewSaleStamp({ venueId: 'v1', orderId: 'o1', customerId: 'c1' })
    expect(v?.dailyLimitReached).toBe(false)
  })

  it('cuenta VISITAS (la parte 0 de cada venta), no partes: una venta ×2 que cruzó de tarjeta es una (ruling 8)', async () => {
    arma({ loyaltySaleAt: HOY_1000, loyaltyEligibleAt: HOY_1000, payments: [{ createdAt: HOY_1000 }] }, 2)
    // Hoy: una venta con dos partes (0 y 1). Por partes serían 2 y alcanzaría el tope de 2; por visitas es 1.
    prismaMock.stampEvent.count.mockImplementation((async ({ where }: any) => (where.part === 0 ? 1 : 2)) as never)
    const v = await previewSaleStamp({ venueId: 'v1', orderId: 'o1', customerId: 'c1' })
    expect(v?.dailyLimitReached).toBe(false)
  })

  it('0 = sin límite: nunca alcanzado y ni cuenta', async () => {
    arma({ loyaltySaleAt: HOY_1000, loyaltyEligibleAt: HOY_1000, payments: [{ createdAt: HOY_1000 }] }, 0)
    const v = await previewSaleStamp({ venueId: 'v1', orderId: 'o1', customerId: 'c1' })
    expect(v?.dailyLimitReached).toBe(false)
    expect(prismaMock.stampEvent.count).not.toHaveBeenCalled()
  })
})
