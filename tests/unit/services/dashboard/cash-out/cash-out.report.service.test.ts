/**
 * Unit tests (mock-first) — cash-out Finanzas dispersion report (the 18:15 corte).
 * Aggregates REQUESTED withdrawals → rows (promotor/CLABE/neto/folio) + total,
 * and atomically marks them REPORTED. Pesos.
 */
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: { $transaction: jest.fn() } }))
jest.mock('@/services/modules/module.service', () => ({
  __esModule: true,
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
  moduleService: { isModuleEnabled: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { moduleService } from '@/services/modules/module.service'
import { generateDispersionReport } from '@/services/dashboard/cash-out/cash-out.report.service'

const p = prisma as unknown as { $transaction: jest.Mock }
const mockEnabled = moduleService.isModuleEnabled as jest.Mock
const tx = {
  cashOutWithdrawal: { findMany: jest.fn(), updateMany: jest.fn() },
  staff: { findMany: jest.fn() },
}

beforeEach(() => {
  jest.clearAllMocks()
  mockEnabled.mockResolvedValue(true)
  p.$transaction.mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx))
})

describe('cash-out report — generateDispersionReport (corte → Finanzas SPEI)', () => {
  it('aggregates REQUESTED withdrawals into rows + total (pesos) and marks them REPORTED', async () => {
    tx.cashOutWithdrawal.findMany.mockResolvedValue([
      { id: 'w1', folio: 'CO-1', staffId: 'p1', clabe: '012345678901234567', netAmount: new Prisma.Decimal(75) },
      { id: 'w2', folio: 'CO-2', staffId: 'p2', clabe: '098765432109876543', netAmount: new Prisma.Decimal(40) },
    ])
    tx.staff.findMany.mockResolvedValue([
      { id: 'p1', firstName: 'Ana', lastName: 'López' },
      { id: 'p2', firstName: 'Beto', lastName: 'Cruz' },
    ])
    tx.cashOutWithdrawal.updateMany.mockResolvedValue({ count: 2 })

    const r = await generateDispersionReport('v_pt', {}, { staffId: 'boss' })

    expect(r.count).toBe(2)
    expect(r.totalNet).toBe('115')
    expect(r.rows[0]).toMatchObject({ folio: 'CO-1', promoterName: 'Ana López', clabe: '012345678901234567', netAmount: '75' })
    expect(tx.cashOutWithdrawal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['w1', 'w2'] } }, data: expect.objectContaining({ status: 'REPORTED' }) }),
    )
  })

  it('returns an empty report (and marks nothing) when no withdrawals are REQUESTED', async () => {
    tx.cashOutWithdrawal.findMany.mockResolvedValue([])
    const r = await generateDispersionReport('v_pt', {}, { staffId: 'boss' })
    expect(r.count).toBe(0)
    expect(r.rows).toEqual([])
    expect(tx.cashOutWithdrawal.updateMany).not.toHaveBeenCalled()
  })

  it('rejects a non-CASH_OUT venue', async () => {
    mockEnabled.mockResolvedValue(false)
    await expect(generateDispersionReport('v_other', {}, { staffId: 'boss' })).rejects.toThrow(/módulo|cash out|module/i)
  })
})
