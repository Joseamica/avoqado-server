// src/services/fiscal/cfdiGlobal.service.ts
//
// Flow C: issues a factura global to "Público en General" (RFC XAXX010101000) covering
// all paid orders in the closed period under a given emisor that have NOT been individually
// stamped (Flow A/B). One global CFDI per (emisor, period, periodicity) — idempotent.
//
// Architecture mirrors cfdi.service.ts: DI-based, real defaultDeps use prisma/storage, tests inject mocks.
//
// Money: integer cents end-to-end (cuadra al centavo via reconcileGlobalLines).

import { CsdStatus, Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { buildStoragePath, uploadFileToStorage } from '../storage.service'
import { resolveFiscalProvider } from './fiscalProvider.factory'
import {
  buildGlobalInvoiceParams,
  GlobalInvoiceLine,
  GlobalLineItemInput,
  groupOrderIntoGlobalLines,
  reconcileGlobalLines,
} from './cfdiPayloadBuilder'
import { splitIvaIncluded } from './ivaMath'
import {
  esCobroElegible,
  importeConceptoCents,
  motivosDeOrden,
  reconstruirConceptos,
  totalDelDocumentoCents,
  OrdenParaConceptos,
} from './cfdi.service'
import { closedPeriodFor, ClosedPeriod } from './globalPeriod'
import { validateBeforeStamp } from './cfdiValidation'
import { mapFormaPago } from './satCatalog'
import { StampedInvoice } from './providers/fiscal-provider.interface'

// ─── Result types ─────────────────────────────────────────────────────────────

export type IssueGlobalStatus = 'STAMPED' | 'NOTHING_TO_INVOICE' | 'SKIPPED' | 'VALIDATION_FAILED' | 'STAMP_FAILED'

export interface IssueGlobalResult {
  status: IssueGlobalStatus
  cfdi?: any
  reasons?: string[]
  reason?: string
  period?: ClosedPeriod
  candidateCount?: number
}

// ─── DI interfaces ────────────────────────────────────────────────────────────

export interface GlobalEmisor {
  id: string
  venueId: string
  globalPeriodicity: any // GlobalPeriodicity enum
  serie: string | null
  lugarExpedicion: string
  csdStatus: CsdStatus
  providerKeyEnc: string | null
  provider: any // FiscalProviderType
  /** OPT-IN: only sweep CASH-paid orders into the global when the venue explicitly allows it. */
  invoiceCashSales: boolean
}

export interface IssueGlobalDeps {
  loadEmisor: (emisorId: string) => Promise<GlobalEmisor | null>
  findExistingGlobal: (idempotencyKey: string) => Promise<any | null>
  loadGlobalCandidates: (
    emisorId: string,
    periodStart: Date,
    periodEnd: Date,
    invoiceCashSales: boolean,
    venueId: string,
  ) => Promise<GlobalInvoiceLine[]>
  resolveProvider: typeof resolveFiscalProvider
  storeArtifact: (buffer: Buffer, path: string, contentType: string) => Promise<string>
  persistCfdi: (data: Record<string, any>) => Promise<any>
  loadVenueSlug: (venueId: string) => Promise<string>
  /**
   * Reserves the idempotency slot BEFORE calling the PAC — prevents concurrent double-stamp
   * of the same global period. Must INSERT a row with status:'STAMPING'. On unique-key
   * conflict the caller handles P2002.
   */
  reserveCfdi: (data: Record<string, any>) => Promise<any>
}

// ─── Core function ────────────────────────────────────────────────────────────

/**
 * Issues (or idempotently skips) a factura global for one emisor.
 *
 * @param params.emisorId  - FiscalEmisor.id
 * @param params.now       - Reference date (inject for testability — don't call Date.now() here)
 * @param params.sandbox   - Use sandbox/test PAC key (true in dev/staging)
 * @param deps             - DI deps; real defaultDeps used in production
 */
// A reservation older than this is treated as stale (crashed/deployed mid-stamp) and may be reclaimed.
const GLOBAL_STAMPING_TTL_MS = 3 * 60_000

export async function issueGlobalForEmisor(
  params: { emisorId: string; now: Date; sandbox: boolean },
  deps: IssueGlobalDeps = defaultDeps,
): Promise<IssueGlobalResult> {
  const { emisorId, now, sandbox } = params

  // 1. Resolve emisor
  const emisor = await deps.loadEmisor(emisorId)
  if (!emisor) throw new Error(`FiscalEmisor ${emisorId} not found`)

  // 2. CSD guard — skip silently (will be retried when CSD becomes ACTIVE)
  if (emisor.csdStatus !== 'ACTIVE') {
    logger.info(`[cfdiGlobal] emisor ${emisorId} skipped — CSD status: ${emisor.csdStatus}`)
    return { status: 'SKIPPED', reason: 'CSD inactivo' }
  }

  // 3. Determine the closed period
  const period = closedPeriodFor(emisor.globalPeriodicity, now)

  // 4. Idempotency check — key encodes emisor + year + meses + periodicity so it is unique per (emisor, period)
  const idempotencyKey = `cfdi-global-${emisorId}-${period.anio}-${period.meses}-${period.satPeriodicidad}`
  const existing = await deps.findExistingGlobal(idempotencyKey)
  if (existing && existing.status === 'STAMPED') {
    logger.info(`[cfdiGlobal] already stamped for emisor=${emisorId} period=${period.meses}/${period.anio}`)
    return { status: 'STAMPED', cfdi: existing, period, candidateCount: 0 }
  }

  // 5. Load candidates (PAID orders, not individually stamped, under this emisor in the period).
  //    Cash-paid orders are swept ONLY if the emisor opted in (invoiceCashSales) — most venues don't
  //    declare cash, so by default a cash (or cash+card mixed) order is left out of the global.
  const candidates = await deps.loadGlobalCandidates(
    emisorId,
    period.periodStart,
    period.periodEnd,
    emisor.invoiceCashSales,
    emisor.venueId,
  )
  logger.info(
    `[cfdiGlobal] emisor=${emisorId} period=${period.meses}/${period.anio} candidates=${candidates.length} periodStart=${period.periodStart.toISOString()} periodEnd=${period.periodEnd.toISOString()}`,
  )

  // 6. Zero candidates — do NOT stamp an empty global CFDI
  if (candidates.length === 0) {
    return { status: 'NOTHING_TO_INVOICE', period, candidateCount: 0 }
  }

  // 7. Build payload
  const params_ = buildGlobalInvoiceParams(emisor, candidates, period)
  // Stamp our idempotencyKey as the PAC external_id — mirrors cfdi.service.ts.
  // Enables the reconcile job to look up the document deterministically instead of
  // relying solely on attribute matching (RFC + total + global flag + date window).
  params_.externalId = idempotencyKey

  // 8. Reconcile money: ensures each line's subtotal+tax=total and returns aggregated totals
  const { subtotalCents, taxCents, totalCents } = reconcileGlobalLines(candidates)

  // 9. Pre-stamp validation (isGlobal:true allows XAXX010101000)
  const validation = validateBeforeStamp({
    csdStatus: emisor.csdStatus,
    formaPago: params_.payment_form,
    receptor: {
      rfc: 'XAXX010101000',
      razonSocial: 'PÚBLICO EN GENERAL',
      regimenFiscal: '616',
      codigoPostal: emisor.lugarExpedicion,
      usoCfdi: 'S01',
    },
    items: params_.items,
    expectedSubtotalCents: subtotalCents,
    expectedTaxCents: taxCents,
    expectedTotalCents: totalCents,
    isGlobal: true,
  })

  if (!validation.valid) {
    logger.warn(`[cfdiGlobal] validation failed for emisor=${emisorId}: ${validation.reasons.join(' | ')}`)
    const cfdi = await deps.persistCfdi(
      baseGlobalCfdiData(emisor, idempotencyKey, period, params_.payment_form, subtotalCents, taxCents, totalCents, 'VALIDATION_FAILED', {
        lastError: validation.reasons.join(' | '),
      }),
    )
    return { status: 'VALIDATION_FAILED', cfdi, reasons: validation.reasons, period, candidateCount: candidates.length }
  }

  // 9b. Reserve the idempotency slot BEFORE calling the PAC.
  //     Same pattern as cfdi.service.ts — prevents concurrent double-stamp of the same period.
  try {
    await deps.reserveCfdi(
      baseGlobalCfdiData(emisor, idempotencyKey, period, params_.payment_form, subtotalCents, taxCents, totalCents, 'STAMPING', {}),
    )
  } catch (err: unknown) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existing = await deps.findExistingGlobal(idempotencyKey)
      if (existing?.status === 'STAMPED') {
        logger.info(`[cfdiGlobal] already stamped (concurrent) for emisor=${emisorId} period=${period.meses}/${period.anio}`)
        return { status: 'STAMPED', cfdi: existing, period, candidateCount: 0 }
      }
      if (existing?.status === 'STAMPING') {
        // Bound the lock: a crash/deploy mid-stamp must not permanently block the period.
        const ageMs = Date.now() - new Date(existing.updatedAt ?? existing.createdAt).getTime()
        if (ageMs < GLOBAL_STAMPING_TTL_MS) {
          throw new Error('Global en proceso para este emisor y periodo')
        }
        logger.warn(
          `[cfdiGlobal] reclaiming stale STAMPING reservation for emisor=${emisorId} period=${period.meses}/${period.anio} (age ${Math.round(ageMs / 1000)}s)`,
        )
      }
      // Terminal failure — proceed to retry; persistCfdi upsert will update the row.
    } else {
      throw err
    }
  }

  // 10. Stamp via the PAC connector
  const provider = deps.resolveProvider(emisor, { sandbox })
  let stamped: StampedInvoice
  try {
    stamped = await provider.createGlobalInvoice(params_)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`[cfdiGlobal] stamp failed for emisor=${emisorId}: ${message}`)
    const cfdi = await deps.persistCfdi(
      baseGlobalCfdiData(emisor, idempotencyKey, period, params_.payment_form, subtotalCents, taxCents, totalCents, 'STAMP_FAILED', {
        lastError: message,
      }),
    )
    return { status: 'STAMP_FAILED', cfdi, period, candidateCount: candidates.length }
  }

  // 11. Store XML + PDF
  const venueSlug = await deps.loadVenueSlug(emisor.venueId)
  const base = `venues/${venueSlug}/cfdi/${stamped.uuid}`
  const [xmlBuf, pdfBuf] = await Promise.all([
    provider.downloadXml(stamped.providerInvoiceId),
    provider.downloadPdf(stamped.providerInvoiceId),
  ])
  const [xmlUrl, pdfUrl] = await Promise.all([
    deps.storeArtifact(xmlBuf, buildStoragePath(`${base}.xml`), 'application/xml'),
    deps.storeArtifact(pdfBuf, buildStoragePath(`${base}.pdf`), 'application/pdf'),
  ])

  // 12. Persist STAMPED
  const cfdi = await deps.persistCfdi(
    baseGlobalCfdiData(emisor, idempotencyKey, period, params_.payment_form, subtotalCents, taxCents, totalCents, 'STAMPED', {
      facturapiId: stamped.providerInvoiceId,
      uuid: stamped.uuid,
      serie: stamped.serie,
      folio: stamped.folio,
      stampedAt: stamped.stampedAt,
      xmlUrl,
      pdfUrl,
    }),
  )

  logger.info(
    `[cfdiGlobal] STAMPED emisor=${emisorId} uuid=${stamped.uuid} period=${period.meses}/${period.anio} orders=${candidates.length}`,
  )
  return { status: 'STAMPED', cfdi, period, candidateCount: candidates.length }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function baseGlobalCfdiData(
  emisor: GlobalEmisor,
  idempotencyKey: string,
  period: ClosedPeriod,
  formaPago: string,
  subtotalCents: number,
  taxCents: number,
  totalCents: number,
  status: string,
  extra: Record<string, any>,
): Record<string, any> {
  return {
    venueId: emisor.venueId,
    fiscalEmisorId: emisor.id,
    orderId: null, // global — no single order
    flow: 'GLOBAL_C',
    status,
    idempotencyKey,
    isGlobal: true,
    globalPeriod: { periodicidad: period.satPeriodicidad, meses: period.meses, anio: period.anio },
    type: 'INGRESO',
    receptorRfc: 'XAXX010101000',
    receptorNombre: 'PÚBLICO EN GENERAL',
    receptorRegimen: '616',
    receptorCp: emisor.lugarExpedicion,
    usoCfdi: 'S01',
    formaPago,
    metodoPago: 'PUE',
    subtotalCents,
    taxCents,
    totalCents,
    attempts: extra.lastError !== undefined ? 1 : 0,
    ...extra,
  }
}

