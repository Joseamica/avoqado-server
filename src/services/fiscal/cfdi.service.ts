// src/services/fiscal/cfdi.service.ts
import { CsdStatus, FiscalProviderType, PaymentMethod, VenueType, CfdiStatus, CfdiFlow, Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { venueStartOfDay, venueEndOfDay, DEFAULT_TIMEZONE } from '../../utils/datetime'
import { buildStoragePath, uploadFileToStorage } from '../storage.service'
import { resolveFiscalProvider } from './fiscalProvider.factory'
import { buildCreateInvoiceParams } from './cfdiPayloadBuilder'
import { validateBeforeStamp } from './cfdiValidation'
import { assembleSaleInput, LoadedOrderForCfdi } from './assembleSaleInput'
import { splitIvaIncluded } from './ivaMath'

// ─── List CFDIs ───────────────────────────────────────────────────────────────

export interface ListCfdisParams {
  venueId: string
  status?: CfdiStatus
  flow?: CfdiFlow
  isGlobal?: boolean
  receptorRfc?: string
  from?: string // ISO date string, venue-local day start (e.g. "2026-06-01")
  to?: string // ISO date string, venue-local day end
  page: number
  pageSize: number
  /** Venue IANA timezone — used to convert from/to to real UTC for Prisma queries */
  venueTimezone?: string
}

export interface ListCfdisResult {
  cfdis: any[]
  total: number
  page: number
  pageSize: number
}

/** Subset of Cfdi fields returned on the list endpoint (no sensitive internals). */
const CFDI_LIST_SELECT = {
  id: true,
  type: true,
  status: true,
  flow: true,
  isGlobal: true,
  orderId: true,
  receptorRfc: true,
  receptorNombre: true,
  serie: true,
  folio: true,
  uuid: true,
  subtotalCents: true,
  taxCents: true,
  totalCents: true,
  stampedAt: true,
  createdAt: true,
  cancelStatus: true,
  xmlUrl: true,
  pdfUrl: true,
  globalPeriod: true,
} as const

/**
 * Returns a paginated list of CFDIs for the given venue.
 *
 * Tenant isolation: `venueId` is ALWAYS applied to the `where` clause — it is
 * never optional and is never derived from the request (controller passes
 * authContext.venueId). This prevents cross-venue data leaks.
 *
 * Date range: `from`/`to` are ISO date strings interpreted as venue-local day
 * boundaries (midnight → 23:59:59.999) and converted to real UTC via
 * `venueStartOfDay`/`venueEndOfDay` before being passed to Prisma.
 */
export async function listCfdisForVenue(params: ListCfdisParams): Promise<ListCfdisResult> {
  const { venueId, status, flow, isGlobal, receptorRfc, from, to, page, pageSize } = params
  const timezone = params.venueTimezone ?? DEFAULT_TIMEZONE

  // Build the where clause — venueId is always the first clause (tenant isolation)
  const where: Prisma.CfdiWhereInput = { venueId }

  if (status !== undefined) {
    where.status = status
  }
  if (flow !== undefined) {
    where.flow = flow
  }
  if (isGlobal !== undefined) {
    where.isGlobal = isGlobal
  }
  if (receptorRfc) {
    // Case-insensitive substring search (mode: 'insensitive' maps to ILIKE in PostgreSQL)
    where.receptorRfc = { contains: receptorRfc, mode: 'insensitive' }
  }

  // Date range: convert venue-local day boundaries → real UTC (critical-warnings rule)
  if (from || to) {
    where.createdAt = {}
    if (from) {
      const parsedFrom = new Date(`${from}T00:00:00`)
      where.createdAt.gte = venueStartOfDay(timezone, parsedFrom)
    }
    if (to) {
      const parsedTo = new Date(`${to}T00:00:00`)
      where.createdAt.lte = venueEndOfDay(timezone, parsedTo)
    }
  }

  const skip = (page - 1) * pageSize
  const take = pageSize

  const [cfdis, total] = await Promise.all([
    prisma.cfdi.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      select: CFDI_LIST_SELECT,
    }),
    prisma.cfdi.count({ where }),
  ])

  return { cfdis, total, page, pageSize }
}

