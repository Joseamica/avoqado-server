import { CfdiStatus } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { uploadFileToStorage } from '../storage.service'
import { resolveFiscalProvider } from './fiscalProvider.factory'
import { FiscalProvider, ProviderInvoiceSummary, StampedInvoice } from './providers/fiscal-provider.interface'

import { finalizarTimbre, completarArchivos, escalarIntentoIncierto } from './finalizadorCfdi'

// ─── Result types ─────────────────────────────────────────────────────────────

export type ReconcileOutcome =
  | 'COMPLETED' // a real stamp existed at the PAC → row marked STAMPED with downloaded artifacts
  | 'RESET' // sin documento encontrado → STAMP_FAILED incierto, misma versión y sellos
  | 'INCONCLUSIVE' // PAC unreachable / ambiguous (e.g. canceled doc, truncated search) → left STAMPING
  | 'SKIPPED' // not actionable (row not STAMPING, emisor missing)

export interface ReconcileResult {
  outcome: ReconcileOutcome
  cfdiId: string
  detail?: string
}

// ─── DI interfaces ────────────────────────────────────────────────────────────

/** The subset of a stuck Cfdi row the reconcile needs. */
export interface StuckCfdi {
  id: string
  venueId: string
  fiscalEmisorId: string
  status: CfdiStatus
  isGlobal: boolean
  orderId: string | null
  /** Id del proveedor; también existe mientras una respuesta pending espera su UUID. */
  facturapiId: string | null
  /**
   * Our idempotencyKey — also stamped as `external_id` on the PAC document at create time.
   * When present, enables a deterministic lookup that short-circuits the attribute-search fallback.
   */
  idempotencyKey: string | null
  receptorRfc: string
  totalCents: number
  createdAt: Date
  updatedAt: Date
  attempts: number
  protocoloIva: number | null
  falloDefinitivo: boolean
  enviadoAt: Date | null
}

/** Emisor fields needed to resolve the PAC connector. */
export interface ReconcileEmisor {
  id: string
  venueId: string
  provider: any // FiscalProviderType
  providerKeyEnc: string | null
}

export interface ReconcileCfdiDeps {
  loadEmisor: (emisorId: string) => Promise<ReconcileEmisor | null>
  loadVenueSlug: (venueId: string) => Promise<string>
  resolveProvider: typeof resolveFiscalProvider
  storeArtifact: (buffer: Buffer, path: string, contentType: string) => Promise<string>
  /** Finalizador compartido: versión + estado, identidad antes de archivos. */
  completeCfdi: typeof finalizarTimbre
  /** RESET sólo desde STAMPING de esta versión, sin liberar sellos ni incrementar attempts. */
  failCfdi: (cfdiId: string, version: number, lastError: string) => Promise<boolean>
  escalate: typeof escalarIntentoIncierto
  /**
   * Deterministic lookup — delegates to `provider.findByExternalId(externalId)`.
   * Extracted into deps so tests can mock it independently of the provider mock.
   * Default implementation calls provider.findByExternalId directly.
   */
  findByExternalId: (provider: FiscalProvider, externalId: string) => Promise<ProviderInvoiceSummary | null>
}

// How wide a window around the row's createdAt to search the PAC. The reconcile job only picks up
// rows already older than its stuck-threshold, so a generous window tolerates clock skew between
// our DB and the PAC without risking a missed orphan (a missed orphan → wrong reset → double-stamp).
const SEARCH_WINDOW_MS = 24 * 60 * 60_000 // ±1 day

// ─── Core function ────────────────────────────────────────────────────────────

/**
 * Reconciles ONE stuck-STAMPING Cfdi row against the PAC.
 *
 * @param params.cfdi    - the stuck row (status must be STAMPING)
 * @param params.now     - reference time (inject for testability — don't call Date.now() here)
 * @param params.sandbox - use the sandbox/test PAC key (true in dev/staging)
 * @param deps           - DI deps; real defaultDeps used in production
 */
