// src/services/fiscal/cfdiReconcile.service.ts
//
// Reconciles a single Cfdi row stuck in `STAMPING` against the PAC (facturapi).
//
// Why this exists (residual risk closed):
//   issueCfdiForOrder / issueGlobalForEmisor reserve a `STAMPING` row BEFORE calling the PAC
//   to prevent concurrent double-stamping, and reclaim that row once it is older than a 3-min
//   TTL. The one gap that the TTL-reclaim cannot cover safely: a process crash / rolling deploy
//   that lands AFTER facturapi already stamped but BEFORE we persisted the result. Reclaiming
//   such a row would re-stamp at the PAC → TWO real fiscal documents (double-stamp / double-charge).
//
//   This service is the proper guard: before any reclaim happens, the reconcile job asks the PAC
//   whether a document actually exists for the stuck row, and either
//     - COMPLETES the row (downloads XML/PDF, marks STAMPED) if a stamp is found, or
//     - RESETS the row to STAMP_FAILED (retryable terminal state) if the PAC definitively has none.
//   When the PAC is unreachable or the answer is ambiguous, it is left STAMPING for the next tick
//   (INCONCLUSIVE) — we never reset on doubt, because a wrong reset is what causes a double-stamp.
//
// Architecture mirrors cfdi.service.ts / cfdiGlobal.service.ts: DI-based, real defaultDeps use
// prisma + storage, tests inject mocks. Money is integer cents end-to-end.

import { CfdiStatus } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { buildStoragePath, uploadFileToStorage } from '../storage.service'
import { resolveFiscalProvider } from './fiscalProvider.factory'
import { ProviderInvoiceSummary, StampedInvoice } from './providers/fiscal-provider.interface'

// ─── Result types ─────────────────────────────────────────────────────────────

export type ReconcileOutcome =
  | 'COMPLETED' // a real stamp existed at the PAC → row marked STAMPED with downloaded artifacts
  | 'RESET' // the PAC definitively has no stamp → row reset to STAMP_FAILED (retryable)
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
  /** Provider invoice id — null on a STAMPING reservation (set only at the final STAMPED persist). */
  facturapiId: string | null
  receptorRfc: string
  totalCents: number
  createdAt: Date
  updatedAt: Date
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
  /** Marks the row STAMPED, persisting the recovered identifiers + artifact URLs. */
  completeCfdi: (cfdiId: string, data: Record<string, any>) => Promise<any>
  /** Resets the row to STAMP_FAILED with a clear lastError so the next issuance retries cleanly. */
  failCfdi: (cfdiId: string, lastError: string) => Promise<any>
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
  deps: ReconcileCfdiDeps = defaultDeps,
): Promise<ReconcileResult> {
  const { cfdi, now, sandbox } = params

  // Defensive: only STAMPING rows are reconcilable. A row that moved on between the entry read
  // and now (e.g. the original process finished) must be left alone.
  if (cfdi.status !== 'STAMPING') {
    return { outcome: 'SKIPPED', cfdiId: cfdi.id, detail: `status is ${cfdi.status}, not STAMPING` }
  }

  // Resolve the connector for this row's emisor.
  const emisor = await deps.loadEmisor(cfdi.fiscalEmisorId)
  if (!emisor) {
    logger.warn(`[cfdiReconcile] emisor ${cfdi.fiscalEmisorId} not found for stuck cfdi=${cfdi.id} — cannot reconcile`)
    return { outcome: 'SKIPPED', cfdiId: cfdi.id, detail: 'emisor not found' }
  }
  const provider = deps.resolveProvider(emisor as any, { sandbox })

  // ── Find whether a document exists at the PAC ───────────────────────────────
  // Two paths, exactly as the residual-risk guard requires:
  //   (a) facturapiId present → getInvoice(id) (defensive — STAMPING reservations normally carry none)
  //   (b) facturapiId null    → search by reference to detect an orphaned stamp
  let lookup: PacLookup
  try {
    lookup = cfdi.facturapiId ? await lookupById(provider, cfdi.facturapiId) : await lookupByReference(provider, cfdi, now)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // PAC unreachable / unexpected error → do NOT touch the row. Retry next tick.
    logger.error(`[cfdiReconcile] PAC lookup failed for cfdi=${cfdi.id}: ${message}`)
    return { outcome: 'INCONCLUSIVE', cfdiId: cfdi.id, detail: `pac lookup error: ${message}` }
  }

  // ── Decide ──────────────────────────────────────────────────────────────────
  if (lookup.kind === 'VALID') {
    // A real, valid stamp exists → complete the row instead of leaving it stuck.
    const completed = await completeFromPac(deps, cfdi, emisor, provider, lookup.invoice, now)
    logger.info(`[cfdiReconcile] COMPLETED cfdi=${cfdi.id} uuid=${completed.uuid ?? '?'} (recovered orphaned stamp)`)
    return { outcome: 'COMPLETED', cfdiId: cfdi.id, detail: `uuid=${completed.uuid ?? '?'}` }
  }

  if (lookup.kind === 'CANCELED' || lookup.kind === 'AMBIGUOUS') {
    // A document exists but is canceled, OR results were truncated / ambiguous. Either way a stamp
    // may have happened — resetting would risk a double-stamp. Leave STAMPING for manual review.
    logger.warn(`[cfdiReconcile] INCONCLUSIVE cfdi=${cfdi.id} (${lookup.kind}) — a PAC document may exist; left STAMPING for manual review`)
    return { outcome: 'INCONCLUSIVE', cfdiId: cfdi.id, detail: lookup.kind.toLowerCase() }
  }

  // lookup.kind === 'NONE' — the PAC definitively has no document → safe to reset and retry.
  const lastError = `Reconcile (${now.toISOString()}): no document found at PAC for stuck STAMPING row — reset to retry`
  await deps.failCfdi(cfdi.id, lastError)
  logger.info(`[cfdiReconcile] RESET cfdi=${cfdi.id} → STAMP_FAILED (no stamp at PAC, safe to retry)`)
  return { outcome: 'RESET', cfdiId: cfdi.id, detail: 'no document at PAC' }
}