export interface IssueReceptor {
  rfc: string
  razonSocial: string
  regimenFiscal: string
  codigoPostal: string
  usoCfdi: string
  email?: string
}

export interface LoadedOrderBundle {
  venueId: string
  venueSlug: string
  venueType: VenueType
  emisor: { id: string; provider: FiscalProviderType; providerKeyEnc: string | null; csdStatus: CsdStatus; serie: string | null }
  facturacionEnabled: boolean
  autofacturaEnabled: boolean
  paymentMethod: PaymentMethod
  metodoPago: 'PUE' | 'PPD'
  subtotalCents: number
  taxCents: number
  totalCents: number
  order: LoadedOrderForCfdi
}

export interface IssueCfdiDeps {
  findExistingCfdi: (idempotencyKey: string) => Promise<any | null>
  loadOrderForCfdi: (orderId: string) => Promise<LoadedOrderBundle | null>
  resolveProvider: typeof resolveFiscalProvider
  storeArtifact: (buffer: Buffer, path: string, contentType: string) => Promise<string>
  persistCfdi: (data: Record<string, any>) => Promise<any>
  /**
   * Reserves the idempotency slot BEFORE calling the PAC — prevents concurrent double-stamp.
   * Must INSERT a row with status:'STAMPING'. On unique-key conflict the caller handles P2002.
   */
  reserveCfdi: (data: Record<string, any>) => Promise<any>
}

export interface IssueCfdiResult {
  status: 'STAMPED' | 'VALIDATION_FAILED' | 'STAMP_FAILED'
  cfdi: any
  reasons?: string[]
}

// A reservation older than this is treated as stale (crashed/deployed mid-stamp) and may be reclaimed,
// so a stuck STAMPING row never permanently locks an order's invoicing.
const STAMPING_TTL_MS = 3 * 60_000

