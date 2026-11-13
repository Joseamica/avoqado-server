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

// Ola final (I3): la base se calcula en Decimal y el floor va al final, como el bono de la promo (evaluarPromo). En número,
// 0.29 × 100 = 28.999… y el floor daba 28: la clienta perdía un punto.
describe('base de puntos en Decimal', () => {
  const config = (pointsPerDollar: string) =>
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({
      active: true,
      pointsPerDollar: new Prisma.Decimal(pointsPerDollar),
      pointsPerVisit: 0,
      redemptionRate: new Prisma.Decimal(1),
    } as any)

  it('$0.29 con 100 puntos por peso entrega 29', async () => {
    config('100')
    expect(await calculatePointsForAmount('v1', 0.29)).toBe(29)
  })

  it('$100 con 0.29 puntos por peso entrega 29', async () => {
    config('0.29')
    expect(await calculatePointsForAmount('v1', 100)).toBe(29)
  })
})
