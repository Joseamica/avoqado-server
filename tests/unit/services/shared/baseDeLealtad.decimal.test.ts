/**
 * 🔴 Codex r3 #3: la base de puntos de una venta saldada (la que usan el reconciliador y la liga tardía) restaba la propina con
 * números de JavaScript: 69.60 − 11.60 = 57.99999999999999, y el piso de los puntos daba 57 en vez de 58. La resta va en
 * `Prisma.Decimal` (a centavos) antes de convertir.
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { baseDeLealtadDeLaVenta } from '@/services/shared/loyaltyOnLateCustomer'
import { calculatePointsForAmount } from '@/services/dashboard/loyalty.dashboard.service'

const venta = (total: Prisma.Decimal | number, tipAmount: Prisma.Decimal | number | null) => ({
  id: 'o1',
  venueId: 'v1',
  originSystem: null,
  total,
  tipAmount,
})

describe('baseDeLealtadDeLaVenta · la resta de la propina va en centavos exactos', () => {
  it('total $69.60 con $11.60 de propina = $58 exactos → 58 puntos a 1 punto por peso', async () => {
    const base = await baseDeLealtadDeLaVenta(prismaMock as any, venta(new Prisma.Decimal('69.60'), new Prisma.Decimal('11.60')))
    expect(base).toBe(58)

    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({
      active: true,
      pointsPerDollar: new Prisma.Decimal(1),
      pointsPerVisit: 0,
      redemptionRate: new Prisma.Decimal('0.01'),
    } as any)
    expect(await calculatePointsForAmount('v1', base)).toBe(58)
  })

  it('regresión: sin propina, con propina nula y con propina mayor que el total', async () => {
    expect(await baseDeLealtadDeLaVenta(prismaMock as any, venta(new Prisma.Decimal(90), new Prisma.Decimal(0)))).toBe(90)
    expect(await baseDeLealtadDeLaVenta(prismaMock as any, venta(new Prisma.Decimal('45.50'), null))).toBe(45.5)
    expect(await baseDeLealtadDeLaVenta(prismaMock as any, venta(10, 12))).toBe(0)
  })
})