export async function issueCfdiForOrder(
  params: { orderId: string; receptor: IssueReceptor; sandbox: boolean; flow?: 'STAFF_B' | 'AUTOFACTURA_A'; expectedVenueId?: string },
  deps: IssueCfdiDeps = defaultDeps,
): Promise<IssueCfdiResult> {
  const idempotencyKey = `cfdi-order-${params.orderId}`

  // 1. Idempotency — never double-stamp (facturapi has no idempotency; we own it)
  const existing = await deps.findExistingCfdi(idempotencyKey)
  if (existing && existing.status === 'STAMPED') return { status: 'STAMPED', cfdi: existing }

  // 2. Load
  const bundle = await deps.loadOrderForCfdi(params.orderId)
  if (!bundle) throw new Error(`Order ${params.orderId} not found or has no fiscal emisor configured`)
  // Tenant isolation (critical-warnings rule): the order MUST belong to the caller's venue.
  if (params.expectedVenueId && bundle.venueId !== params.expectedVenueId) {
    throw new Error(`Order ${params.orderId} not found`) // → 404, no cross-venue leak
  }

  // Merchant gating: issuance requires facturacionEnabled on the payment merchant.
  if (!bundle.facturacionEnabled) throw new Error('Facturación no habilitada para este comercio')
  // Flow-A gating: autofactura requires autofacturaEnabled in addition.
  if (params.flow === 'AUTOFACTURA_A' && !bundle.autofacturaEnabled) throw new Error('Autofactura no habilitada para este comercio')

  // 3. Assemble + build (pure — no PAC calls, safe to run before reservation)
  const saleInput = assembleSaleInput(bundle.order, {
    receptor: params.receptor,
    paymentMethod: bundle.paymentMethod,
    metodoPago: bundle.metodoPago,
    serie: bundle.emisor.serie ?? undefined,
    idempotencyKey,
  })
  const invoiceParams = buildCreateInvoiceParams(saleInput)
  // Stamp our idempotencyKey as the PAC external_id so the reconcile job can look up
  // the document deterministically (GET /v2/invoices?external_id=...) instead of relying
  // solely on attribute matching (RFC + total + global flag + date window).
  invoiceParams.externalId = idempotencyKey

  // 3b. Reserve the idempotency slot BEFORE calling the PAC.
  //     This INSERT prevents a second concurrent request from reaching facturapi
  //     and producing two real fiscal documents (double-stamp / double-charge).
  //     The unique constraint on idempotencyKey is the gate.
  try {
    await deps.reserveCfdi(baseCfdiData(params, bundle, idempotencyKey, invoiceParams, 'STAMPING', {}))
  } catch (err: unknown) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Slot already taken — inspect the current status to decide the response.
      const existing = await deps.findExistingCfdi(idempotencyKey)
      if (existing?.status === 'STAMPED') {
        // Another request already succeeded — idempotent success.
        return { status: 'STAMPED', cfdi: existing }
      }
      if (existing?.status === 'STAMPING') {
        // Another request is in-flight. But a process crash / rolling deploy mid-stamp could
        // leave a STAMPING row stuck forever, permanently locking this order's invoicing.
        // Bound the lock: only block if the reservation is FRESH; reclaim a stale one.
        const ageMs = Date.now() - new Date(existing.updatedAt ?? existing.createdAt).getTime()
        if (ageMs < STAMPING_TTL_MS) {
          throw new Error('CFDI en proceso para esta orden') // → 409 in controllers
        }
        // Stale reservation — reclaim and retry. (Residual rare risk: the original may have
        // stamped at the PAC just before crashing; the getInvoice reconcile job is the proper guard.)
        logger.warn(`[cfdi] reclaiming stale STAMPING reservation for order ${params.orderId} (age ${Math.round(ageMs / 1000)}s)`)
      }
      // Terminal failure (VALIDATION_FAILED / STAMP_FAILED) — proceed to retry;
      // the existing row will be overwritten by the persistCfdi upsert below.
    } else {
      throw err
    }
  }

  // 4. Validate (D1) — never send garbage to the PAC
  const validation = validateBeforeStamp({
    csdStatus: bundle.emisor.csdStatus,
    formaPago: invoiceParams.formaPago,
    receptor: { ...params.receptor },
    items: invoiceParams.items,
    expectedSubtotalCents: bundle.subtotalCents,
    expectedTaxCents: bundle.taxCents,
    expectedTotalCents: bundle.totalCents,
    isGlobal: false, // individual issuance — XAXX010101000 ("Público en General") is blocked here
  })
  if (!validation.valid) {
    const cfdi = await deps.persistCfdi(
      baseCfdiData(params, bundle, idempotencyKey, invoiceParams, 'VALIDATION_FAILED', { lastError: validation.reasons.join(' | ') }),
    )
    return { status: 'VALIDATION_FAILED', cfdi, reasons: validation.reasons }
  }

  // 5. Stamp via the connector
  const provider = deps.resolveProvider(bundle.emisor as any, { sandbox: params.sandbox })
  let stamped
  try {
    stamped = await provider.createInvoice(invoiceParams)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`[cfdi] stamp failed for order ${params.orderId}: ${message}`)
    const cfdi = await deps.persistCfdi(baseCfdiData(params, bundle, idempotencyKey, invoiceParams, 'STAMP_FAILED', { lastError: message }))
    return { status: 'STAMP_FAILED', cfdi }
  }

  // 6. Store XML + PDF
  const [xmlBuf, pdfBuf] = await Promise.all([
    provider.downloadXml(stamped.providerInvoiceId),
    provider.downloadPdf(stamped.providerInvoiceId),
  ])
  const base = `venues/${bundle.venueSlug}/cfdi/${stamped.uuid}`
  const [xmlUrl, pdfUrl] = await Promise.all([
    deps.storeArtifact(xmlBuf, buildStoragePath(`${base}.xml`), 'application/xml'),
    deps.storeArtifact(pdfBuf, buildStoragePath(`${base}.pdf`), 'application/pdf'),
  ])

  // 7. Persist STAMPED
  const cfdi = await deps.persistCfdi(
    baseCfdiData(params, bundle, idempotencyKey, invoiceParams, 'STAMPED', {
      facturapiId: stamped.providerInvoiceId,
      uuid: stamped.uuid,
      serie: stamped.serie,
      folio: stamped.folio,
      stampedAt: stamped.stampedAt,
      xmlUrl,
      pdfUrl,
    }),
  )
  return { status: 'STAMPED', cfdi }
}

