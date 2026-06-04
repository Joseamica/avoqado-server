// tests/unit/services/fiscal/cfdiCancel.service.test.ts

// Mock prisma and other heavy deps BEFORE importing the service
jest.mock('../../../../src/utils/prismaClient', () => ({ default: {} }))
jest.mock('../../../../src/services/fiscal/fiscalProvider.factory', () => ({
  resolveFiscalProvider: jest.fn(),
}))
jest.mock('../../../../src/config/logger', () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}))

import { cancelCfdi, getCfdiStatus } from '../../../../src/services/fiscal/cfdi.service'
import type { CancelCfdiDeps, GetCfdiStatusDeps } from '../../../../src/services/fiscal/cfdi.service'

// ──────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────

const stampedCfdi = {
  id: 'c1',
  venueId: 'v1',
  status: 'STAMPED',
  uuid: 'U1',
  facturapiId: 'fa1',
  fiscalEmisor: { provider: 'FACTURAPI', providerKeyEnc: null, csdStatus: 'ACTIVE' },
}

function cancelDeps(over: Partial<CancelCfdiDeps> = {}): CancelCfdiDeps {
  return {
    loadCfdi: jest.fn().mockResolvedValue(stampedCfdi),
    resolveProvider: jest.fn().mockReturnValue({
      name: 'facturapi',
      cancelInvoice: jest.fn().mockResolvedValue({ status: 'accepted', cancelledAt: new Date() }),
    } as any),
    updateCfdi: jest.fn().mockImplementation(async (_id: string, data: Record<string, any>) => ({ ...stampedCfdi, ...data })),
    ...over,
  }
}

// ──────────────────────────────────────────────────────────────────
// cancelCfdi
// ──────────────────────────────────────────────────────────────────

describe('cancelCfdi', () => {
  beforeEach(() => jest.clearAllMocks())

  it('cancels a STAMPED cfdi (motivo 02) and persists cancel status', async () => {
    const deps = cancelDeps()
    const res = await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true, expectedVenueId: 'v1' }, deps)

    expect(deps.resolveProvider).toHaveBeenCalled()

    const update = (deps.updateCfdi as jest.Mock).mock.calls[0][1]
    expect(update.cancelMotivo).toBe('02')
    expect(['ACCEPTED', 'CANCELLED', 'REQUESTED']).toContain(update.cancelStatus)
    expect(res.cancelStatus).toBeDefined()
  })

  it('tenant isolation: throws (→404) when the cfdi belongs to another venue', async () => {
    const deps = cancelDeps()
    await expect(cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true, expectedVenueId: 'OTHER' }, deps)).rejects.toThrow(/not found/i)
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  it('rejects motivo 01 without a substitute UUID', async () => {
    const deps = cancelDeps()
    await expect(cancelCfdi({ cfdiId: 'c1', motivo: '01', sandbox: true, expectedVenueId: 'v1' }, deps)).rejects.toThrow(
      /sustituci|substitut/i,
    )
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  it('rejects cancelling a cfdi that is not STAMPED', async () => {
    const deps = cancelDeps({
      loadCfdi: jest.fn().mockResolvedValue({ ...stampedCfdi, status: 'DRAFT' }),
    })
    await expect(cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true, expectedVenueId: 'v1' }, deps)).rejects.toThrow(/timbrad|stamped/i)
  })

  it('cancels a STAMPED cfdi (motivo 01) when substituteUuid is provided', async () => {
    const deps = cancelDeps()
    const res = await cancelCfdi(
      { cfdiId: 'c1', motivo: '01', substituteUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', sandbox: true, expectedVenueId: 'v1' },
      deps,
    )
    const update = (deps.updateCfdi as jest.Mock).mock.calls[0][1]
    expect(update.cancelSubstituteUuid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(res.cancelStatus).toBeDefined()
  })

  it('maps provider status "canceled" → CANCELLED and sets cfdi status to CANCELLED', async () => {
    const deps = cancelDeps({
      resolveProvider: jest.fn().mockReturnValue({
        name: 'facturapi',
        cancelInvoice: jest.fn().mockResolvedValue({ status: 'canceled', cancelledAt: new Date() }),
      } as any),
    })
    const res = await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true, expectedVenueId: 'v1' }, deps)
    expect(res.cancelStatus).toBe('CANCELLED')
    const update = (deps.updateCfdi as jest.Mock).mock.calls[0][1]
    expect(update.status).toBe('CANCELLED')
  })

  it('maps provider status "pending" → REQUESTED and leaves cfdi status unchanged', async () => {
    const deps = cancelDeps({
      resolveProvider: jest.fn().mockReturnValue({
        name: 'facturapi',
        cancelInvoice: jest.fn().mockResolvedValue({ status: 'pending', cancelledAt: null }),
      } as any),
    })
    await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true, expectedVenueId: 'v1' }, deps)
    const update = (deps.updateCfdi as jest.Mock).mock.calls[0][1]
    expect(update.cancelStatus).toBe('REQUESTED')
    // status should remain original when not accepted/cancelled
    expect(update.status).toBe('STAMPED')
  })

  it('maps provider status "rejected" → REJECTED', async () => {
    const deps = cancelDeps({
      resolveProvider: jest.fn().mockReturnValue({
        name: 'facturapi',
        cancelInvoice: jest.fn().mockResolvedValue({ status: 'rejected', cancelledAt: null }),
      } as any),
    })
    await cancelCfdi({ cfdiId: 'c1', motivo: '02', sandbox: true, expectedVenueId: 'v1' }, deps)
    const update = (deps.updateCfdi as jest.Mock).mock.calls[0][1]
    expect(update.cancelStatus).toBe('REJECTED')
  })

  it('throws when cfdi is not found', async () => {
    const deps = cancelDeps({ loadCfdi: jest.fn().mockResolvedValue(null) })
    await expect(cancelCfdi({ cfdiId: 'missing', motivo: '02', sandbox: true, expectedVenueId: 'v1' }, deps)).rejects.toThrow(/not found/i)
  })
})

// ──────────────────────────────────────────────────────────────────
// getCfdiStatus
// ──────────────────────────────────────────────────────────────────

describe('getCfdiStatus', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns the cfdi scoped to the venue', async () => {
    const deps: GetCfdiStatusDeps = { loadCfdi: jest.fn().mockResolvedValue(stampedCfdi) }
    const res = await getCfdiStatus({ cfdiId: 'c1', expectedVenueId: 'v1' }, deps)
    expect(res.uuid).toBe('U1')
    expect(res.id).toBe('c1')
  })

  it('tenant isolation: throws when venue mismatches', async () => {
    const deps: GetCfdiStatusDeps = { loadCfdi: jest.fn().mockResolvedValue(stampedCfdi) }
    await expect(getCfdiStatus({ cfdiId: 'c1', expectedVenueId: 'OTHER' }, deps)).rejects.toThrow(/not found/i)
  })

  it('throws when cfdi is not found', async () => {
    const deps: GetCfdiStatusDeps = { loadCfdi: jest.fn().mockResolvedValue(null) }
    await expect(getCfdiStatus({ cfdiId: 'missing', expectedVenueId: 'v1' }, deps)).rejects.toThrow(/not found/i)
  })
})
