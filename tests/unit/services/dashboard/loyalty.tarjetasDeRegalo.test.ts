import { Decimal } from '@prisma/client/runtime/library'
import { earnPoints } from '@/services/dashboard/loyalty.dashboard.service'
import { prismaMock } from '@tests/__helpers__/setup'
import * as stampLedger from '@/services/wallet/stampLedger.service'

jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn().mockResolvedValue(true) }))
jest.mock('@/services/wallet/stampLedger.service', () => ({ grantStamp: jest.fn().mockResolvedValue({ granted: true }) }))

describe('earnPoints · tarjetas de regalo (R1)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({
      id: 'cfg',
      venueId: 'v1',
      active: true,
      pointsPerDollar: new Decimal(1),
      redemptionRate: new Decimal(0.01),
    })
  })

  it('🔴 la venta de tarjetas (llamadores directos: pago manual, ligas) no da puntos ni sello', async () => {
    prismaMock.orderItem.findFirst.mockResolvedValueOnce({ id: 'oi-gc' }).mockResolvedValueOnce(null)
    await expect(earnPoints('v1', 'c1', 500, 'o-gc')).resolves.toEqual({ pointsEarned: 0, newBalance: 0 })
    expect(stampLedger.grantStamp).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })
})
