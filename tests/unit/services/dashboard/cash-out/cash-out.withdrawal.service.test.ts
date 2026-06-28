/**
 * Unit tests (mock-first) — cash-out withdrawal ("Retirar").
 * Proves: Σ AVAILABLE → a REQUESTED withdrawal (pesos), entries atomically marked
 * WITHDRAWN, CLABE snapshot, and TOCTOU safety (conditional claim + count check).
 */
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { $transaction: jest.fn() },
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
import { logAction } from '@/services/dashboard/activity-log.service'
import { createWithdrawal } from '@/services/dashboard/cash-out/cash-out.withdrawal.service'

const p = prisma as unknown as { $transaction: jest.Mock }
const mockEnabled = moduleService.isModuleEnabled as jest.Mock
const mockLog = logAction as jest.Mock

const tx = {
  promoterCommissionEntry: { findMany: jest.fn(), updateMany: jest.fn() },
  promoterBankAccount: { findUnique: jest.fn() },
  cashOutWithdrawal: { create: jest.fn() },
}

beforeEach(() => {
  jest.clearAllMocks()
  mockEnabled.mockResolvedValue(true)
  p.$transaction.mockImplementation(async (cb: (t: typeof tx) => unknown) => cb(tx))
})

describe('cash-out withdrawal — createWithdrawal', () => {
  it('sums AVAILABLE into a REQUESTED withdrawal (pesos), marks entries WITHDRAWN, snapshots CLABE', async () => {
    tx.promoterCommissionEntry.findMany.mockResolvedValue([
      { id: 'e1', amount: new Prisma.Decimal(30) },
      { id: 'e2', amount: new Prisma.Decimal(45) },
    ])
    tx.promoterBankAccount.findUnique.mockResolvedValue({ clabe: '012345678901234567' })
    tx.cashOutWithdrawal.create.mockResolvedValue({ id: 'w1', folio: 'CO-1' })
    tx.promoterCommissionEntry.updateMany.mockResolvedValue({ count: 2 })

    const res = await createWithdrawal('v_pt', 'p1', { staffId: 'boss' })

    expect(res.entries).toBe(2)
    expect(res.grossAmount.toString()).toBe('75')
    const data = tx.cashOutWithdrawal.create.mock.calls[0][0].data
    expect(data).toMatchObject({ status: 'REQUESTED', venueId: 'v_pt', staffId: 'p1', clabe: '012345678901234567' })
    expect(data.grossAmount.toString()).toBe('75')
    expect(data.netAmount.toString()).toBe('75')
    expect(tx.promoterCommissionEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['e1', 'e2'] }, status: 'AVAILABLE' },
        data: expect.objectContaining({ status: 'WITHDRAWN', withdrawalId: 'w1' }),
      }),
    )
    expect(mockLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'CASH_OUT_WITHDRAWAL_REQUESTED' }))
  })

  it('throws when there is nothing available to withdraw', async () => {
    tx.promoterCommissionEntry.findMany.mockResolvedValue([])
    await expect(createWithdrawal('v_pt', 'p1', { staffId: 'boss' })).rejects.toThrow(/saldo|retirar/i)
    expect(tx.cashOutWithdrawal.create).not.toHaveBeenCalled()
  })

  it('rolls back (throws) if entries were claimed concurrently — TOCTOU guard', async () => {
    tx.promoterCommissionEntry.findMany.mockResolvedValue([{ id: 'e1', amount: new Prisma.Decimal(30) }])
    tx.promoterBankAccount.findUnique.mockResolvedValue(null)
    tx.cashOutWithdrawal.create.mockResolvedValue({ id: 'w1', folio: 'CO-1' })
    tx.promoterCommissionEntry.updateMany.mockResolvedValue({ count: 0 }) // someone else already claimed them
    await expect(createWithdrawal('v_pt', 'p1', { staffId: 'boss' })).rejects.toThrow(/cambió|concurr|intenta|de nuevo/i)
  })

  it('rejects a non-CASH_OUT venue (before any transaction)', async () => {
    mockEnabled.mockResolvedValue(false)
    await expect(createWithdrawal('v_other', 'p1', { staffId: 'boss' })).rejects.toThrow(/módulo|cash out|module/i)
    expect(p.$transaction).not.toHaveBeenCalled()
  })
})