function baseCfdiData(
  params: { orderId: string; receptor: IssueReceptor; flow?: string },
  bundle: LoadedOrderBundle,
  idempotencyKey: string,
  invoiceParams: ReturnType<typeof buildCreateInvoiceParams>,
  status: string,
  extra: Record<string, any>,
) {
  return {
    venueId: bundle.venueId,
    fiscalEmisorId: bundle.emisor.id,
    orderId: params.orderId,
    flow: params.flow ?? 'STAFF_B',
    status,
    idempotencyKey,
    receptorRfc: params.receptor.rfc,
    receptorNombre: params.receptor.razonSocial,
    receptorRegimen: params.receptor.regimenFiscal,
    receptorCp: params.receptor.codigoPostal,
    usoCfdi: params.receptor.usoCfdi,
    formaPago: invoiceParams.formaPago,
    metodoPago: invoiceParams.metodoPago,
    subtotalCents: bundle.subtotalCents,
    taxCents: bundle.taxCents,
    totalCents: bundle.totalCents,
    ...extra,
  }
}

// ─── real default deps (DB + storage). Tests inject their own. ───
const defaultDeps: IssueCfdiDeps = {
  findExistingCfdi: idempotencyKey => prisma.cfdi.findUnique({ where: { idempotencyKey } }),
  storeArtifact: (buffer, path, contentType) => uploadFileToStorage(buffer, path, contentType),
  resolveProvider: resolveFiscalProvider,
  // Reserves the idempotency slot (INSERT only — raises P2002 on conflict).
  reserveCfdi: data => prisma.cfdi.create({ data: data as any }),
  persistCfdi: data =>
    prisma.cfdi.upsert({
      where: { idempotencyKey: data.idempotencyKey },
      create: data as any,
      update: { status: data.status, lastError: data.lastError ?? null, attempts: { increment: 1 }, ...stampedFields(data) },
    }),
  loadOrderForCfdi: loadOrderForCfdiFromDb,
}

/**
 * DB-backed order loader for CFDI issuance — extracted from defaultDeps so the tenant guard
 * (emisor.venueId MUST equal order.venueId) and merchant-resolution edge cases are unit-testable.
 */
