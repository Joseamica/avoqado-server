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

  describe('con una promo ×2 vigente', () => {
    beforeEach(() => {
      prismaMock.loyaltyPromotion.findMany.mockResolvedValue([
        {
          id: 'promo-1',
          venueId: 'v1',
          name: 'Puntos dobles',
          kind: 'MULTIPLY',
          multiplier: 2,
          extraStamps: null,
          extraPoints: null,
          startsAt: new Date('2020-01-01T00:00:00Z'),
          endsAt: null,
          endedAt: null,
          daysOfWeek: [],
          timeFrom: null,
          timeUntil: null,
          productIds: [],
          categoryIds: [],
          categoryProductIds: [],
          minSpend: null,
          limit: 'NONE',
          createdById: null,
          createdAt: new Date('2020-01-01T00:00:00Z'),
          updatedAt: new Date('2020-01-01T00:00:00Z'),
        },
      ])
      prismaMock.loyaltyTransaction.create.mockImplementation((async ({ data }: any) => ({ id: 'lt-1', ...data })) as never)
    })
    // `clearAllMocks` no borra implementaciones: sin esto la promo se colaría en las pruebas de abajo.
    afterEach(() => prismaMock.loyaltyPromotion.findMany.mockResolvedValue([]))

    // Ola final: la venta nueva de un cambio no es una visita nueva — tampoco gana promo (ni bono ni fila de uso).
    it('skipStamp: los puntos de siempre, sin bono de la promo ni uso registrado', async () => {
      await earnPoints('v1', 'c1', 100, 'o-new', 'sv-1', { skipStamp: true })

      const data = prismaMock.loyaltyTransaction.create.mock.calls[0][0].data
      expect(data.points).toBe(100)
      expect(data).not.toHaveProperty('promotionId')
      expect(data).not.toHaveProperty('bonusPoints')
      expect(prismaMock.loyaltyPromotionUse.upsert).not.toHaveBeenCalled()
    })

    it('sin skipStamp la misma venta sí gana el ×2 (regresión)', async () => {
      await earnPoints('v1', 'c1', 100, 'o-sale', 'sv-1')

      expect(prismaMock.loyaltyTransaction.create.mock.calls[0][0].data).toMatchObject({
        points: 200,
        promotionId: 'promo-1',
        bonusPoints: 100,
      })
      expect(prismaMock.loyaltyPromotionUse.upsert).toHaveBeenCalled()
    })
  })

  it('earnPoints without options still asks grantStamp for the stamp (regression)', async () => {
    const r = await earnPoints('v1', 'c1', 100, 'o-sale', 'sv-1')

    expect(grantStampMock).toHaveBeenCalledWith('v1', 'c1', 'o-sale', expect.objectContaining({ staffVenueId: 'sv-1' }))
    expect(r).toEqual({ pointsEarned: 100, newBalance: 100, otorgado: { sello: true, puntos: true } })
  })
})
