/**
 * D32: la oferta de crédito vence N × 24 h después de crearse, sin importar la zona horaria del proceso.
 * Con setDate/getDate, en America/Los_Angeles cruzar el fin del horario de verano agregaba una hora.
 */
import prisma from '@/utils/prismaClient'
import { createCreditOffer } from '@/services/superadmin/creditAssessment.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venueCreditAssessment: { findUnique: jest.fn(), update: jest.fn() },
    creditOffer: { create: jest.fn() },
  },
}))

const db = prisma as any

describe('createCreditOffer — expiresAt', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-30T18:00:00.000Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })
    db.venueCreditAssessment.findUnique.mockResolvedValue({ id: 'ca_1', eligibilityStatus: 'ELIGIBLE', annualVolume: 365000 })
    db.creditOffer.create.mockImplementation(async ({ data }: any) => ({ id: 'offer_1', ...data }))
    db.venueCreditAssessment.update.mockResolvedValue({})
  })
  afterEach(() => jest.useRealTimers())

  it('sin expiresInDays vence a los 30 días exactos, también cruzando el cambio de horario', async () => {
    await createCreditOffer('venue_1', { offerAmount: 1000, factorRate: 1.2, repaymentPercent: 0.1 })
    expect(db.creditOffer.create.mock.calls[0][0].data.expiresAt.toISOString()).toBe('2026-11-29T18:00:00.000Z')
  })

  it('con expiresInDays = 7 vence a los 7 días exactos', async () => {
    await createCreditOffer('venue_1', { offerAmount: 1000, factorRate: 1.2, repaymentPercent: 0.1, expiresInDays: 7 })
    expect(db.creditOffer.create.mock.calls[0][0].data.expiresAt.toISOString()).toBe('2026-11-06T18:00:00.000Z')
  })
})
