import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { calculatePointsForAmount } from '@/services/dashboard/loyalty.dashboard.service'

describe('bono por visita (regresión, ya existe en BASE)', () => {
  it('$100 con 1 punto por peso y 5 por visita entrega 105', async () => {
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({
      active: true,
      pointsPerDollar: new Prisma.Decimal(1),
      pointsPerVisit: 5,
      redemptionRate: new Prisma.Decimal(1),
    } as any)
    expect(await calculatePointsForAmount('v1', 100)).toBe(105)
  })
})
