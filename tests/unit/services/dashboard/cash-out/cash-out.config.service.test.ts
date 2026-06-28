/**
 * Unit tests (mock-first) — cash-out config service.
 * Proves: the ISOLATION INVARIANT (module gating) AND that writes are validated
 * and audited before they ever touch the DB.
 */
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    cashOutCommissionRate: { findMany: jest.fn() },
    cashOutScheduleDay: { findMany: jest.fn() },
    $transaction: jest.fn(),
  },
}))
jest.mock('@/services/modules/module.service', () => ({
  __esModule: true,
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
  moduleService: { isModuleEnabled: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import prisma from '@/utils/prismaClient'
import { moduleService } from '@/services/modules/module.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import {
  listCommissionRates,
  replaceCommissionRates,
  setActiveDays,
  listActiveDays,
} from '@/services/dashboard/cash-out/cash-out.config.service'

const p = prisma as unknown as {
  cashOutCommissionRate: { findMany: jest.Mock }
  cashOutScheduleDay: { findMany: jest.Mock }
  $transaction: jest.Mock
}
const mockEnabled = moduleService.isModuleEnabled as jest.Mock
const mockLog = logAction as jest.Mock

// tx object handed to the $transaction callback
const tx = {
  cashOutCommissionRate: { updateMany: jest.fn(), createMany: jest.fn(), findMany: jest.fn() },
  cashOutScheduleDay: { deleteMany: jest.fn(), createMany: jest.fn() },
}

beforeEach(() => {
  jest.clearAllMocks()
  p.$transaction.mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx))
})

describe('cash-out config service — module gating (isolation invariant)', () => {
  it('rejects listCommissionRates when the venue does NOT have the CASH_OUT module — and never queries', async () => {
    mockEnabled.mockResolvedValue(false)
    await expect(listCommissionRates('venue_not_pt')).rejects.toThrow(/módulo|cash out|module/i)
    expect(mockEnabled).toHaveBeenCalledWith('venue_not_pt', 'SERIALIZED_INVENTORY')
    expect(p.cashOutCommissionRate.findMany).not.toHaveBeenCalled()
  })

  it('returns the rates when the venue HAS the CASH_OUT module', async () => {
    mockEnabled.mockResolvedValue(true)
    const rows = [{ id: 'r1', saleType: 'LINEA_NUEVA', minCount: 1, maxCount: 5, amount: 30 }]
    p.cashOutCommissionRate.findMany.mockResolvedValue(rows)
    await expect(listCommissionRates('venue_pt')).resolves.toEqual(rows)
    expect(p.cashOutCommissionRate.findMany).toHaveBeenCalledTimes(1)
  })
})

describe('cash-out config service — replaceCommissionRates (validate + audit + persist)', () => {
  it('rejects an invalid rate table and writes NOTHING (no transaction, no audit)', async () => {
    mockEnabled.mockResolvedValue(true)
    const invalid = [{ saleType: 'LINEA_NUEVA' as const, minCount: 1, maxCount: 5, amount: 30 }] // no open-ended top tier
    await expect(replaceCommissionRates('v_pt', invalid, { staffId: 's1' })).rejects.toThrow()
    expect(p.$transaction).not.toHaveBeenCalled()
    expect(mockLog).not.toHaveBeenCalled()
  })

  it('persists a valid table inside a transaction (deactivate old → create new) and audits it', async () => {
    mockEnabled.mockResolvedValue(true)
    const valid = [
      { saleType: 'LINEA_NUEVA' as const, minCount: 1, maxCount: null, amount: 30 },
      { saleType: 'PORTABILIDAD' as const, minCount: 1, maxCount: null, amount: 25 },
    ]
    const persisted = [{ id: 'r1' }, { id: 'r2' }]
    tx.cashOutCommissionRate.findMany.mockResolvedValue(persisted)

    const result = await replaceCommissionRates('v_pt', valid, { staffId: 's1', orgId: 'org_pt' })

    expect(tx.cashOutCommissionRate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: 'v_pt', active: true }, data: { active: false } }),
    )
    expect(tx.cashOutCommissionRate.createMany).toHaveBeenCalledTimes(1)
    expect(result).toEqual(persisted)
    expect(mockLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'CASH_OUT_RATES_UPDATED', venueId: 'v_pt', staffId: 's1' }))
  })

  it('rejects when the venue lacks the CASH_OUT module — before any validation or DB write', async () => {
    mockEnabled.mockResolvedValue(false)
    await expect(replaceCommissionRates('v_other', [], { staffId: 's1' })).rejects.toThrow(/módulo|cash out|module/i)
    expect(p.$transaction).not.toHaveBeenCalled()
  })
})

describe('cash-out config service — active-days calendar (ADMIN day-selection)', () => {
  it('rejects setActiveDays for a non-CASH_OUT venue', async () => {
    mockEnabled.mockResolvedValue(false)
    await expect(setActiveDays('v_other', ['2026-06-22'], { staffId: 's1' })).rejects.toThrow(/módulo|cash out|module/i)
    expect(p.$transaction).not.toHaveBeenCalled()
  })

  it('replaces the active days atomically (deleteMany → createMany) and audits', async () => {
    mockEnabled.mockResolvedValue(true)
    await setActiveDays('v_pt', ['2026-06-22', '2026-06-23'], { staffId: 's1', orgId: 'org_pt' })
    expect(tx.cashOutScheduleDay.deleteMany).toHaveBeenCalledWith(expect.objectContaining({ where: { venueId: 'v_pt' } }))
    expect(tx.cashOutScheduleDay.createMany).toHaveBeenCalledTimes(1)
    expect(mockLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'CASH_OUT_DAYS_UPDATED', venueId: 'v_pt' }))
  })

  it('listActiveDays returns yyyy-MM-dd strings (gated)', async () => {
    mockEnabled.mockResolvedValue(true)
    p.cashOutScheduleDay.findMany.mockResolvedValue([
      { day: new Date('2026-06-22T00:00:00.000Z') },
      { day: new Date('2026-06-23T00:00:00.000Z') },
    ])
    await expect(listActiveDays('v_pt')).resolves.toEqual(['2026-06-22', '2026-06-23'])
  })
})
