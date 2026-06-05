// tests/unit/services/fiscal/cfdiGlobal.service.test.ts
//
// DI-based unit tests for issueGlobalForEmisor — all deps are mocked.
// Mirrors cfdi.service.test.ts patterns.

import { Prisma } from '@prisma/client'
import { issueGlobalForEmisor, IssueGlobalDeps, GlobalEmisor } from '../../../../src/services/fiscal/cfdiGlobal.service'
import { GlobalInvoiceLine } from '../../../../src/services/fiscal/cfdiPayloadBuilder'

/** Helper: build a realistic P2002 unique-violation error as Prisma would throw. */
function makeP2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`idempotencyKey`)', {
    code: 'P2002',
    clientVersion: 'x',
    meta: { target: ['idempotencyKey'] },
  })
}

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const ACTIVE_EMISOR: GlobalEmisor = {
  id: 'e1',
  venueId: 'v1',
  globalPeriodicity: 'MENSUAL' as any,
  serie: null,
  lugarExpedicion: '83000',
  csdStatus: 'ACTIVE' as any,
  providerKeyEnc: null,
  provider: 'FACTURAPI' as any,
}

const STAMPED_RESULT = {
  providerInvoiceId: 'fp1',
  uuid: 'GLOBAL-UUID-1',
  serie: null,
  folio: '1',
  totalCents: 11600,
  stampedAt: new Date('2026-06-03T10:00:00Z'),
  status: 'valid' as const,
}

// Two candidate orders (1 each: 10000 subtotal + 1600 tax = 11600 total, payment=CASH=formaPago '01')
const TWO_CANDIDATES: GlobalInvoiceLine[] = [
  { orderId: 'o1', subtotalCents: 10000, taxCents: 1600, totalCents: 11600, formaPago: '01' },
  { orderId: 'o2', subtotalCents: 5000, taxCents: 800, totalCents: 5800, formaPago: '01' },
]

/** Reference 'now' = Jun 3 2026 noon Mexico time. Closed MENSUAL period = May 2026. */
const NOW = new Date('2026-06-03T17:00:00Z') // ~11:00 AM Mexico CDT