export async function reconcileStuckCfdi(
  params: { cfdi: StuckCfdi; now: Date; sandbox: boolean },
  overrides: Partial<ReconcileCfdiDeps> = {},
): Promise<ReconcileResult> {
  const deps = { ...defaultDeps, ...overrides }
  const { cfdi, now, sandbox } = params
  const incierto = cfdi.protocoloIva === 1 && cfdi.enviadoAt !== null && !cfdi.falloDefinitivo
  if (cfdi.status !== 'STAMPING' && !(cfdi.status === 'STAMP_FAILED' && incierto)) return { outcome: 'SKIPPED', cfdiId: cfdi.id }
  try {
    const emisor = await deps.loadEmisor(cfdi.fiscalEmisorId)
    if (!emisor) return { outcome: 'SKIPPED', cfdiId: cfdi.id, detail: 'emisor not found' }
    const provider = deps.resolveProvider(emisor as any, { sandbox })
    let lookup: PacLookup = { kind: 'NONE' }
    try {
      // Un pending ya tiene identidad del PAC. Siempre consultar ese id antes de buscar.
      if (cfdi.facturapiId) {
        lookup = await lookupById(provider, cfdi.facturapiId)
      } else if (cfdi.idempotencyKey) {
        const externalId = cfdi.protocoloIva === 1 ? `${cfdi.idempotencyKey}#${cfdi.attempts}` : cfdi.idempotencyKey
        const summary = await deps.findByExternalId(provider, externalId)
        if (summary) lookup = lookupFromInvoice(summary)
      }
      if (lookup.kind === 'NONE' && !cfdi.facturapiId && cfdi.protocoloIva === null) lookup = await lookupByReference(provider, cfdi, now)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`[cfdiReconcile] PAC lookup failed for cfdi=${cfdi.id}: ${message}`)
      return { outcome: 'INCONCLUSIVE', cfdiId: cfdi.id, detail: `pac lookup error: ${message}` }
    }
    if (lookup.kind === 'VALID') {
      const result = await completeFromPac(deps, cfdi, emisor, provider, lookup.invoice, now)
      return {
        outcome: result === 'DUPLICADO' ? 'INCONCLUSIVE' : 'COMPLETED',
        cfdiId: cfdi.id,
        detail: `uuid=${lookup.invoice.uuid} (external_id/id/reference)`,
      }
    }
    if (lookup.kind !== 'NONE' || (cfdi.facturapiId && cfdi.protocoloIva === 1))
      return { outcome: 'INCONCLUSIVE', cfdiId: cfdi.id, detail: lookup.kind.toLowerCase() }
    const changed = await deps.failCfdi(
      cfdi.id,
      cfdi.attempts,
      `Reconcile (${now.toISOString()}): no document found at PAC; intento incierto, sellos conservados`,
    )
    return { outcome: changed ? 'RESET' : 'SKIPPED', cfdiId: cfdi.id, detail: 'no document at PAC' }
  } finally {
    if (incierto) await deps.escalate(cfdi, now)
  }
}

// ─── PAC lookup ─────────────────────────────────────────────────────────────

type PacLookup =
  | {
      kind: 'VALID'
      invoice: { providerInvoiceId: string; uuid: string | null; serie: string | null; folio: string | null; stampedAt: Date | null }
    }
  | { kind: 'CANCELED' }
  | { kind: 'PENDING' }
  | { kind: 'AMBIGUOUS' } // truncated search results — cannot conclude "no stamp"
  | { kind: 'NONE' } // PAC definitively has no document

// Phrases facturapi returns in its error `message` when an invoice id does not exist. Used to
// distinguish a genuine "not found" (→ safe to reset) from a transient/unknown error (→ inconclusive).
const NOT_FOUND_PATTERNS = /not found|no (?:se )?(?:encontr|existe)|does not exist|404/i

function lookupFromInvoice(inv: StampedInvoice | ProviderInvoiceSummary): PacLookup {
  if (inv.status === 'canceled') return { kind: 'CANCELED' }
  if (inv.status !== 'valid' || !inv.uuid) return { kind: 'PENDING' }
  return {
    kind: 'VALID',
    invoice: { providerInvoiceId: inv.providerInvoiceId, uuid: inv.uuid, serie: inv.serie, folio: inv.folio, stampedAt: inv.stampedAt },
  }
}

async function lookupById(provider: { getInvoice: (id: string) => Promise<StampedInvoice> }, facturapiId: string): Promise<PacLookup> {
  try {
    const inv = await provider.getInvoice(facturapiId)
    return lookupFromInvoice(inv)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (NOT_FOUND_PATTERNS.test(message)) {
      // The id we hold isn't a real PAC document → no stamp exists for it.
      return { kind: 'NONE' }
    }
    // Transient/unknown — bubble up so the caller marks INCONCLUSIVE (never reset on doubt).
    throw err
  }
}