export async function loadOrderForCfdiFromDb(orderId: string): Promise<LoadedOrderBundle | null> {
  // Tenant-safe load: order + items + product(+category) + venue.
  // Emisor is now resolved via the most-recent payment's merchant → MerchantFiscalConfig → fiscalEmisor.
  // Schema-verified field names:
  //   Order → venue (slug, type), payments (method, merchantAccountId, ecommerceMerchantId),
  //           items, subtotal, taxAmount, total, tipAmount
  //   OrderItem → productName, quantity, unitPrice, discountAmount, product → { satProductKey, satUnitKey, objetoImp, taxRate, category }
  //   MenuCategory → defaultSatProductKey, defaultSatUnitKey
  //   Payment → method  (NOT paymentMethod — schema field is "method")
  //   MerchantFiscalConfig → facturacionEnabled, autofacturaEnabled, fiscalEmisor (unique on merchantAccountId XOR ecommerceMerchantId)
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      venueId: true,
      subtotal: true,
      taxAmount: true,
      total: true,
      tipAmount: true,
      venue: {
        select: {
          slug: true,
          type: true,
        },
      },
      payments: {
        // Only a SETTLED payment identifies the merchant that actually collected the revenue.
        // Without this, a later REFUND (different/no merchant) could resolve the wrong emisor.
        where: { status: 'COMPLETED' },
        take: 1,
        orderBy: { createdAt: 'desc' },
        select: { method: true, merchantAccountId: true, ecommerceMerchantId: true },
      },
      items: {
        select: {
          productName: true,
          quantity: true,
          unitPrice: true,
          discountAmount: true,
          product: {
            select: {
              satProductKey: true,
              satUnitKey: true,
              objetoImp: true,
              taxRate: true,
              category: {
                select: { defaultSatProductKey: true, defaultSatUnitKey: true },
              },
            },
          },
        },
      },
    },
  })
  if (!order) return null

  const pay = order.payments[0]
  // No payment or no merchant on the payment → cannot resolve an emisor
  if (!pay || (!pay.merchantAccountId && !pay.ecommerceMerchantId)) return null

  // Resolve MerchantFiscalConfig via the unique merchantAccountId XOR ecommerceMerchantId
  const cfg = await prisma.merchantFiscalConfig.findUnique({
    where: pay.merchantAccountId ? { merchantAccountId: pay.merchantAccountId } : { ecommerceMerchantId: pay.ecommerceMerchantId! },
    select: {
      facturacionEnabled: true,
      autofacturaEnabled: true,
      fiscalEmisor: { select: { id: true, venueId: true, provider: true, providerKeyEnc: true, csdStatus: true, serie: true } },
    },
  })
  // No merchant config or emisor not set up → cannot invoice
  if (!cfg || !cfg.fiscalEmisor) return null

  // Tenant isolation: a MerchantAccount can be shared across venues in the same org (via VenuePaymentConfig
  // primary/secondary/tertiary slots). The emisor it maps to MUST belong to THIS order's venue — otherwise
  // venue B could stamp a CFDI under venue A's RFC. FiscalEmisor is venue-scoped (@@unique([venueId, rfc])).
  if (cfg.fiscalEmisor.venueId !== order.venueId) {
    logger.warn(
      `[cfdi] emisor/venue mismatch for order ${orderId}: order.venueId=${order.venueId}, emisor.venueId=${cfg.fiscalEmisor.venueId} — refusing to stamp`,
    )
    return null
  }

  const peso = (d: any) => Math.round(Number(d) * 100)

  // Mexican POS prices are IVA-included (gross): the customer's out-of-pocket already contains the
  // tax, and these orders carry taxAmount=0 (e.g. TPV). A non-zero taxAmount means a separated-tax
  // source (reservations, pos-sync) whose subtotal/taxAmount/total are already the real split.
  const pricesIncludeIva = peso(order.taxAmount) === 0

  let subtotalCents: number
  let taxCents: number
  let totalCents: number
  if (pricesIncludeIva) {
    // Derive base + IVA per concepto from the gross line so the row cuadra al centavo AND the total
    // stays equal to what the customer paid (tax_included stamping preserves the gross at the PAC).
    subtotalCents = 0
    taxCents = 0
    totalCents = 0
    for (const it of order.items) {
      const rate = it.product ? Number(it.product.taxRate) : 0.16
      const grossLine = peso(it.unitPrice) * it.quantity - peso(it.discountAmount)
      const split = splitIvaIncluded(grossLine, rate)
      subtotalCents += split.netCents
      taxCents += split.taxCents
      totalCents += grossLine
    }
  } else {
    subtotalCents = peso(order.subtotal)
    taxCents = peso(order.taxAmount)
    totalCents = peso(order.total)
  }

  return {
    venueId: order.venueId,
    venueSlug: order.venue.slug,
    venueType: order.venue.type,
    emisor: cfg.fiscalEmisor,
    facturacionEnabled: cfg.facturacionEnabled,
    autofacturaEnabled: cfg.autofacturaEnabled,
    paymentMethod: pay.method,
    metodoPago: 'PUE', // POS = PUE (PPD/REP deferred)
    subtotalCents,
    taxCents,
    totalCents,
    order: { venueType: order.venue.type, tipAmount: order.tipAmount, items: order.items as any, pricesIncludeIva },
  }
}

function stampedFields(data: Record<string, any>) {
  const keys = ['facturapiId', 'uuid', 'serie', 'folio', 'stampedAt', 'xmlUrl', 'pdfUrl'] as const
  const out: Record<string, any> = {}
  for (const k of keys) if (data[k] !== undefined) out[k] = data[k]
  return out
}

// ─── Cancel ───────────────────────────────────────────────────────────────────

export interface CancelCfdiDeps {
  loadCfdi: (cfdiId: string) => Promise<any | null>
  resolveProvider: typeof resolveFiscalProvider
  updateCfdi: (cfdiId: string, data: Record<string, any>) => Promise<any>
}

