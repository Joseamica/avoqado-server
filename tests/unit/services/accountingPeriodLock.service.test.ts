/**
 * Unit tests (mock-first) for el candado de periodo contable.
 *  - isPeriodLocked: CLOSED → true; OPEN / sin row → false.
 *  - closePeriod / reopenPeriod: upsert + bitácora; validación de periodo; no-op sin RFC.
 *  - listPeriodLocks: candados del contribuyente.
 */
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    accountingPeriodLock: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  },
}))
jest.mock('../../../src/services/fiscal/chartOfAccounts.service', () => ({ resolveScopeOrNull: jest.fn() }))
jest.mock('../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import prisma from '../../../src/utils/prismaClient'
import { logAction } from '../../../src/services/dashboard/activity-log.service'
import { closePeriod, isPeriodLocked, listPeriodLocks, reopenPeriod } from '../../../src/services/fiscal/accountingPeriodLock.service'
import { resolveScopeOrNull } from '../../../src/services/fiscal/chartOfAccounts.service'

const p = prisma as unknown as {
  accountingPeriodLock: { findUnique: jest.Mock; upsert: jest.Mock; update: jest.Mock; findMany: jest.Mock }
}
const mScope = resolveScopeOrNull as jest.Mock
const mLog = logAction as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  mScope.mockResolvedValue({ organizationId: 'org1', rfc: 'EKU9003173C9' })
  p.accountingPeriodLock.upsert.mockResolvedValue({})
  p.accountingPeriodLock.update.mockResolvedValue({})
  mLog.mockResolvedValue(undefined)
})

describe('isPeriodLocked', () => {
  it('status CLOSED → true', async () => {
    p.accountingPeriodLock.findUnique.mockResolvedValue({ status: 'CLOSED' })
    expect(await isPeriodLocked('org1', 'EKU9003173C9', '2026-05')).toBe(true)
  })
  it('status OPEN → false (reabierto, ya no bloquea)', async () => {
    p.accountingPeriodLock.findUnique.mockResolvedValue({ status: 'OPEN' })
    expect(await isPeriodLocked('org1', 'EKU9003173C9', '2026-05')).toBe(false)
  })
  it('sin row → false', async () => {
    p.accountingPeriodLock.findUnique.mockResolvedValue(null)
    expect(await isPeriodLocked('org1', 'EKU9003173C9', '2026-05')).toBe(false)
  })
})

describe('closePeriod', () => {
  it('cierra (upsert CLOSED) por (org,rfc,period) + bitácora', async () => {
    const r = await closePeriod('v1', '2026-05', { staffId: 's' }, 'cierre mensual')
    expect(r.status).toBe('CLOSED')
    expect(p.accountingPeriodLock.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId_rfc_period: { organizationId: 'org1', rfc: 'EKU9003173C9', period: '2026-05' } },
        create: expect.objectContaining({ status: 'CLOSED', closedById: 's' }),
      }),
    )
    expect(mLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ACCOUNTING_PERIOD_CLOSED' }))
  })
  it('periodo inválido (mes 13) → 400, no escribe', async () => {
    await expect(closePeriod('v1', '2026-13', { staffId: 's' })).rejects.toThrow()
    expect(p.accountingPeriodLock.upsert).not.toHaveBeenCalled()
  })
  it('sin RFC → needsFiscalSetup, no escribe', async () => {
    mScope.mockResolvedValue(null)
    const r = await closePeriod('v1', '2026-05', { staffId: 's' })
    expect(r.needsFiscalSetup).toBe(true)
    expect(p.accountingPeriodLock.upsert).not.toHaveBeenCalled()
  })
})

describe('reopenPeriod', () => {
  it('cerrado → reabre (update OPEN) + bitácora', async () => {
    p.accountingPeriodLock.findUnique.mockResolvedValue({ status: 'CLOSED' })
    const r = await reopenPeriod('v1', '2026-05', { staffId: 's' }, 'corrección')
    expect(r.status).toBe('OPEN')
    expect(p.accountingPeriodLock.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'OPEN', reopenedById: 's' }) }),
    )
    expect(mLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'ACCOUNTING_PERIOD_REOPENED' }))
  })
  it('nunca estuvo cerrado → no-op (no update, no bitácora)', async () => {
    p.accountingPeriodLock.findUnique.mockResolvedValue(null)
    const r = await reopenPeriod('v1', '2026-05', { staffId: 's' })
    expect(r.status).toBe('OPEN')
    expect(p.accountingPeriodLock.update).not.toHaveBeenCalled()
    expect(mLog).not.toHaveBeenCalled()
  })
})

describe('listPeriodLocks', () => {
  it('lista los candados del contribuyente', async () => {
    p.accountingPeriodLock.findMany.mockResolvedValue([
      { period: '2026-05', status: 'CLOSED', closedAt: new Date(), reopenedAt: null, reason: null },
    ])
    const r = await listPeriodLocks('v1')
    expect(r.locks).toHaveLength(1)
    expect(r.rfc).toBe('EKU9003173C9')
  })
  it('sin RFC → needsFiscalSetup', async () => {
    mScope.mockResolvedValue(null)
    const r = await listPeriodLocks('v1')
    expect(r.needsFiscalSetup).toBe(true)
  })
})
