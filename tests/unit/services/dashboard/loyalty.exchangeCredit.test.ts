/**
 * `earnPoints` con `skipStamp` (spec 2026-10-20 §7.7): la venta nueva de un cambio da puntos sobre lo cobrado de más, pero no
 * sello —no es una visita nueva—. Sin la opción, todo sigue como hoy: el sello se pide a `grantStamp` antes de los puntos.
 */
import { Decimal } from '@prisma/client/runtime/library'
import { earnPoints } from '@/services/dashboard/loyalty.dashboard.service'
import { prismaMock } from '@tests/__helpers__/setup'
import * as stampLedger from '@/services/wallet/stampLedger.service'

jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn().mockResolvedValue(true) }))
jest.mock('@/services/wallet/stampLedger.service', () => ({ grantStamp: jest.fn().mockResolvedValue({ granted: true }) }))

const grantStampMock = stampLedger.grantStamp as jest.Mock

describe('earnPoints · new sale of a product exchange', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    grantStampMock.mockResolvedValue({ granted: true })
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({
      id: 'cfg',
      venueId: 'v1',
      active: true,
      pointsPerDollar: new Decimal(1),
      redemptionRate: new Decimal(0.01),
    })
    prismaMock.orderItem.findFirst.mockResolvedValue(null) // no es una cuenta de tarjetas de regalo
    prismaMock.$transaction.mockReset()
    prismaMock.$transaction.mockImplementation((async (cb: any) => (typeof cb === 'function' ? cb(prismaMock) : cb)) as never)
    prismaMock.$executeRaw.mockResolvedValue(0 as never)
    prismaMock.loyaltyTransaction.findFirst.mockResolvedValue(null)
    prismaMock.stampEvent.findFirst.mockResolvedValue(null)
    prismaMock.loyaltyTransaction.create.mockResolvedValue({ id: 'lt-1', points: 100 })
    prismaMock.customer.update.mockResolvedValue({ loyaltyPoints: 100 })
  })

  it('earnPoints with skipStamp does not call grantStamp but still records points', async () => {
    const r = await earnPoints('v1', 'c1', 100, 'o-new', 'sv-1', { skipStamp: true })

    expect(grantStampMock).not.toHaveBeenCalled()
    expect(prismaMock.loyaltyTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ customerId: 'c1', type: 'EARN', points: 100, orderId: 'o-new', createdById: 'sv-1' }),
    })
    // Sólo los puntos son de esta llamada: ningún sello que la auditoría de una liga tenga que contar.
    expect(r).toEqual({ pointsEarned: 100, newBalance: 100, otorgado: { sello: false, puntos: true } })
  })

  it('earnPoints without options still asks grantStamp for the stamp (regression)', async () => {
    const r = await earnPoints('v1', 'c1', 100, 'o-sale', 'sv-1')

    expect(grantStampMock).toHaveBeenCalledWith('v1', 'c1', 'o-sale', expect.objectContaining({ staffVenueId: 'sv-1' }))
    expect(r).toEqual({ pointsEarned: 100, newBalance: 100, otorgado: { sello: true, puntos: true } })
  })
})