export interface CancelCfdiResult {
  cancelStatus: 'REQUESTED' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED'
  cancelledAt: Date | null
  cfdi: any
}

export async function cancelCfdi(
  params: {
    cfdiId: string
    motivo: '01' | '02' | '03' | '04'
    substituteUuid?: string
    sandbox: boolean
    expectedVenueId?: string
  },
  deps: CancelCfdiDeps = defaultCancelDeps,
): Promise<CancelCfdiResult> {
  // 1. Load + tenant isolation
  const cfdi = await deps.loadCfdi(params.cfdiId)
  if (!cfdi) throw new Error(`CFDI ${params.cfdiId} not found`)
  if (params.expectedVenueId && cfdi.venueId !== params.expectedVenueId) {
    throw new Error(`CFDI ${params.cfdiId} not found`) // tenant isolation → 404
  }

  // 2. Business-rule guards (spec §12: shape-only in Zod; rules stay in service)
  if (cfdi.status !== 'STAMPED') {
    throw new Error('Solo se puede cancelar un CFDI timbrado (STAMPED)')
  }
  if (params.motivo === '01' && !params.substituteUuid) {
    throw new Error('El motivo 01 requiere el UUID de sustitución')
  }

  // 3. Call the PAC via the provider interface
  const provider = deps.resolveProvider(cfdi.fiscalEmisor, { sandbox: params.sandbox })
  const result = await provider.cancelInvoice({
    providerInvoiceId: cfdi.facturapiId,
    motivo: params.motivo,
    substituteUuid: params.substituteUuid,
  })

  // 4. Map provider status → CfdiCancelStatus enum
  const cancelStatus = mapProviderCancelStatus(result.status)

  // 5. Persist — update cancel fields + flip cfdi.status when definitively resolved
  const updated = await deps.updateCfdi(cfdi.id, {
    cancelMotivo: params.motivo,
    cancelSubstituteUuid: params.substituteUuid ?? null,
    cancelStatus,
    cancelRequestedAt: new Date(),
    cancelledAt: result.cancelledAt,
    // Only flip the CFDI status to CANCELLED when the PAC confirms it is done
    status: cancelStatus === 'CANCELLED' || cancelStatus === 'ACCEPTED' ? 'CANCELLED' : cfdi.status,
  })

  return { cancelStatus, cancelledAt: result.cancelledAt, cfdi: updated }
}

function mapProviderCancelStatus(s: string): 'REQUESTED' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED' {
  switch (s) {
    case 'canceled':
      return 'CANCELLED'
    case 'accepted':
      return 'ACCEPTED'
    case 'rejected':
      return 'REJECTED'
    default:
      // 'pending' / 'verifying' / unknown → still awaiting SAT resolution
      return 'REQUESTED'
  }
}

// Real defaults — mirror defaultDeps pattern
const defaultCancelDeps: CancelCfdiDeps = {
  loadCfdi: id => prisma.cfdi.findUnique({ where: { id }, include: { fiscalEmisor: true } }),
  resolveProvider: resolveFiscalProvider,
  updateCfdi: (id, data) => prisma.cfdi.update({ where: { id }, data }),
}

// ─── Status ───────────────────────────────────────────────────────────────────

export interface GetCfdiStatusDeps {
  loadCfdi: (cfdiId: string) => Promise<any | null>
}

export async function getCfdiStatus(
  params: { cfdiId: string; expectedVenueId?: string },
  deps: GetCfdiStatusDeps = defaultStatusDeps,
): Promise<any> {
  const cfdi = await deps.loadCfdi(params.cfdiId)
  if (!cfdi) throw new Error(`CFDI ${params.cfdiId} not found`)
  if (params.expectedVenueId && cfdi.venueId !== params.expectedVenueId) {
    throw new Error(`CFDI ${params.cfdiId} not found`) // tenant isolation → 404
  }
  return cfdi
}

// Real defaults
const defaultStatusDeps: GetCfdiStatusDeps = {
  loadCfdi: id => prisma.cfdi.findUnique({ where: { id } }),
}
