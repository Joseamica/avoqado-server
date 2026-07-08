/** Unit tests — pérdidas fiscales de ejercicios anteriores (captura manual del saldo por contribuyente). */
import { BadRequestError } from '../../../../src/errors/AppError'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { fiscalLossCarryforward: { findUnique: jest.fn(), upsert: jest.fn() } },
}))
jest.mock('../../../../src/services/fiscal/chartOfAccounts.service', () => ({ resolveScopeOrNull: jest.fn() }))
jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import prisma from '../../../../src/utils/prismaClient'
import { resolveScopeOrNull } from '../../../../src/services/fiscal/chartOfAccounts.service'
import { logAction } from '../../../../src/services/dashboard/activity-log.service'
import { getFiscalLoss, setFiscalLoss, getPendingLossCents } from '../../../../src/services/fiscal/fiscalLoss.service'

const p = prisma as unknown as { fiscalLossCarryforward: { findUnique: jest.Mock; upsert: jest.Mock } }
const mScope = resolveScopeOrNull as jest.Mock
const mLog = logAction as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  mScope.mockResolvedValue({ organizationId: 'org1', rfc: 'EKU9003173C9' })
})

describe('getPendingLossCents', () => {
  it('devuelve el saldo si existe, 0 si no', async () => {
    p.fiscalLossCarryforward.findUnique.mockResolvedValue({ pendingCents: 8_000_00 })
    expect(await getPendingLossCents('org1', 'R')).toBe(8_000_00)
    p.fiscalLossCarryforward.findUnique.mockResolvedValue(null)
    expect(await getPendingLossCents('org1', 'R')).toBe(0)
  })
})

describe('getFiscalLoss', () => {
  it('sin RFC → needsFiscalSetup', async () => {
    mScope.mockResolvedValue(null)
    const r = await getFiscalLoss('v1')
    expect(r.needsFiscalSetup).toBe(true)
    expect(r.pendingCents).toBe(0)
  })

  it('sin renglón capturado → hasEntry false, ceros', async () => {
    p.fiscalLossCarryforward.findUnique.mockResolvedValue(null)
    const r = await getFiscalLoss('v1')
    expect(r.hasEntry).toBe(false)
    expect(r.pendingCents).toBe(0)
  })

  it('con renglón → hasEntry true + saldo', async () => {
    p.fiscalLossCarryforward.findUnique.mockResolvedValue({ pendingCents: 12_000_00, note: 'ejercicio 2024' })
    const r = await getFiscalLoss('v1')
    expect(r.hasEntry).toBe(true)
    expect(r.pendingCents).toBe(12_000_00)
    expect(r.note).toBe('ejercicio 2024')
  })
})

describe('setFiscalLoss', () => {
  it('saldo negativo → BadRequestError', async () => {
    await expect(setFiscalLoss('v1', { pendingCents: -1 })).rejects.toThrow(BadRequestError)
  })

  it('sin RFC → BadRequestError', async () => {
    mScope.mockResolvedValue(null)
    await expect(setFiscalLoss('v1', { pendingCents: 1000 })).rejects.toThrow(BadRequestError)
  })

  it('upsert + auditoría', async () => {
    p.fiscalLossCarryforward.upsert.mockResolvedValue({ id: 'fl1', pendingCents: 8_000_00, note: null })
    const r = await setFiscalLoss('v1', { pendingCents: 8_000_00 }, 'staff1')
    expect(r.pendingCents).toBe(8_000_00)
    expect(p.fiscalLossCarryforward.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId_rfc: { organizationId: 'org1', rfc: 'EKU9003173C9' } } }),
    )
    expect(mLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'FISCAL_LOSS_SET', staffId: 'staff1' }))
  })
})
