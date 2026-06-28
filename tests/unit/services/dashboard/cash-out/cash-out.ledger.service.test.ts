/**
 * Unit tests (mock-first) — cash-out ledger service.
 * Proves: idempotent materialization of COMPLETED sales into LOCKED escalating
 * entries, saldo = Σ AVAILABLE (pesos), and reconciliation-based clawback.
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
  },
}))
jest.mock('@/services/modules/module.service', () => ({
  __esModule: true,
  MODULE_CODES: { CASH_OUT: 'CASH_OUT' },
  moduleService: { isModuleEnabled: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { moduleService } from '@/services/modules/module.service'
import { materializeEntries, reconcileClawbacks, getSaldo } from '@/services/dashboard/cash-out/cash-out.ledger.service'

const p = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  cashOutCommissionRate: { findMany: jest.Mock }
  saleVerification: { findMany: jest.Mock }
  promoterCommissionEntry: { findMany: jest.Mock; count: jest.Mock; create: jest.Mock; aggregate: jest.Mock; updateMany: jest.Mock }
}
const mockEnabled = moduleService.isModuleEnabled as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  mockEnabled.mockResolvedValue(true)
  p.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
  p.cashOutCommissionRate.findMany.mockResolvedValue([
    { saleType: 'LINEA_NUEVA', minCount: 1, maxCount: 5, amount: new Prisma.Decimal(30) },
    { saleType: 'LINEA_NUEVA', minCount: 6, maxCount: null, amount: new Prisma.Decimal(40) },
    { saleType: 'PORTABILIDAD', minCount: 1, maxCount: null, amount: new Prisma.Decimal(25) },
  ])
})

describe('cash-out ledger — materializeEntries', () => {
  it('skips sales that already have an entry (idempotent)', async () => {
    p.promoterCommissionEntry.findMany.mockResolvedValue([{ saleVerificationId: 's1' }])
    p.saleVerification.findMany.mockResolvedValue([
      { id: 's1', staffId: 'p1', isPortabilidad: false, createdAt: new Date('2026-06-22T18:00:00Z') },
    ])
    const res = await materializeEntries('v_pt')
    expect(res.created).toBe(0)
    expect(p.promoterCommissionEntry.create).not.toHaveBeenCalled()
  })

  it('materializes new COMPLETED sales with escalating tiers in createdAt order', async () => {
    p.promoterCommissionEntry.findMany.mockResolvedValue([])
    p.promoterCommissionEntry.count.mockResolvedValue(0)
    p.saleVerification.findMany.mockResolvedValue([
      { id: 's1', staffId: 'p1', isPortabilidad: false, createdAt: new Date('2026-06-22T18:00:00Z') },
      { id: 's2', staffId: 'p1', isPortabilidad: false, createdAt: new Date('2026-06-22T19:00:00Z') },
    ])
    const res = await materializeEntries('v_pt')
    expect(res.created).toBe(2)
    const calls = p.promoterCommissionEntry.create.mock.calls
    expect(calls[0][0].data).toMatchObject({ saleVerificationId: 's1', tier: 1 })
    expect(calls[1][0].data).toMatchObject({ saleVerificationId: 's2', tier: 2 })
    expect(p.promoterCommissionEntry.count).toHaveBeenCalledTimes(1) // seeded once, then in-memory counter
  })

  it('is a no-op for a non-CASH_OUT venue (sweep skips it — scalable product untouched)', async () => {
    mockEnabled.mockResolvedValue(false)
    const res = await materializeEntries('v_other')
    expect(res.created).toBe(0)
    expect(p.saleVerification.findMany).not.toHaveBeenCalled()
  })
})

describe('cash-out ledger — getSaldo (Σ AVAILABLE, pesos)', () => {
  it('sums the AVAILABLE entries', async () => {
    p.promoterCommissionEntry.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal(75) } })
    expect((await getSaldo('v_pt', 'p1')).toString()).toBe('75')
  })

  it('returns 0 when there is no available saldo', async () => {
    p.promoterCommissionEntry.aggregate.mockResolvedValue({ _sum: { amount: null } })
    expect((await getSaldo('v_pt', 'p1')).toString()).toBe('0')
  })
})

describe('cash-out ledger — reconcileClawbacks', () => {
  it('claws back entries whose source sale is no longer COMPLETED', async () => {
    p.promoterCommissionEntry.findMany.mockResolvedValue([
      { id: 'e1', saleVerificationId: 's1' },
      { id: 'e2', saleVerificationId: 's2' },
    ])
    p.saleVerification.findMany.mockResolvedValue([{ id: 's1' }]) // only s1 still COMPLETED
    p.promoterCommissionEntry.updateMany.mockResolvedValue({ count: 1 })
    const res = await reconcileClawbacks('v_pt')
    expect(res.clawedBack).toBe(1)
    expect(p.promoterCommissionEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['e2'] } }, data: expect.objectContaining({ status: 'CLAWED_BACK' }) }),
    )
  })
})