function stampedGlobalFields(data: Record<string, any>): Record<string, any> {
  const keys = ['facturapiId', 'uuid', 'serie', 'folio', 'stampedAt', 'xmlUrl', 'pdfUrl'] as const
  const out: Record<string, any> = {}
  for (const k of keys) if (data[k] !== undefined) out[k] = data[k]
  return out
}

// ─── Real default deps ────────────────────────────────────────────────────────

const defaultDeps: IssueGlobalDeps = {
  loadEmisor: (emisorId: string) =>
    prisma.fiscalEmisor.findUnique({
      where: { id: emisorId },
      select: {
        id: true,
        venueId: true,
        globalPeriodicity: true,
        serie: true,
        lugarExpedicion: true,
        csdStatus: true,
        providerKeyEnc: true,
        provider: true,
        invoiceCashSales: true,
      },
    }) as Promise<GlobalEmisor | null>,

  findExistingGlobal: (idempotencyKey: string) => prisma.cfdi.findUnique({ where: { idempotencyKey } }),

  reserveCfdi: (data: Record<string, any>) => prisma.cfdi.create({ data: data as any }),

  loadGlobalCandidates: async (
    emisorId: string,
    periodStart: Date,
    periodEnd: Date,
    invoiceCashSales: boolean,
    venueId: string,
  ): Promise<GlobalInvoiceLine[]> => {
    // Candidates = PAID orders settled (payment COMPLETED) via a merchant under this emisor
    // with includeInGlobal && facturacionEnabled, and NO STAMPED individual Cfdi.
    //
    // Approach: fetch all qualifying orders in the period, then exclude any that have a
    // STAMPED Cfdi (orderId = that order's id). This is a two-step query for clarity.
    const orders = await prisma.order.findMany({
      where: {
        // 🔴 Sólo órdenes de ESTE venue: una cuenta de cobro compartida entre sucursales no puede meter
        // ventas de otra sucursal bajo este RFC.
        venueId,
        paymentStatus: 'PAID',
        updatedAt: { gte: periodStart, lt: periodEnd },
        payments: {
          // La MISMA elegibilidad que la suma: un pago TEST/REFUND no puede decidir bajo qué RFC entra
          // una orden (Codex, pasada 4).
          some: {
            status: 'COMPLETED',
            AND: [{ OR: [{ type: { in: ['REGULAR', 'FAST'] } }, { type: null }] }],
            OR: [
              {
                merchantAccount: {
                  fiscalConfig: {
                    fiscalEmisorId: emisorId,
                    includeInGlobal: true,
                    facturacionEnabled: true,
                  },
                },
              },
              {
                ecommerceMerchant: {
                  fiscalConfig: {
                    fiscalEmisorId: emisorId,
                    includeInGlobal: true,
                    facturacionEnabled: true,
                  },
                },
              },
            ],
          },
          // Cash NOT declared by default: unless the emisor opted in, drop any order that has a
          // COMPLETED cash payment. This also drops mixed cash+card orders (whose total would
          // otherwise declare the cash portion) — conservative, matches "don't invoice cash".
        },
        AND: filtrosDeExclusion(emisorId, invoiceCashSales),
        // Exclude orders that already have a STAMPED individual Cfdi
        cfdis: {
          none: { status: 'STAMPED', isGlobal: false },
        },
      },
      select: {
        id: true,
        orderNumber: true,
        subtotal: true,
        taxAmount: true,
        total: true,
        discountAmount: true,
        serviceChargeAmount: true,
        promotions: { select: { id: true }, take: 1 },
        payments: {
          // Todos los cobros ELEGIBLES (misma regla que la factura individual): su suma es lo cobrado,
          // la verdad contra la que se valida cada orden antes de entrar a la global.
          where: { status: 'COMPLETED', OR: [{ type: { in: ['REGULAR', 'FAST'] } }, { type: null }] },
          orderBy: { createdAt: 'desc' },
          // `tenderSatFormaPago`: la forma SAT que el NEGOCIO declaró en su tipo de pago.
          // Sin ella, un ticket cobrado con un tipo del catálogo (method = OTHER) entra a
          // la global como '99' (por definir) y arrastra a TODA la factura al genérico
          // cuando se mezcla con otras formas.
          select: { method: true, tenderSatFormaPago: true, amount: true, type: true },
        },
        // Items carry each product's real tax treatment (rate + objetoImp) so the global lines
        // declare the actual IVA per product instead of assuming 16% for the whole ticket.
        items: {
          select: {
            productName: true,
            quantity: true,
            unitPrice: true,
            discountAmount: true,
            taxAmount: true,
            total: true,
            weightQuantity: true,
            modifiers: { select: { name: true, price: true, quantity: true } },
            product: { select: { taxRate: true, objetoImp: true, satProductKey: true, satUnitKey: true } },
          },
        },
      },
    })

    return orders.flatMap(o => globalLinesFromOrder(o))
  },
  resolveProvider: resolveFiscalProvider,

  storeArtifact: (buffer: Buffer, path: string, contentType: string) => uploadFileToStorage(buffer, path, contentType),

  persistCfdi: (data: Record<string, any>) =>
    prisma.cfdi.upsert({
      where: { idempotencyKey: data.idempotencyKey },
      create: data as any,
      update: {
        status: data.status,
        lastError: data.lastError ?? null,
        attempts: { increment: 1 },
        ...stampedGlobalFields(data),
      },
    }),

  loadVenueSlug: async (venueId: string): Promise<string> => {
    const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { slug: true } })
    if (!venue) throw new Error(`Venue ${venueId} not found`)
    return venue.slug
  },
}