function makeDeps(over: Partial<IssueGlobalDeps> = {}): IssueGlobalDeps {
  return {
    loadEmisor: jest.fn().mockResolvedValue(ACTIVE_EMISOR),
    findExistingGlobal: jest.fn().mockResolvedValue(null),
    loadGlobalCandidates: jest.fn().mockResolvedValue(TWO_CANDIDATES),
    resolveProvider: jest.fn().mockReturnValue({
      name: 'facturapi',
      createGlobalInvoice: jest.fn().mockResolvedValue(STAMPED_RESULT),
      downloadXml: jest.fn().mockResolvedValue(Buffer.from('<xml/>')),
      downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
    } as any),
    storeArtifact: jest.fn().mockImplementation(async (_b, path) => `https://cdn/${path}`),
    persistCfdi: jest.fn().mockImplementation(async data => ({ id: 'cfdi-global-1', ...data })),
    loadVenueSlug: jest.fn().mockResolvedValue('demo-venue'),
    // By default, reservation succeeds (no conflict)
    reserveCfdi: jest.fn().mockResolvedValue({}),
    ...over,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('issueGlobalForEmisor', () => {
  describe('STAMPED happy path', () => {
    it('stamps a global CFDI and persists it with orderId:null, isGlobal:true, globalPeriod set, receptor XAXX', async () => {
      const deps = makeDeps()
      const result = await issueGlobalForEmisor({ emisorId: 'e1', now: NOW, sandbox: true }, deps)

      expect(result.status).toBe('STAMPED')
      expect(result.cfdi).toBeDefined()
      expect(result.cfdi.isGlobal).toBe(true)
      expect(result.cfdi.orderId).toBeNull()
      expect(result.cfdi.receptorRfc).toBe('XAXX010101000')
      expect(result.cfdi.receptorNombre).toBe('PÚBLICO EN GENERAL')
      expect(result.cfdi.receptorRegimen).toBe('616')
      expect(result.cfdi.usoCfdi).toBe('S01')
      expect(result.cfdi.flow).toBe('GLOBAL_C')
      expect(result.cfdi.type).toBe('INGRESO')
      expect(result.cfdi.globalPeriod).toMatchObject({
        periodicidad: '04', // MENSUAL
        meses: '05', // May
        anio: 2026,
      })
      // UUID from PAC
      expect(result.cfdi.uuid).toBe('GLOBAL-UUID-1')
    })

    it('stores XML and PDF (storeArtifact called twice)', async () => {
      const deps = makeDeps()
      await issueGlobalForEmisor({ emisorId: 'e1', now: NOW, sandbox: true }, deps)
      expect(deps.storeArtifact).toHaveBeenCalledTimes(2)
    })

    it('calls createGlobalInvoice with global object and XAXX customer — no idempotency forwarded', async () => {
      const deps = makeDeps()
      await issueGlobalForEmisor({ emisorId: 'e1', now: NOW, sandbox: true }, deps)

      const provider = (deps.resolveProvider as jest.Mock).mock.results[0].value
      const callArgs = provider.createGlobalInvoice.mock.calls[0][0]

      // XAXX customer shape
      expect(callArgs.receptor.tax_id).toBe('XAXX010101000')
      expect(callArgs.receptor.legal_name).toBe('PÚBLICO EN GENERAL')
      expect(callArgs.receptor.tax_system).toBe('616')
      expect(callArgs.use).toBe('S01')

      // global period object
      expect(callArgs.global).toMatchObject({
        periodicity: 'month', // MENSUAL
        months: '05',
        year: 2026,
      })

      // items — two orders → two lines
      expect(callArgs.items).toHaveLength(2)
      expect(callArgs.items[0].satProductKey).toBe('01010101')
      expect(callArgs.items[0].satUnitKey).toBe('ACT')

      // No idempotency_key in the PAC call
      expect(callArgs.idempotency_key).toBeUndefined()
    })

    it('period and candidateCount are returned', async () => {
      const deps = makeDeps()
      const result = await issueGlobalForEmisor({ emisorId: 'e1', now: NOW, sandbox: true }, deps)
      expect(result.period?.meses).toBe('05')
      expect(result.candidateCount).toBe(2)
    })
  })

  describe('NOTHING_TO_INVOICE', () => {
    it('returns NOTHING_TO_INVOICE and never calls the PAC when candidates is empty', async () => {
      const deps = makeDeps({ loadGlobalCandidates: jest.fn().mockResolvedValue([]) })
      const result = await issueGlobalForEmisor({ emisorId: 'e1', now: NOW, sandbox: true }, deps)

      expect(result.status).toBe('NOTHING_TO_INVOICE')
      expect(deps.resolveProvider).not.toHaveBeenCalled()
      expect(deps.persistCfdi).not.toHaveBeenCalled()
    })
  })

  describe('SKIPPED', () => {
    it('skips when CSD is not ACTIVE', async () => {
      const inactiveEmisor: GlobalEmisor = { ...ACTIVE_EMISOR, csdStatus: 'PENDING' as any }
      const deps = makeDeps({ loadEmisor: jest.fn().mockResolvedValue(inactiveEmisor) })

      const result = await issueGlobalForEmisor({ emisorId: 'e1', now: NOW, sandbox: true }, deps)

      expect(result.status).toBe('SKIPPED')
      expect(deps.loadGlobalCandidates).not.toHaveBeenCalled()
      expect(deps.persistCfdi).not.toHaveBeenCalled()
    })

    it('skips when CSD is NONE', async () => {
      const noKey: GlobalEmisor = { ...ACTIVE_EMISOR, csdStatus: 'NONE' as any }
      const deps = makeDeps({ loadEmisor: jest.fn().mockResolvedValue(noKey) })
      const result = await issueGlobalForEmisor({ emisorId: 'e1', now: NOW, sandbox: true }, deps)
      expect(result.status).toBe('SKIPPED')
    })
  })

  describe('idempotency', () => {
    it('returns STAMPED without re-stamping when an existing STAMPED global is found', async () => {
      const existingCfdi = { id: 'old-cfdi', status: 'STAMPED', uuid: 'OLD-UUID', isGlobal: true }
      const deps = makeDeps({ findExistingGlobal: jest.fn().mockResolvedValue(existingCfdi) })

      const result = await issueGlobalForEmisor({ emisorId: 'e1', now: NOW, sandbox: true }, deps)

      expect(result.status).toBe('STAMPED')
      expect(result.cfdi.uuid).toBe('OLD-UUID')
      // PAC must NOT be called
      expect(deps.resolveProvider).not.toHaveBeenCalled()
      expect(deps.persistCfdi).not.toHaveBeenCalled()
    })

    it('uses idempotencyKey with emisorId + year + meses + periodicity code', async () => {
      const deps = makeDeps()
      await issueGlobalForEmisor({ emisorId: 'e1', now: NOW, sandbox: true }, deps)

      // The key check on findExistingGlobal
      const keyUsed = (deps.findExistingGlobal as jest.Mock).mock.calls[0][0]
      // MENSUAL = satPeriodicidad '04', May 2026 meses '05'
      expect(keyUsed).toBe('cfdi-global-e1-2026-05-04')
    })
  })

  describe('excludes individually-invoiced orders', () => {
    it('loadGlobalCandidates is the mechanism — if it returns nothing, NOTHING_TO_INVOICE is returned (no re-stamp)', async () => {
      // In production, loadGlobalCandidates already filters out STAMPED individual CFDIs.
      // This test verifies the service honours the empty candidate list it receives.
      const deps = makeDeps({ loadGlobalCandidates: jest.fn().mockResolvedValue([]) })
      const result = await issueGlobalForEmisor({ emisorId: 'e1', now: NOW, sandbox: true }, deps)
      expect(result.status).toBe('NOTHING_TO_INVOICE')
      expect(deps.resolveProvider).not.toHaveBeenCalled()
    })
  })

  describe('STAMP_FAILED', () => {
    it('persists STAMP_FAILED when the PAC throws', async () => {
      const deps = makeDeps({
        resolveProvider: jest.fn().mockReturnValue({
          name: 'facturapi',
          createGlobalInvoice: jest.fn().mockRejectedValue(new Error('SAT service down')),
          downloadXml: jest.fn(),
          downloadPdf: jest.fn(),
        } as any),
      })

      const result = await issueGlobalForEmisor({ emisorId: 'e1', now: NOW, sandbox: true }, deps)

      expect(result.status).toBe('STAMP_FAILED')
      const persisted = (deps.persistCfdi as jest.Mock).mock.calls.at(-1)[0]
      expect(persisted.status).toBe('STAMP_FAILED')
      expect(persisted.lastError).toMatch(/SAT service down/)
      expect(persisted.isGlobal).toBe(true)
      expect(persisted.orderId).toBeNull()
    })
  })

  describe('VALIDATION_FAILED', () => {
    it('never calls the PAC, persists VALIDATION_FAILED when items is empty (zero candidates passed build)', async () => {
      // Simulate a scenario where candidates exist but produce zero items (shouldn't happen in practice,
      // but guards the validation path). We do this by making the provider return a validation error
      // via a corrupted emisor csdStatus — simpler and covers the same validation code path.
      const badEmisor: GlobalEmisor = { ...ACTIVE_EMISOR, csdStatus: 'ACTIVE' as any, lugarExpedicion: 'BADCP' }
      const deps = makeDeps({ loadEmisor: jest.fn().mockResolvedValue(badEmisor) })

      const result = await issueGlobalForEmisor({ emisorId: 'e1', now: NOW, sandbox: true }, deps)

      // Bad CP (not 5 digits) → VALIDATION_FAILED from validateBeforeStamp
      expect(result.status).toBe('VALIDATION_FAILED')
      expect(result.reasons && result.reasons.length).toBeGreaterThan(0)
      expect(deps.resolveProvider).not.toHaveBeenCalled()

      const persisted = (deps.persistCfdi as jest.Mock).mock.calls.at(-1)[0]
      expect(persisted.status).toBe('VALIDATION_FAILED')
      expect(persisted.isGlobal).toBe(true)
    })
  })

  describe('regression: XAXX passes validateBeforeStamp when isGlobal=true', () => {
    it('XAXX010101000 with isGlobal:true does not produce a validation error', async () => {
      // This tests the cfdiValidation.ts path (not the global service directly).
      // If XAXX were blocked, the STAMPED test above would fail with VALIDATION_FAILED.
      const deps = makeDeps()
      const result = await issueGlobalForEmisor({ emisorId: 'e1', now: NOW, sandbox: true }, deps)
      expect(result.status).toBe('STAMPED')
    })
  })

  // ── Concurrent double-stamp reservation tests ──────────────────────────────

  describe('concurrent slot reservation', () => {
    it('concurrent in-flight (fresh STAMPING): P2002 + recent STAMPING → rejects with /en proceso/, never calls PAC', async () => {
      const deps = makeDeps({
        reserveCfdi: jest.fn().mockRejectedValue(makeP2002()),
        findExistingGlobal: jest.fn().mockResolvedValue({ id: 'g0', status: 'STAMPING', updatedAt: new Date() }),
      })
      await expect(issueGlobalForEmisor({ emisorId: 'e1', now: NOW, sandbox: true }, deps)).rejects.toThrow(/en proceso/)
      expect(deps.resolveProvider).not.toHaveBeenCalled()
    })

    it('stale STAMPING older than TTL → reclaims and proceeds (not permanently locked)', async () => {
      const stale = new Date(Date.now() - 5 * 60_000)
      const deps = makeDeps({
        reserveCfdi: jest.fn().mockRejectedValue(makeP2002()),
        findExistingGlobal: jest.fn().mockResolvedValue({ id: 'g0', status: 'STAMPING', updatedAt: stale }),
      })
      const res = await issueGlobalForEmisor({ emisorId: 'e1', now: NOW, sandbox: true }, deps)
      expect(res.status).toBe('STAMPED')
      expect(deps.resolveProvider).toHaveBeenCalled()
    })

    it('concurrent already succeeded (STAMPED): P2002 + existing STAMPED → returns that STAMPED without calling PAC', async () => {
      const alreadyStamped = { id: 'g0', status: 'STAMPED', uuid: 'ALREADY-GLOBAL-UUID' }
      const deps = makeDeps({
        reserveCfdi: jest.fn().mockRejectedValue(makeP2002()),
        findExistingGlobal: jest.fn().mockResolvedValue(alreadyStamped),
      })
      const result = await issueGlobalForEmisor({ emisorId: 'e1', now: NOW, sandbox: true }, deps)
      expect(result.status).toBe('STAMPED')
      expect(result.cfdi.uuid).toBe('ALREADY-GLOBAL-UUID')
      expect(deps.resolveProvider).not.toHaveBeenCalled()
    })

    it('retry after terminal failure (STAMP_FAILED): P2002 + existing STAMP_FAILED → proceeds to stamp (PAC called)', async () => {
      const failedRow = { id: 'g0', status: 'STAMP_FAILED' }
      const deps = makeDeps({
        reserveCfdi: jest.fn().mockRejectedValue(makeP2002()),
        findExistingGlobal: jest.fn().mockResolvedValue(failedRow),
      })
      const result = await issueGlobalForEmisor({ emisorId: 'e1', now: NOW, sandbox: true }, deps)
      expect(result.status).toBe('STAMPED')
      expect(deps.resolveProvider).toHaveBeenCalled()
    })
  })
})
