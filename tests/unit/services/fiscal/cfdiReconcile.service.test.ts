// tests/unit/services/fiscal/cfdiReconcile.service.test.ts
//
// DI-based unit tests for reconcileStuckCfdi — all deps are mocked.
// Mirrors cfdiGlobal.service.test.ts patterns.

import { reconcileStuckCfdi, ReconcileCfdiDeps, ReconcileEmisor, StuckCfdi } from '../../../../src/services/fiscal/cfdiReconcile.service'
import { FiscalProvider, ProviderInvoiceSummary, StampedInvoice } from '../../../../src/services/fiscal/providers/fiscal-provider.interface'

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const EMISOR: ReconcileEmisor = {
  id: 'e1',
  venueId: 'v1',
  provider: 'FACTURAPI' as any,
  providerKeyEnc: null,
}

/** Reference 'now'. The reconcile job only feeds rows already older than its stuck threshold. */
const NOW = new Date('2026-06-05T17:00:00Z')

const CREATED_AT = new Date('2026-06-05T16:40:00Z') // ~20 min before NOW
const STALE_UPDATED = new Date('2026-06-05T16:40:00Z')

/**
 * Individual STAMPING row with NO providerInvoiceId (the real crash-after-stamp shape).
 * idempotencyKey is set — matches how new rows look after the external_id stamping change.
 */
const STUCK_INDIVIDUAL: StuckCfdi = {
  id: 'c1',
  venueId: 'v1',
  fiscalEmisorId: 'e1',
  status: 'STAMPING' as any,
  isGlobal: false,
  orderId: 'o1',
  facturapiId: null,
  idempotencyKey: 'cfdi-order-o1',
  receptorRfc: 'TEST010101AAA',
  totalCents: 11600,
  createdAt: CREATED_AT,
  updatedAt: STALE_UPDATED,
}

/** Global STAMPING row (receptor XAXX, no order). */
const STUCK_GLOBAL: StuckCfdi = {
  ...STUCK_INDIVIDUAL,
  id: 'cg1',
  isGlobal: true,
  orderId: null,
  idempotencyKey: 'cfdi-global-e1-2026-05-04',
  receptorRfc: 'XAXX010101000',
}

/** Legacy row without an idempotencyKey (pre-external_id stamping change). */
const STUCK_NO_IDEM: StuckCfdi = {
  ...STUCK_INDIVIDUAL,
  id: 'c-legacy',
  idempotencyKey: null,
}

/** A valid PAC summary that matches STUCK_INDIVIDUAL (same total, same RFC, not global). */
const MATCH_INDIVIDUAL: ProviderInvoiceSummary = {
  providerInvoiceId: 'fp1',
  uuid: 'UUID-1',
  serie: null,
  folio: '1',
  totalCents: 11600,
  status: 'valid',
  customerTaxId: 'TEST010101AAA',
  isGlobal: false,
  stampedAt: new Date('2026-06-05T16:41:00Z'),
}

const STAMPED_BY_ID: StampedInvoice = {
  providerInvoiceId: 'fp1',
  uuid: 'UUID-1',
  serie: null,
  folio: '1',
  totalCents: 11600,
  stampedAt: new Date('2026-06-05T16:41:00Z'),
  status: 'valid',
}

function makeProvider(over: Record<string, any> = {}) {
  return {
    name: 'facturapi',
    getInvoice: jest.fn().mockResolvedValue(STAMPED_BY_ID),
    searchInvoices: jest.fn().mockResolvedValue({ invoices: [], truncated: false }),
    findByExternalId: jest.fn().mockResolvedValue(null), // default: external_id miss → fall through
    downloadXml: jest.fn().mockResolvedValue(Buffer.from('<xml/>')),
    downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
    ...over,
  }
}

