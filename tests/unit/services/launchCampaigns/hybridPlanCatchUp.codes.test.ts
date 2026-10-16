/**
 * Puesta al día de funciones que entran a un plan con contratos vivos (`hybridPlanCatchUp.ts`), generalizada el 14-oct
 * para GIFT_CARDS. SERVICE_PAY conserva su nombre y su comportamiento (sus pruebas de integración siguen en staffPay/).
 */
jest.mock('@/utils/prismaClient', () => {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    hybridPurchase: { findUniqueOrThrow: jest.fn() },
    hybridContract: { findUniqueOrThrow: jest.fn(), update: jest.fn() },
    hybridContractSelection: { findUnique: jest.fn(), create: jest.fn() },
    hybridPaymentPeriod: { findMany: jest.fn() },
    capabilityGrant: { findFirst: jest.fn(), createMany: jest.fn() },
    activityLog: { create: jest.fn() },
  }
  return {
    __esModule: true,
    default: {
      tx,
      hybridContract: { findMany: jest.fn() },
      hybridPurchase: { groupBy: jest.fn() },
      hybridCampaign: { findMany: jest.fn() },
      hybridOfferPublication: { findMany: jest.fn() },
      $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
    },
  }
})

import prisma from '@/utils/prismaClient'
import {
  PLAN_CATCH_UP_CODES,
  addPlanFeatureToLivePlanContracts,
  addServicePayToLivePlanContracts,
  staleCampaigns,
} from '@/services/launchCampaigns/hybridPlanCatchUp'

const db = prisma as any
const tx = db.tx
const AHORA = new Date('2026-10-14T18:00:00.000Z')
const PAGADO_HASTA = new Date('2026-11-01T06:00:00.000Z')

function unContratoPro(featureCodes: string[]) {
  db.hybridContract.findMany
    .mockReset()
    .mockResolvedValueOnce([{ id: 'k1', purchaseId: 'p1' }])
    .mockResolvedValue([])
  tx.hybridPurchase.findUniqueOrThrow.mockResolvedValue({ status: 'COMPLETED' })
  tx.hybridContract.findUniqueOrThrow.mockResolvedValue({
    id: 'k1',
    venueId: 'v1',
    endedAt: null,
    featureCodes,
    paidThrough: PAGADO_HASTA,
    startsAt: new Date('2026-10-01T06:00:00.000Z'),
    stripeSubscriptionId: 'sub_1',
    planTier: 'PRO',
  })
  tx.hybridContractSelection.findUnique.mockResolvedValue(null)
  tx.hybridPaymentPeriod.findMany.mockResolvedValue([
    { id: 'per1', startsAt: new Date('2026-10-01T06:00:00.000Z'), endsAt: PAGADO_HASTA, composition: [{ contractId: 'k1' }] },
  ])
  tx.capabilityGrant.findFirst.mockResolvedValue({ revokedAt: null })
  tx.capabilityGrant.createMany.mockResolvedValue({ count: 1 })
}

beforeEach(() => {
  jest.clearAllMocks()
  db.hybridPurchase.groupBy.mockResolvedValue([])
  db.hybridCampaign.findMany.mockResolvedValue([])
  db.hybridOfferPublication.findMany.mockResolvedValue([])
})

describe('puesta al día de una función de plan en los contratos vivos', () => {
  it('la lista cerrada trae las dos funciones que entraron tarde al plan', () => {
    expect(PLAN_CATCH_UP_CODES).toEqual(['SERVICE_PAY', 'GIFT_CARDS'])
  })

  it('GIFT_CARDS entra a la selección que leen las renovaciones, al acceso del periodo pagado y a la bitácora', async () => {
    unContratoPro(['RESERVATIONS', 'SERVICE_PAY'])
    const r = await addPlanFeatureToLivePlanContracts('GIFT_CARDS', AHORA)
    const conTarjetas = ['GIFT_CARDS', 'RESERVATIONS', 'SERVICE_PAY']
    expect(tx.hybridContractSelection.create).toHaveBeenCalledWith({
      data: { contractId: 'k1', effectiveAt: PAGADO_HASTA, featureCodes: conTarjetas },
    })
    expect(tx.hybridContract.update).toHaveBeenCalledWith({ where: { id: 'k1' }, data: { featureCodes: conTarjetas } })
    expect(tx.capabilityGrant.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          venueId: 'v1',
          featureCode: 'GIFT_CARDS',
          sourceId: 'per1:k1',
          contractId: 'k1',
          paymentPeriodId: 'per1',
          revokedAt: null,
        }),
      ],
      skipDuplicates: true,
    })
    expect(tx.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'HYBRID_PLAN_FEATURE_ADDED',
        venueId: 'v1',
        data: expect.objectContaining({ featureCode: 'GIFT_CARDS', planTier: 'PRO' }),
      }),
    })
    expect(r).toMatchObject({ contracts: 1, grants: 1, skippedContracts: [], staleCampaigns: [] })
  })

  it('un contrato que ya la tiene no se vuelve a tocar (idempotente)', async () => {
    unContratoPro(['GIFT_CARDS', 'RESERVATIONS'])
    tx.capabilityGrant.createMany.mockResolvedValue({ count: 0 })
    const r = await addPlanFeatureToLivePlanContracts('GIFT_CARDS', AHORA)
    expect(tx.hybridContractSelection.create).not.toHaveBeenCalled()
    expect(tx.activityLog.create).not.toHaveBeenCalled()
    expect(r).toMatchObject({ contracts: 0, grants: 0 })
  })

  it('regresión: SERVICE_PAY conserva su nombre y escribe SU código', async () => {
    unContratoPro(['RESERVATIONS'])
    await addServicePayToLivePlanContracts(AHORA)
    expect(tx.capabilityGrant.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ featureCode: 'SERVICE_PAY' })],
      skipDuplicates: true,
    })
  })

  it('las ofertas por republicar se buscan por la función pedida', async () => {
    db.hybridCampaign.findMany.mockResolvedValueOnce([{ id: 'c1', code: 'L_PLAN_PRO', currentPublicationId: 'pub1' }])
    db.hybridOfferPublication.findMany.mockResolvedValueOnce([{ id: 'pub1' }])
    await expect(staleCampaigns('GIFT_CARDS')).resolves.toEqual([{ id: 'c1', code: 'L_PLAN_PRO' }])
    expect(db.hybridOfferPublication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ NOT: { includedFeatureCodes: { has: 'GIFT_CARDS' } } }) }),
    )
  })

  it('🔴 rechaza una función que no es de plan antes de leer un solo contrato', async () => {
    await expect(addPlanFeatureToLivePlanContracts('CFDI' as never, AHORA)).rejects.toThrow(/no es una función de plan/)
    expect(db.hybridContract.findMany).not.toHaveBeenCalled()
  })
})
