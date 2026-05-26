import { PaymentMethod, OriginSystem, TransactionStatus } from '@prisma/client'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venuePaymentConfig: { findUnique: jest.fn() } },
}))

import prisma from '@/utils/prismaClient'
import { resolveMerchantAccountId, buildScopeWhere } from '@/services/superadmin/rateCorrection/rateCorrectionScope'

describe('resolveMerchantAccountId', () => {
  beforeEach(() => jest.clearAllMocks())
  it('returns primaryAccountId for PRIMARY', async () => {
    ;(prisma.venuePaymentConfig.findUnique as jest.Mock).mockResolvedValue({
      primaryAccountId: 'ma_1',
      secondaryAccountId: 'ma_2',
      tertiaryAccountId: null,
    })
    expect(await resolveMerchantAccountId('v1', 'PRIMARY')).toBe('ma_1')
  })
  it('returns secondaryAccountId for SECONDARY', async () => {
    ;(prisma.venuePaymentConfig.findUnique as jest.Mock).mockResolvedValue({
      primaryAccountId: 'ma_1',
      secondaryAccountId: 'ma_2',
      tertiaryAccountId: null,
    })
    expect(await resolveMerchantAccountId('v1', 'SECONDARY')).toBe('ma_2')
  })
  it('throws when the account for that type is not configured', async () => {
    ;(prisma.venuePaymentConfig.findUnique as jest.Mock).mockResolvedValue({
      primaryAccountId: 'ma_1',
      secondaryAccountId: null,
      tertiaryAccountId: null,
    })
    await expect(resolveMerchantAccountId('v1', 'TERTIARY')).rejects.toThrow()
  })
  it('throws when the venue has no payment config', async () => {
    ;(prisma.venuePaymentConfig.findUnique as jest.Mock).mockResolvedValue(null)
    await expect(resolveMerchantAccountId('v1', 'PRIMARY')).rejects.toThrow()
  })
})

describe('buildScopeWhere', () => {
  it('filters to COMPLETED / AVOQADO / non-CASH / non-TEST', () => {
    const w = buildScopeWhere({ venueId: 'v1', merchantAccountId: 'ma_1' })
    expect(w.venueId).toBe('v1')
    expect(w.merchantAccountId).toBe('ma_1')
    expect(w.status).toBe(TransactionStatus.COMPLETED)
    expect(w.originSystem).toBe(OriginSystem.AVOQADO)
    expect(w.method).toEqual({ not: PaymentMethod.CASH })
    expect(w.type).toEqual({ not: 'TEST' })
    expect(w.createdAt).toBeUndefined()
  })
  it('adds a createdAt range when dates are given', () => {
    const from = new Date('2024-01-01T00:00:00Z')
    const to = new Date('2024-06-01T00:00:00Z')
    const w = buildScopeWhere({ venueId: 'v1', merchantAccountId: 'ma_1', dateFrom: from, dateTo: to })
    expect(w.createdAt).toEqual({ gte: from, lte: to })
  })
})