/** Cobros elegibles para decidir/sumar en la global: la MISMA regla que la factura individual. */
const COBRO_ELEGIBLE: Prisma.PaymentWhereInput = { OR: [{ type: { in: ['REGULAR', 'FAST'] } }, { type: null }] }

/**
 * Exclusiones de la consulta de candidatos: ningún cobro elegible bajo OTRO emisor (una cuenta cobrada
 * con comercios de RFC distinto no entra completa en la global de ninguno — Codex, pasada 5), y sin
 * efectivo salvo que el emisor haya optado por declararlo.
 */
function filtrosDeExclusion(emisorId: string, invoiceCashSales: boolean): Prisma.OrderWhereInput[] {
  // Un comercio «incompatible» = sin configuración, de otro emisor, con facturación apagada o fuera de la
  // global. Basta UN cobro elegible así para que la orden no entre completa bajo este emisor.
  const configIncompatible: Prisma.MerchantFiscalConfigWhereInput = {
    OR: [{ fiscalEmisorId: { not: emisorId } }, { facturacionEnabled: false }, { includeInGlobal: false }],
  }
  const filtros: Prisma.OrderWhereInput[] = [
    {
      payments: {
        none: {
          status: 'COMPLETED',
          AND: [COBRO_ELEGIBLE],
          OR: [
            {
              merchantAccountId: { not: null },
              merchantAccount: { OR: [{ fiscalConfig: { is: null } }, { fiscalConfig: configIncompatible }] },
            },
            {
              ecommerceMerchantId: { not: null },
              ecommerceMerchant: { OR: [{ fiscalConfig: { is: null } }, { fiscalConfig: configIncompatible }] },
            },
          ],
        },
      },
    },
  ]
  if (!invoiceCashSales) filtros.push({ payments: { none: { status: 'COMPLETED', method: 'CASH', AND: [COBRO_ELEGIBLE] } } })
  return filtros
}

