import prisma from '@/utils/prismaClient'
import { resolveOriginPayment } from '@/services/dashboard/terminal-migration.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venuePaymentConfig: { findUnique: jest.fn() },
    organizationPaymentConfig: { findUnique: jest.fn() },
  },
}))

const m = prisma as unknown as {
  venuePaymentConfig: { findUnique: jest.Mock }
  organizationPaymentConfig: { findUnique: jest.Mock }
}

const VENUE_CFG = {
  primaryAccountId: 'merch-p',
  secondaryAccountId: 'merch-s',
  tertiaryAccountId: null,
  preferredProcessor: 'AUTO',
  routingRules: null,
}

describe('resolveOriginPayment', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    m.venuePaymentConfig.findUnique.mockResolvedValue(null)
    m.organizationPaymentConfig.findUnique.mockResolvedValue(null)
  })

  it('copia la VenuePaymentConfig propia del origen', async () => {
    m.venuePaymentConfig.findUnique.mockResolvedValue(VENUE_CFG)
    const r = await resolveOriginPayment({ venueId: 'v-old', assignedMerchantIds: [] }, 'org-1')
    expect(r.merchantIds).toEqual(['merch-p', 'merch-s'])
    expect(r.copyable?.primaryAccountId).toBe('merch-p')
  })

  it('cae a la OrganizationPaymentConfig heredada cuando el origen no tiene propia', async () => {
    m.organizationPaymentConfig.findUnique.mockResolvedValue({ ...VENUE_CFG, primaryAccountId: 'merch-org' })
    const r = await resolveOriginPayment({ venueId: 'v-old', assignedMerchantIds: [] }, 'org-1')
    expect(r.merchantIds).toContain('merch-org')
    expect(r.copyable?.primaryAccountId).toBe('merch-org')
  })

  it('los assignedMerchantIds de la terminal ganan sobre la config del venue', async () => {
    m.venuePaymentConfig.findUnique.mockResolvedValue(VENUE_CFG)
    const r = await resolveOriginPayment({ venueId: 'v-old', assignedMerchantIds: ['merch-term'] }, 'org-1')
    expect(r.merchantIds).toEqual(['merch-term'])
  })

  it('sin config alguna, construye copyable desde los assignedMerchantIds', async () => {
    const r = await resolveOriginPayment({ venueId: 'v-old', assignedMerchantIds: ['merch-term'] }, 'org-1')
    expect(r.copyable).toEqual({
      primaryAccountId: 'merch-term',
      secondaryAccountId: null,
      tertiaryAccountId: null,
      preferredProcessor: 'AUTO',
      routingRules: null,
    })
  })

  it('sin config y sin merchants → nada que llevar', async () => {
    const r = await resolveOriginPayment({ venueId: 'v-old', assignedMerchantIds: [] }, 'org-1')
    expect(r.merchantIds).toEqual([])
    expect(r.copyable).toBeNull()
  })

  it('no consulta la org cuando originOrgId es null', async () => {
    await resolveOriginPayment({ venueId: 'v-old', assignedMerchantIds: [] }, null)
    expect(m.organizationPaymentConfig.findUnique).not.toHaveBeenCalled()
  })
})