// ─── PAC lookup ─────────────────────────────────────────────────────────────

type PacLookup =
  | {
      kind: 'VALID'
      invoice: { providerInvoiceId: string; uuid: string | null; serie: string | null; folio: string | null; stampedAt: Date | null }
    }
  | { kind: 'CANCELED' }
  | { kind: 'AMBIGUOUS' } // truncated search results — cannot conclude "no stamp"
  | { kind: 'NONE' } // PAC definitively has no document

// Phrases facturapi returns in its error `message` when an invoice id does not exist. Used to
// distinguish a genuine "not found" (→ safe to reset) from a transient/unknown error (→ inconclusive).
const NOT_FOUND_PATTERNS = /not found|no (?:se )?(?:encontr|existe)|does not exist|404/i

async function lookupById(provider: { getInvoice: (id: string) => Promise<StampedInvoice> }, facturapiId: string): Promise<PacLookup> {
  try {
    const inv = await provider.getInvoice(facturapiId)
    if (inv.status === 'canceled') return { kind: 'CANCELED' }
    return {
      kind: 'VALID',
      invoice: {
        providerInvoiceId: inv.providerInvoiceId,
        uuid: inv.uuid ?? null,
        serie: inv.serie,
        folio: inv.folio,
        stampedAt: inv.stampedAt ?? null,
      },
    }
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
  const valid = candidates.find(inv => inv.status === 'valid')
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
  // A canceled-but-matching document means a stamp DID happen → never reset (would double-stamp).
  if (candidates.length > 0) return { kind: 'CANCELED' }
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
  const venueSlug = await deps.loadVenueSlug(emisor.venueId)
  // Mirror cfdiGlobal.service step 11: store under venues/<slug>/cfdi/<uuid>. Fall back to the
  // provider id if uuid is somehow absent so artifacts never collide / overwrite.
  const base = `venues/${venueSlug}/cfdi/${invoice.uuid ?? invoice.providerInvoiceId}`
  const [xmlBuf, pdfBuf] = await Promise.all([
    provider.downloadXml(invoice.providerInvoiceId),
    provider.downloadPdf(invoice.providerInvoiceId),
  ])
  const [xmlUrl, pdfUrl] = await Promise.all([
    deps.storeArtifact(xmlBuf, buildStoragePath(`${base}.xml`), 'application/xml'),
    deps.storeArtifact(pdfBuf, buildStoragePath(`${base}.pdf`), 'application/pdf'),
  ])

  return deps.completeCfdi(cfdi.id, {
    status: 'STAMPED',
    facturapiId: invoice.providerInvoiceId,
    uuid: invoice.uuid,
    serie: invoice.serie,
    folio: invoice.folio,
    stampedAt: invoice.stampedAt ?? now,
    xmlUrl,
    pdfUrl,
    lastError: null,
  })
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

  completeCfdi: (cfdiId: string, data: Record<string, any>) => prisma.cfdi.update({ where: { id: cfdiId }, data: data as any }),

  failCfdi: (cfdiId: string, lastError: string) =>
    prisma.cfdi.update({
      where: { id: cfdiId },
      data: { status: 'STAMP_FAILED', lastError, attempts: { increment: 1 } },
    }),
}