/** Fila de orden tal como la carga `loadGlobalCandidates` (PURA para poder probarla sin Prisma). */
export interface GlobalCandidateOrder {
  id: string
  orderNumber: string | null
  subtotal: any
  taxAmount: any
  total: any
  discountAmount?: any
  serviceChargeAmount?: any
  promotions?: Array<{ id: string }> | null
  payments: Array<{ method: any; tenderSatFormaPago: string | null; amount?: any; type?: string | null }>
  items: Array<{
    productName?: string | null
    quantity: number
    unitPrice: any
    discountAmount: any
    taxAmount: any
    total?: any
    weightQuantity?: any
    modifiers?: Array<{ name?: string | null; price: any; quantity?: number }> | null
    product: { taxRate: any; objetoImp: string | null } | null
  }>
}

/**
 * One order → one or more global lines, grouped by each product's REAL tax rate (16/8/0/exento).
 * taxAmount=0 ⇒ gross (IVA-included) prices, e.g. TPV. Non-zero taxAmount ⇒ separated-tax source.
 *
 * 🔴 MISMA verdad de dinero que la factura individual (`conceptosDesdeRenglon`, descuento de orden,
 * cobros elegibles): con `unitPrice × quantity` la global declaraba MENOS de lo cobrado en cualquier
 * ticket con extras (Testarudo, 21-sep-2026). Y la misma BARRERA: si el documento de una orden no
 * cuadra con lo cobrado, la orden se EXCLUYE de la global (con aviso) — nunca se declara mal.
 */
