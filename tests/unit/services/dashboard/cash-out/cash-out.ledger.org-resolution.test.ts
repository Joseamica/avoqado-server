/**
 * Unit tests (mock-first) — cash-out ledger org-level rate/active-days resolution.
 * Proves: a venue with NO venue-level rows still materializes commission by
 * falling back to its organization's rows (venue-override-else-org). This is
 * the money-critical guard against a venue silently paying $0 commission.
 */
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    cashOutCommissionRate: { findMany: jest.fn() },
    saleVerification: { findMany: jest.fn() },
    promoterCommissionEntry: {
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      aggregate: jest.fn(),
      updateMany: jest.fn(),
    },
    cashOutScheduleDay: { findMany: jest.fn() },
  },
}))
jest.mock('@/services/modules/module.service', () => ({
  __esModule: true,
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
  moduleService: { isModuleEnabled: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { moduleService } from '@/services/modules/module.service'
import { materializeEntries } from '@/services/dashboard/cash-out/cash-out.ledger.service'

const p = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  cashOutCommissionRate: { findMany: jest.Mock }
  saleVerification: { findMany: jest.Mock }
  promoterCommissionEntry: { findMany: jest.Mock; count: jest.Mock; create: jest.Mock; aggregate: jest.Mock; updateMany: jest.Mock }
  cashOutScheduleDay: { findMany: jest.Mock }
}
const mockEnabled = moduleService.isModuleEnabled as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  mockEnabled.mockResolvedValue(true)
  p.venue.findUnique.mockResolvedValue({ organizationId: 'org1', timezone: 'America/Mexico_City' })
  p.promoterCommissionEntry.findMany.mockResolvedValue([])
  p.promoterCommissionEntry.count.mockResolvedValue(0)
})

describe('cash-out ledger — venue-override-else-org resolution', () => {
  it('materializes commission from ORG rates/days when the venue has none of its own', async () => {
    // Venue-scoped rows are empty; org-scoped rows (venueId: null) carry the real config.
    p.cashOutCommissionRate.findMany.mockImplementation(({ where }: any) =>
      where.venueId === 'v1'
        ? Promise.resolve([])
        : Promise.resolve([{ saleType: 'LINEA_NUEVA', minCount: 1, maxCount: null, amount: new Prisma.Decimal(10) }]),
    )
    p.cashOutScheduleDay.findMany.mockImplementation(({ where }: any) =>
      where.venueId === 'v1' ? Promise.resolve([]) : Promise.resolve([{ day: new Date('2026-07-06T00:00:00.000Z') }]),
    )
    p.saleVerification.findMany.mockResolvedValue([
      { id: 's1', staffId: 'p1', isPortabilidad: false, createdAt: new Date('2026-07-06T18:00:00Z') },
    ])

    const res = await materializeEntries('v1')

    expect(res.created).toBe(1)
    expect(p.promoterCommissionEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: expect.anything(), tier: 1 }) }),
    )
  })

  it('still returns $0/no-op when NEITHER venue NOR org has rates/days configured', async () => {
    p.cashOutCommissionRate.findMany.mockResolvedValue([])
    p.cashOutScheduleDay.findMany.mockResolvedValue([])
    p.saleVerification.findMany.mockResolvedValue([
      { id: 's1', staffId: 'p1', isPortabilidad: false, createdAt: new Date('2026-07-06T18:00:00Z') },
    ])

    const res = await materializeEntries('v1')

    expect(res.created).toBe(0)
    expect(p.promoterCommissionEntry.create).not.toHaveBeenCalled()
  })

  it('prefers VENUE rows over org rows when both exist (no double-config surprise)', async () => {
    p.cashOutCommissionRate.findMany.mockImplementation(({ where }: any) =>
      where.venueId === 'v1'
        ? Promise.resolve([{ saleType: 'LINEA_NUEVA', minCount: 1, maxCount: null, amount: new Prisma.Decimal(99) }])
        : Promise.resolve([{ saleType: 'LINEA_NUEVA', minCount: 1, maxCount: null, amount: new Prisma.Decimal(10) }]),
    )
    p.cashOutScheduleDay.findMany.mockImplementation(({ where }: any) =>
      where.venueId === 'v1'
        ? Promise.resolve([{ day: new Date('2026-07-06T00:00:00.000Z') }])
        : Promise.resolve([{ day: new Date('2026-07-01T00:00:00.000Z') }]),
    )
    p.saleVerification.findMany.mockResolvedValue([
      { id: 's1', staffId: 'p1', isPortabilidad: false, createdAt: new Date('2026-07-06T18:00:00Z') },
    ])

    const res = await materializeEntries('v1')

    expect(res.created).toBe(1)
    expect(p.promoterCommissionEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: expect.objectContaining({ toString: expect.anything() }) }) }),
    )
    const created = p.promoterCommissionEntry.create.mock.calls[0][0].data
    expect(created.amount.toString()).toBe('99')
  })
})