function makeDeps(provider: any, over: Partial<ReconcileCfdiDeps> = {}): ReconcileCfdiDeps {
  return {
    loadEmisor: jest.fn().mockResolvedValue(EMISOR),
    loadVenueSlug: jest.fn().mockResolvedValue('demo-venue'),
    resolveProvider: jest.fn().mockReturnValue(provider),
    storeArtifact: jest.fn().mockImplementation(async (_b, path) => `https://cdn/${path}`),
    completeCfdi: jest.fn().mockImplementation(async (id, data) => ({ id, ...data })),
    failCfdi: jest.fn().mockImplementation(async (id, lastError) => ({ id, status: 'STAMP_FAILED', lastError })),
    // Default: delegates to provider.findByExternalId (mirrors defaultDeps)
    findByExternalId: jest
      .fn()
      .mockImplementation((_provider: FiscalProvider, externalId: string) => provider.findByExternalId(externalId)),
    ...over,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('reconcileStuckCfdi', () => {
  // ── DETERMINISTIC PATH: external_id lookup (new rows with idempotencyKey) ────
  describe('COMPLETED via external_id lookup (deterministic path)', () => {
    it('idempotencyKey present + findByExternalId returns valid summary → COMPLETED, attribute search NOT called', async () => {
      const provider = makeProvider({
        findByExternalId: jest.fn().mockResolvedValue(MATCH_INDIVIDUAL),
      })
      const deps = makeDeps(provider)

      const result = await reconcileStuckCfdi({ cfdi: STUCK_INDIVIDUAL, now: NOW, sandbox: true }, deps)

      expect(result.outcome).toBe('COMPLETED')
      expect(result.detail).toMatch(/external_id/)
      // Deterministic hit → attribute search never called
      expect(provider.searchInvoices).not.toHaveBeenCalled()
      expect(provider.getInvoice).not.toHaveBeenCalled()
      // Downloaded artifacts and marked STAMPED
      expect(provider.downloadXml).toHaveBeenCalledWith('fp1')
      expect(provider.downloadPdf).toHaveBeenCalledWith('fp1')
      expect(deps.completeCfdi).toHaveBeenCalledTimes(1)
      const [, data] = (deps.completeCfdi as jest.Mock).mock.calls[0]
      expect(data.status).toBe('STAMPED')
      expect(data.facturapiId).toBe('fp1')
      expect(data.uuid).toBe('UUID-1')
      expect(deps.failCfdi).not.toHaveBeenCalled()
    })

    it('findByExternalId called with the idempotencyKey value', async () => {
      const findByExternalId = jest.fn().mockResolvedValue(MATCH_INDIVIDUAL)
      const provider = makeProvider({ findByExternalId })
      const deps = makeDeps(provider)

      await reconcileStuckCfdi({ cfdi: STUCK_INDIVIDUAL, now: NOW, sandbox: true }, deps)

      expect(deps.findByExternalId).toHaveBeenCalledWith(expect.anything(), 'cfdi-order-o1')
    })

    it('global row: findByExternalId hit → COMPLETED (works for global idempotencyKey too)', async () => {
      const globalMatch: ProviderInvoiceSummary = {
        ...MATCH_INDIVIDUAL,
        uuid: 'GLOBAL-UUID',
        providerInvoiceId: 'fpg1',
        isGlobal: true,
        customerTaxId: 'XAXX010101000',
      }
      const provider = makeProvider({ findByExternalId: jest.fn().mockResolvedValue(globalMatch) })
      const deps = makeDeps(provider)

      const result = await reconcileStuckCfdi({ cfdi: STUCK_GLOBAL, now: NOW, sandbox: true }, deps)

      expect(result.outcome).toBe('COMPLETED')
      const [, data] = (deps.completeCfdi as jest.Mock).mock.calls[0]
      expect(data.uuid).toBe('GLOBAL-UUID')
      expect(data.facturapiId).toBe('fpg1')
    })
  })

  describe('INCONCLUSIVE via external_id lookup (canceled document)', () => {
    it('findByExternalId returns a canceled summary → INCONCLUSIVE, attribute search NOT called', async () => {
      const canceledMatch: ProviderInvoiceSummary = { ...MATCH_INDIVIDUAL, status: 'canceled' }
      const provider = makeProvider({ findByExternalId: jest.fn().mockResolvedValue(canceledMatch) })
      const deps = makeDeps(provider)

      const result = await reconcileStuckCfdi({ cfdi: STUCK_INDIVIDUAL, now: NOW, sandbox: true }, deps)

      expect(result.outcome).toBe('INCONCLUSIVE')
      expect(result.detail).toMatch(/canceled/)
      expect(provider.searchInvoices).not.toHaveBeenCalled()
      expect(deps.completeCfdi).not.toHaveBeenCalled()
      expect(deps.failCfdi).not.toHaveBeenCalled()
    })
  })

  describe('falls back to attribute search when external_id misses', () => {
    it('idempotencyKey present + findByExternalId returns null → falls through to searchInvoices', async () => {
      // findByExternalId returns null (PAC returned empty list) → fall through
      const provider = makeProvider({
        findByExternalId: jest.fn().mockResolvedValue(null),
        searchInvoices: jest.fn().mockResolvedValue({ invoices: [MATCH_INDIVIDUAL], truncated: false }),
      })
      const deps = makeDeps(provider)

      const result = await reconcileStuckCfdi({ cfdi: STUCK_INDIVIDUAL, now: NOW, sandbox: true }, deps)

      expect(result.outcome).toBe('COMPLETED')
      // Both paths were used
      expect(deps.findByExternalId).toHaveBeenCalled()
      expect(provider.searchInvoices).toHaveBeenCalled()
    })

    it('external_id miss + attribute search empty → RESET (both agree: no document)', async () => {
      const provider = makeProvider({
        findByExternalId: jest.fn().mockResolvedValue(null),
        searchInvoices: jest.fn().mockResolvedValue({ invoices: [], truncated: false }),
      })
      const deps = makeDeps(provider)

      const result = await reconcileStuckCfdi({ cfdi: STUCK_INDIVIDUAL, now: NOW, sandbox: true }, deps)

      expect(result.outcome).toBe('RESET')
      expect(deps.failCfdi).toHaveBeenCalled()
    })

    it('no idempotencyKey (legacy row) → skips external_id path, goes straight to attribute search', async () => {
      const provider = makeProvider({
        findByExternalId: jest.fn().mockResolvedValue(null),
        searchInvoices: jest.fn().mockResolvedValue({ invoices: [], truncated: false }),
      })
      const deps = makeDeps(provider)

      const result = await reconcileStuckCfdi({ cfdi: STUCK_NO_IDEM, now: NOW, sandbox: true }, deps)

      // findByExternalId should NOT have been called (idempotencyKey is null)
      expect(deps.findByExternalId).not.toHaveBeenCalled()
      expect(provider.searchInvoices).toHaveBeenCalled()
      expect(result.outcome).toBe('RESET')
    })
  })

  // ── COMPLETED: a stamp was found ───────────────────────────────────────────
  describe('COMPLETED (orphaned stamp recovered, attribute search fallback)', () => {
    it('search by reference finds a valid match → downloads artifacts and marks STAMPED', async () => {
      const provider = makeProvider({ searchInvoices: jest.fn().mockResolvedValue({ invoices: [MATCH_INDIVIDUAL], truncated: false }) })
      const deps = makeDeps(provider)

      const result = await reconcileStuckCfdi({ cfdi: STUCK_INDIVIDUAL, now: NOW, sandbox: true }, deps)

      expect(result.outcome).toBe('COMPLETED')
      // searched (external_id missed, fell through to attribute search)
      expect(provider.searchInvoices).toHaveBeenCalledTimes(1)
      expect(provider.getInvoice).not.toHaveBeenCalled()
      // downloaded + stored both artifacts
      expect(provider.downloadXml).toHaveBeenCalledWith('fp1')
      expect(provider.downloadPdf).toHaveBeenCalledWith('fp1')
      expect(deps.storeArtifact).toHaveBeenCalledTimes(2)
      // persisted STAMPED with recovered identifiers
      const [cfdiId, data] = (deps.completeCfdi as jest.Mock).mock.calls[0]
      expect(cfdiId).toBe('c1')
      expect(data.status).toBe('STAMPED')
      expect(data.facturapiId).toBe('fp1')
      expect(data.uuid).toBe('UUID-1')
      expect(data.lastError).toBeNull()
      // never reset
      expect(deps.failCfdi).not.toHaveBeenCalled()
    })

    it('searches the PAC scoped by the row receptor RFC', async () => {
      const provider = makeProvider({ searchInvoices: jest.fn().mockResolvedValue({ invoices: [MATCH_INDIVIDUAL], truncated: false }) })
      const deps = makeDeps(provider)
      await reconcileStuckCfdi({ cfdi: STUCK_INDIVIDUAL, now: NOW, sandbox: true }, deps)
      const arg = (provider.searchInvoices as jest.Mock).mock.calls[0][0]
      expect(arg.q).toBe('TEST010101AAA')
      expect(arg.since).toBeInstanceOf(Date)
      expect(arg.until).toBeInstanceOf(Date)
      expect(arg.since.getTime()).toBeLessThan(arg.until.getTime())
    })

    it('facturapiId present → uses getInvoice(id) and completes when valid', async () => {
      const provider = makeProvider()
      const deps = makeDeps(provider)
      const row: StuckCfdi = { ...STUCK_INDIVIDUAL, facturapiId: 'fp1', idempotencyKey: null } // no idem → skip external_id

      const result = await reconcileStuckCfdi({ cfdi: row, now: NOW, sandbox: true }, deps)

      expect(result.outcome).toBe('COMPLETED')
      expect(provider.getInvoice).toHaveBeenCalledWith('fp1')
      expect(provider.searchInvoices).not.toHaveBeenCalled()
      expect(deps.completeCfdi).toHaveBeenCalled()
    })
  })

  // ── RESET: PAC definitively has no document ────────────────────────────────
  describe('RESET (no stamp at PAC, safe to retry)', () => {
    it('search returns no candidates and is not truncated → reset to STAMP_FAILED', async () => {
      const provider = makeProvider({ searchInvoices: jest.fn().mockResolvedValue({ invoices: [], truncated: false }) })
      const deps = makeDeps(provider)

      const result = await reconcileStuckCfdi({ cfdi: STUCK_INDIVIDUAL, now: NOW, sandbox: true }, deps)

      expect(result.outcome).toBe('RESET')
      const [cfdiId, lastError] = (deps.failCfdi as jest.Mock).mock.calls[0]
      expect(cfdiId).toBe('c1')
      expect(lastError).toMatch(/no document found at PAC/i)
      expect(deps.completeCfdi).not.toHaveBeenCalled()
    })

    it('total mismatch is not a match → no candidates → reset (does not adopt the wrong invoice)', async () => {
      const wrongTotal: ProviderInvoiceSummary = { ...MATCH_INDIVIDUAL, totalCents: 99999 }
      const provider = makeProvider({ searchInvoices: jest.fn().mockResolvedValue({ invoices: [wrongTotal], truncated: false }) })
      const deps = makeDeps(provider)

      const result = await reconcileStuckCfdi({ cfdi: STUCK_INDIVIDUAL, now: NOW, sandbox: true }, deps)

      expect(result.outcome).toBe('RESET')
      expect(deps.completeCfdi).not.toHaveBeenCalled()
    })

    it('getInvoice throws a not-found error → reset', async () => {
      const provider = makeProvider({ getInvoice: jest.fn().mockRejectedValue(new Error('Invoice not found')) })
      const deps = makeDeps(provider)
      const row: StuckCfdi = { ...STUCK_INDIVIDUAL, facturapiId: 'ghost', idempotencyKey: null }

      const result = await reconcileStuckCfdi({ cfdi: row, now: NOW, sandbox: true }, deps)

      expect(result.outcome).toBe('RESET')
      expect(deps.failCfdi).toHaveBeenCalled()
    })
  })

  // ── INCONCLUSIVE: never reset on doubt (avoids double-stamp) ────────────────
  describe('INCONCLUSIVE (left STAMPING — never reset on doubt)', () => {
    it('search returns no match but is truncated → inconclusive, neither completes nor resets', async () => {
      const provider = makeProvider({ searchInvoices: jest.fn().mockResolvedValue({ invoices: [], truncated: true }) })
      const deps = makeDeps(provider)

      const result = await reconcileStuckCfdi({ cfdi: STUCK_INDIVIDUAL, now: NOW, sandbox: true }, deps)

      expect(result.outcome).toBe('INCONCLUSIVE')
      expect(deps.completeCfdi).not.toHaveBeenCalled()
      expect(deps.failCfdi).not.toHaveBeenCalled()
    })

    it('a matching but CANCELED document → inconclusive (a stamp happened; resetting would double-stamp)', async () => {
      const canceled: ProviderInvoiceSummary = { ...MATCH_INDIVIDUAL, status: 'canceled' }
      const provider = makeProvider({ searchInvoices: jest.fn().mockResolvedValue({ invoices: [canceled], truncated: false }) })
      const deps = makeDeps(provider)

      const result = await reconcileStuckCfdi({ cfdi: STUCK_INDIVIDUAL, now: NOW, sandbox: true }, deps)

      expect(result.outcome).toBe('INCONCLUSIVE')
      expect(deps.completeCfdi).not.toHaveBeenCalled()
      expect(deps.failCfdi).not.toHaveBeenCalled()
    })

    it('search throws (PAC unreachable) → inconclusive, row untouched', async () => {
      const provider = makeProvider({ searchInvoices: jest.fn().mockRejectedValue(new Error('ECONNRESET')) })
      const deps = makeDeps(provider)

      const result = await reconcileStuckCfdi({ cfdi: STUCK_INDIVIDUAL, now: NOW, sandbox: true }, deps)

      expect(result.outcome).toBe('INCONCLUSIVE')
      expect(deps.completeCfdi).not.toHaveBeenCalled()
      expect(deps.failCfdi).not.toHaveBeenCalled()
    })

    it('getInvoice throws a transient (non-not-found) error → inconclusive, NOT reset', async () => {
      const provider = makeProvider({ getInvoice: jest.fn().mockRejectedValue(new Error('503 Service Unavailable')) })
      const deps = makeDeps(provider)
      const row: StuckCfdi = { ...STUCK_INDIVIDUAL, facturapiId: 'fp1', idempotencyKey: null }

      const result = await reconcileStuckCfdi({ cfdi: row, now: NOW, sandbox: true }, deps)

      expect(result.outcome).toBe('INCONCLUSIVE')
      expect(deps.failCfdi).not.toHaveBeenCalled()
    })

    it('findByExternalId throws (PAC unreachable) → INCONCLUSIVE, row untouched (error caught at top level)', async () => {
      const provider = makeProvider({
        findByExternalId: jest.fn().mockRejectedValue(new Error('ECONNRESET')),
      })
      const deps = makeDeps(provider)

      const result = await reconcileStuckCfdi({ cfdi: STUCK_INDIVIDUAL, now: NOW, sandbox: true }, deps)

      expect(result.outcome).toBe('INCONCLUSIVE')
      expect(deps.completeCfdi).not.toHaveBeenCalled()
      expect(deps.failCfdi).not.toHaveBeenCalled()
    })
  })

  // ── SKIPPED: not actionable ─────────────────────────────────────────────────
  describe('SKIPPED', () => {
    it('row no longer STAMPING → skipped, PAC never queried', async () => {
      const provider = makeProvider()
      const deps = makeDeps(provider)
      const row: StuckCfdi = { ...STUCK_INDIVIDUAL, status: 'STAMPED' as any }

      const result = await reconcileStuckCfdi({ cfdi: row, now: NOW, sandbox: true }, deps)

      expect(result.outcome).toBe('SKIPPED')
      expect(deps.resolveProvider).not.toHaveBeenCalled()
      expect(provider.searchInvoices).not.toHaveBeenCalled()
    })

    it('emisor not found → skipped (cannot resolve a connector)', async () => {
      const provider = makeProvider()
      const deps = makeDeps(provider, { loadEmisor: jest.fn().mockResolvedValue(null) })

      const result = await reconcileStuckCfdi({ cfdi: STUCK_INDIVIDUAL, now: NOW, sandbox: true }, deps)

      expect(result.outcome).toBe('SKIPPED')
      expect(deps.resolveProvider).not.toHaveBeenCalled()
    })
  })

  // ── Matching strictness (global vs individual) ──────────────────────────────
  describe('match strictness — global flag must agree', () => {
    it('individual row does NOT adopt a global PAC invoice with the same total → reset', async () => {
      const globalInvoice: ProviderInvoiceSummary = { ...MATCH_INDIVIDUAL, isGlobal: true, customerTaxId: 'XAXX010101000' }
      const provider = makeProvider({ searchInvoices: jest.fn().mockResolvedValue({ invoices: [globalInvoice], truncated: false }) })
      const deps = makeDeps(provider)

      const result = await reconcileStuckCfdi({ cfdi: STUCK_INDIVIDUAL, now: NOW, sandbox: true }, deps)

      expect(result.outcome).toBe('RESET')
      expect(deps.completeCfdi).not.toHaveBeenCalled()
    })

    it('global row matches a global PAC invoice (XAXX, isGlobal) with same total → completed', async () => {
      const globalMatch: ProviderInvoiceSummary = {
        ...MATCH_INDIVIDUAL,
        uuid: 'GLOBAL-UUID',
        providerInvoiceId: 'fpg1',
        isGlobal: true,
        customerTaxId: 'XAXX010101000',
      }
      const provider = makeProvider({ searchInvoices: jest.fn().mockResolvedValue({ invoices: [globalMatch], truncated: false }) })
      const deps = makeDeps(provider)

      const result = await reconcileStuckCfdi({ cfdi: STUCK_GLOBAL, now: NOW, sandbox: true }, deps)

      expect(result.outcome).toBe('COMPLETED')
      const [, data] = (deps.completeCfdi as jest.Mock).mock.calls[0]
      expect(data.uuid).toBe('GLOBAL-UUID')
      expect(data.facturapiId).toBe('fpg1')
    })
  })

  // ── Regression: a clean COMPLETED leaves no STAMP_FAILED side effects ────────
  describe('regression: outcomes are mutually exclusive', () => {
    it('COMPLETED never also resets, RESET never also completes', async () => {
      // COMPLETED path (external_id hit)
      const p1 = makeProvider({ findByExternalId: jest.fn().mockResolvedValue(MATCH_INDIVIDUAL) })
      const d1 = makeDeps(p1)
      await reconcileStuckCfdi({ cfdi: STUCK_INDIVIDUAL, now: NOW, sandbox: true }, d1)
      expect(d1.completeCfdi).toHaveBeenCalledTimes(1)
      expect(d1.failCfdi).not.toHaveBeenCalled()

      // RESET path (both external_id and attribute search return nothing)
      const p2 = makeProvider({ searchInvoices: jest.fn().mockResolvedValue({ invoices: [], truncated: false }) })
      const d2 = makeDeps(p2)
      await reconcileStuckCfdi({ cfdi: STUCK_INDIVIDUAL, now: NOW, sandbox: true }, d2)
      expect(d2.failCfdi).toHaveBeenCalledTimes(1)
      expect(d2.completeCfdi).not.toHaveBeenCalled()
    })
  })
})
