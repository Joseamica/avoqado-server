// tests/unit/services/fiscal/salesRetention.service.test.ts
import { BadRequestError } from '../../../../src/errors/AppError'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { salesRetention: { findUnique: jest.fn(), upsert: jest.fn() } },
}))
jest.mock('../../../../src/services/fiscal/chartOfAccounts.service', () => ({ resolveScopeOrNull: jest.fn() }))
jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import prisma from '../../../../src/utils/prismaClient'
import { resolveScopeOrNull } from '../../../../src/services/fiscal/chartOfAccounts.service'
import { logAction } from '../../../../src/services/dashboard/activity-log.service'
import { getSalesRetention, setSalesRetention, getSalesRetentionCents } from '../../../../src/services/fiscal/salesRetention.service'

const p = prisma as unknown as { salesRetention: { findUnique: jest.Mock; upsert: jest.Mock } }
const mScope = resolveScopeOrNull as jest.Mock
const mLog = logAction as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  mScope.mockResolvedValue({ organizationId: 'org1', rfc: 'RFC' })
  p.salesRetention.findUnique.mockResolvedValue(null)
})

describe('getSalesRetentionCents', () => {
  it('null cuando el contador no capturó el periodo (no asumir 0)', async () => {
    expect(await getSalesRetentionCents('org1', 'RFC', '2026-06')).toBeNull()
  })
  it('devuelve los montos capturados', async () => {
    p.salesRetention.findUnique.mockResolvedValue({ isrRetenidoCents: 5000, ivaRetenidoCents: 3000 })
    expect(await getSalesRetentionCents('org1', 'RFC', '2026-06')).toEqual({ isrRetenidoCents: 5000, ivaRetenidoCents: 3000 })
  })
})

describe('getSalesRetention (por venue)', () => {
  it('periodo inválido → BadRequestError', async () => {
    await expect(getSalesRetention('v1', '2026-13')).rejects.toThrow(BadRequestError)
  })
  it('sin RFC → needsFiscalSetup, ceros, hasEntry=false', async () => {
    mScope.mockResolvedValue(null)
    const r = await getSalesRetention('v1', '2026-06')
    expect(r.needsFiscalSetup).toBe(true)
    expect(r.hasEntry).toBe(false)
    expect(r.isrRetenidoCents).toBe(0)
  })
  it('sin renglón capturado → ceros, hasEntry=false', async () => {
    const r = await getSalesRetention('v1', '2026-06')
    expect(r.hasEntry).toBe(false)
    expect(r.isrRetenidoCents).toBe(0)
  })
  it('con renglón → montos + hasEntry=true', async () => {
    p.salesRetention.findUnique.mockResolvedValue({ isrRetenidoCents: 5000, ivaRetenidoCents: 3000, note: 'Cliente X' })
    const r = await getSalesRetention('v1', '2026-06')
    expect(r.hasEntry).toBe(true)
    expect(r.isrRetenidoCents).toBe(5000)
    expect(r.ivaRetenidoCents).toBe(3000)
    expect(r.note).toBe('Cliente X')
  })
})

describe('setSalesRetention', () => {
  it('periodo inválido → BadRequestError', async () => {
    await expect(setSalesRetention('v1', '2026-13', {})).rejects.toThrow(BadRequestError)
  })
  it('montos negativos → BadRequestError', async () => {
    await expect(setSalesRetention('v1', '2026-06', { isrRetenidoCents: -1 })).rejects.toThrow(/negativ/i)
  })
  it('sin RFC → BadRequestError', async () => {
    mScope.mockResolvedValue(null)
    await expect(setSalesRetention('v1', '2026-06', { isrRetenidoCents: 100 })).rejects.toThrow(BadRequestError)
  })
  it('upsert + auditoría', async () => {
    p.salesRetention.upsert.mockResolvedValue({ id: 'sr1', isrRetenidoCents: 5000, ivaRetenidoCents: 3000, note: null })
    const r = await setSalesRetention('v1', '2026-06', { isrRetenidoCents: 5000, ivaRetenidoCents: 3000 }, 'staff1')
    expect(r.hasEntry).toBe(true)
    expect(r.isrRetenidoCents).toBe(5000)
    const where = p.salesRetention.upsert.mock.calls[0][0].where.organizationId_rfc_period
    expect(where).toEqual({ organizationId: 'org1', rfc: 'RFC', period: '2026-06' })
    expect(mLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'SALES_RETENTION_SET', entity: 'SalesRetention' }))
  })
})