export function globalLinesFromOrder(o: GlobalCandidateOrder): GlobalInvoiceLine[] {
  const peso = (d: any): number => Math.round(Number(d) * 100)
  const pays = o.payments.filter(p => esCobroElegible(p))
  const paidCents = pays.reduce((sum, p) => sum + peso(p.amount ?? 0), 0)
  if (paidCents <= 0) {
    logger.warn(`[cfdiGlobal] orden ${o.id} sin cobros elegibles; excluida de la global`)
    return []
  }
  const sinRenglones = o.items.length === 0
  const priceIncludesIva = peso(o.taxAmount) === 0 || sinRenglones
  const method = pays[0]?.method
  const formaPago = method ? mapFormaPago(method, pays[0]?.tenderSatFormaPago) : '99'
  const meta = { orderId: o.id, orderNumber: o.orderNumber, formaPago, priceIncludesIva }

  // Preferred path: derive per-product tax groups from the items.
  if (!sinRenglones) {
    const { items: conceptos, motivos } = reconstruirConceptos(o as OrdenParaConceptos, o.id)
    if (motivos.length > 0) {
      logger.warn(`[cfdiGlobal] orden ${o.id} fuera del sobre seguro; excluida de la global: ${motivos.join(' | ')}`)
      return []
    }
    const documentoCents = totalDelDocumentoCents({ items: conceptos as any, pricesIncludeIva: priceIncludesIva })
    if (documentoCents !== paidCents) {
      logger.warn(
        `[cfdiGlobal] orden ${o.id}: el documento (${documentoCents}) no coincide con lo cobrado (${paidCents}); excluida de la global`,
      )
      return []
    }
    const lineItems: GlobalLineItemInput[] = conceptos.map(it => {
      const rate = it.product ? Number(it.product.taxRate) : 0.16
      const objetoImp = it.product?.objetoImp ?? (rate > 0 ? '02' : '01')
      const lineNet = importeConceptoCents(it) - peso(it.discountAmount)
      // Gross items already include IVA; net items add their separated tax to reach the paid gross.
      const grossCents = priceIncludesIva ? lineNet : Math.round(lineNet * (1 + rate))
      return { grossCents, taxRate: rate, objetoImp }
    })
    return groupOrderIntoGlobalLines(lineItems, meta)
  }

  // Fallback (order with no items): one line for what was PAID (never `order.total`, which may carry
  // the tip), IVA included, assuming 16%. Las exclusiones de ORDEN aplican igual sin renglones.
  const motivosOrden = motivosDeOrden(o as OrdenParaConceptos)
  if (motivosOrden.length > 0) {
    logger.warn(`[cfdiGlobal] orden ${o.id} sin renglones fuera del sobre seguro; excluida: ${motivosOrden.join(' | ')}`)
    return []
  }
  const totalCents = paidCents
  const { netCents, taxCents } = splitIvaIncluded(totalCents, 0.16)
  return [
    {
      ...meta,
      totalCents,
      subtotalCents: netCents,
      taxCents,
      taxRate: 0.16,
      objetoImp: '02',
    },
  ]
}