async function lookupByReference(
  provider: {
    searchInvoices: (p: { since: Date; until: Date; q?: string }) => Promise<{ invoices: ProviderInvoiceSummary[]; truncated: boolean }>
  },
  cfdi: StuckCfdi,
  now: Date,
): Promise<PacLookup> {
  const since = new Date(cfdi.createdAt.getTime() - SEARCH_WINDOW_MS)
  const until = new Date(Math.max(cfdi.createdAt.getTime(), now.getTime()) + SEARCH_WINDOW_MS)
  const { invoices, truncated } = await provider.searchInvoices({ since, until, q: cfdi.receptorRfc })

  const candidates = invoices.filter(inv => matchesRow(inv, cfdi))
  const valid = candidates.find(inv => inv.status === 'valid' && inv.uuid)
  if (valid) {
    return {
      kind: 'VALID',
      invoice: {
        providerInvoiceId: valid.providerInvoiceId,
        uuid: valid.uuid,
        serie: valid.serie,
        folio: valid.folio,
        stampedAt: valid.stampedAt,
      },
    }
  }
  if (candidates.some(inv => inv.status === 'canceled')) return { kind: 'CANCELED' }
  if (candidates.length > 0) return { kind: 'PENDING' }
  // No match found, but the PAC truncated the page → cannot conclude "none". Stay safe.
  if (truncated) return { kind: 'AMBIGUOUS' }
  return { kind: 'NONE' }
}

/**
 * Strict match between a PAC invoice summary and a stuck row: exact total (cents), same global
 * flag, and same receptor. The unique idempotencyKey guarantees there is at most one of these per
 * order/period, so an exact total + RFC + global-flag match is unambiguous.
 */
function matchesRow(inv: ProviderInvoiceSummary, cfdi: StuckCfdi): boolean {
  if (inv.totalCents !== cfdi.totalCents) return false
  if (inv.isGlobal !== cfdi.isGlobal) return false
  if (inv.customerTaxId && cfdi.receptorRfc && inv.customerTaxId.toUpperCase() !== cfdi.receptorRfc.toUpperCase()) {
    return false
  }
  return true
}

// ─── Completion (download + persist STAMPED) ──────────────────────────────────

async function completeFromPac(
  deps: ReconcileCfdiDeps,
  cfdi: StuckCfdi,
  emisor: ReconcileEmisor,
  provider: { downloadXml: (id: string) => Promise<Buffer>; downloadPdf: (id: string) => Promise<Buffer> },
  invoice: { providerInvoiceId: string; uuid: string | null; serie: string | null; folio: string | null; stampedAt: Date | null },
  now: Date,
): Promise<any> {
  const result = await deps.completeCfdi({
    cfdiId: cfdi.id,
    idempotencyKey: cfdi.idempotencyKey,
    version: cfdi.attempts,
    identidad: {
      status: 'valid',
      facturapiId: invoice.providerInvoiceId,
      uuid: invoice.uuid,
      serie: invoice.serie,
      folio: invoice.folio,
      stampedAt: invoice.stampedAt ?? now,
    },
  })
  if (result === 'DUPLICADO') return result
  try {
    const venueSlug = await deps.loadVenueSlug(emisor.venueId)
    await completarArchivos(
      {
        cfdiId: cfdi.id,
        idempotencyKey: cfdi.idempotencyKey,
        version: cfdi.attempts,
        providerInvoiceId: invoice.providerInvoiceId,
        uuid: invoice.uuid!,
        venueSlug,
        provider,
      },
      { storeArtifact: deps.storeArtifact },
    )
  } catch (err) {
    logger.error(`[cfdiReconcile] timbre recuperado; archivos pendientes cfdi=${cfdi.id}`, err)
  }
  return result
}

// ─── Real default deps ────────────────────────────────────────────────────────

const defaultDeps: ReconcileCfdiDeps = {
  loadEmisor: (emisorId: string) =>
    prisma.fiscalEmisor.findUnique({
      where: { id: emisorId },
      select: { id: true, venueId: true, provider: true, providerKeyEnc: true },
    }) as Promise<ReconcileEmisor | null>,

  loadVenueSlug: async (venueId: string): Promise<string> => {
    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { slug: true } })
    if (!venue) throw new Error(`Venue ${venueId} not found`)
    return venue.slug
  },

  resolveProvider: resolveFiscalProvider,

  storeArtifact: (buffer: Buffer, path: string, contentType: string) => uploadFileToStorage(buffer, path, contentType),

  completeCfdi: finalizarTimbre,
  failCfdi: async (cfdiId, version, lastError) =>
    (
      await prisma.cfdi.updateMany({
        where: { id: cfdiId, attempts: version, status: 'STAMPING' },
        data: { status: 'STAMP_FAILED', lastError, falloDefinitivo: false },
      })
    ).count === 1,
  escalate: escalarIntentoIncierto,

  findByExternalId: (provider: FiscalProvider, externalId: string) => provider.findByExternalId(externalId),
}
